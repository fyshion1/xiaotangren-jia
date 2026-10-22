"""Durable turn events and wait notifications shared by presentation clients.

Raw content is kept in local SQLite, never in console logs or provider diagnostics.
Generation completion is distinct from persistence and external delivery receipts.
"""
import asyncio
import json
import logging
import time
from contextlib import asynccontextmanager

from .. import db

log = logging.getLogger(__name__)
WAIT_INTERVAL = 30


def record(session, request_id, source, stage, payload=None, sent_count=0):
    with db._tx() as conn:
        conn.execute('''CREATE TABLE IF NOT EXISTS conversation_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            persona_id TEXT NOT NULL, session_id TEXT NOT NULL, request_id TEXT NOT NULL,
            source TEXT NOT NULL, stage TEXT NOT NULL, sent_count INTEGER NOT NULL,
            payload TEXT NOT NULL)''')
        conn.execute('INSERT INTO conversation_events(persona_id,session_id,request_id,source,stage,sent_count,payload) VALUES(?,?,?,?,?,?,?)',
            (session.get('persona_id', ''), session['session_id'], request_id, source, stage,
             sent_count, json.dumps(payload or {}, ensure_ascii=False)))


class Progress:
    def __init__(self, session, request_id, source, emit):
        self.session, self.request_id, self.source, self.emit = session, request_id, source, emit
        self.started = time.monotonic()
        self.stage = 'queue'
        self.sent_count = 0

    def event(self, stage, payload=None):
        self.stage = stage
        record(self.session, self.request_id, self.source, stage, payload, self.sent_count)

    async def heartbeat(self):
        while True:
            await asyncio.sleep(WAIT_INTERVAL)
            elapsed = int(time.monotonic() - self.started)
            text = (f'仍在等待回复，已等待 {elapsed} 秒；未自动重试生成。' if elapsed >= 60 else f'正在等待处理，已等待 {elapsed} 秒。')
            data = {'elapsed_seconds': elapsed, 'stage': self.stage, 'sent_count': self.sent_count, 'text': text}
            record(self.session, self.request_id, self.source, 'waiting', data, self.sent_count)
            log.info('Conversation waiting request=%s source=%s stage=%s elapsed=%ss sent=%s',
                     self.request_id, self.source, self.stage, elapsed, self.sent_count)
            if self.emit:
                await self.emit({'type': 'status', **data})


@asynccontextmanager
async def monitor(session, request_id, source, emit=None):
    state = Progress(session, request_id, source, emit)
    task = asyncio.create_task(state.heartbeat())
    try:
        yield state
    except asyncio.CancelledError:
        state.event('cancelled', {'failed_stage': state.stage, 'message': '等待已中断；不自动重新生成'})
        raise
    except Exception as exc:
        state.event('failed', {'failed_stage': state.stage, 'error_type': type(exc).__name__})
        raise
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

async def transient_stream(messages, model, base_url, api_key='', *, max_tokens=None, source='legacy_chat'):
    """Legacy stateless transports share progress/log/diagnostics and one attempt.

    These APIs carry no durable session identity, so do not populate a persistent
    image cache under a guessed user/session. Ordinary UI chats use session/web-stream.
    """
    import uuid
    from ..providers import openai
    from .upstream_diagnostics import upstream_accessibility, _upstream_reason
    rid = uuid.uuid4().hex
    session = {'persona_id': '', 'session_id': 'transient-' + rid}
    queue = asyncio.Queue(maxsize=128)
    options = {'model': model, 'base_url': base_url, 'api_key': api_key}
    async def produce():
        async with monitor(session, rid, source, queue.put) as progress:
            progress.event('received', {'messages': [{'role': m['role'], 'text': m['content'] if isinstance(m['content'], str) else '\n'.join(p.get('text', '') for p in m['content'] if p.get('type') == 'text')} for m in messages if m['role'] != 'system']})
            progress.event('generation')
            raw = []
            try:
                async for event in openai.stream_chat_retry(messages, model, base_url, api_key, max_tokens=max_tokens, attempts=1):
                    if event['type'] == 'text':
                        raw.append(event['text'])
                        await queue.put({'type': 'token', 'text': event['text']})
                    elif event['type'] == 'done':
                        progress.event('generated', {'raw': ''.join(raw), 'finish_reason': event.get('finish_reason')})
                        await queue.put(event)
                    elif event['type'] == 'error':
                        code = event.get('status')
                        raise RuntimeError(f'上游 {code}' if isinstance(code, int) else '模型暂时未能回复')
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                progress.event('failed', {'failed_stage': 'generation', 'raw': ''.join(raw), 'error_type': type(exc).__name__})
                check = await upstream_accessibility(options)
                await queue.put({'type': 'error', 'message': '阶段 generation，已确认发送 0 条；' + _upstream_reason(exc) + '；' + check + '；未自动重试，模型请求可能已计费。'})
    async def run():
        try:
            await produce()
        finally:
            # Initialization can fail before the provider try block. Always wake
            # the consumer, but never block cancellation on a full output queue.
            if not asyncio.current_task().cancelling():
                await queue.put(None)
    task = asyncio.create_task(run())
    try:
        while (event := await queue.get()) is not None:
            yield event
        await task
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
