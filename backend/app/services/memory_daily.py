"""自动读取整天记录，清洗分批后提交 03 审核；用户修改永远优先。"""
from __future__ import annotations

import hashlib
import json
import threading
import asyncio
import logging
from datetime import date

from fastapi import HTTPException

from .. import db
from . import memory_sources as sources, memory_cleaning as cleaning, memory_workflow as work

_running: set[str] = set()
_queued: dict[str, dict] = {}
_tasks: set[asyncio.Task] = set()
_lock = threading.Lock()


def table() -> None:
    with db._tx() as conn:
        conn.execute('''CREATE TABLE IF NOT EXISTS memory_daily_runs (
            key TEXT PRIMARY KEY, persona_id TEXT NOT NULL, session_id TEXT NOT NULL,
            day TEXT NOT NULL, fingerprint TEXT NOT NULL, status TEXT NOT NULL, detail TEXT NOT NULL,
            updated_at TEXT NOT NULL)''')
        conn.execute('''CREATE TABLE IF NOT EXISTS memory_daily_seen (
            key TEXT NOT NULL, id TEXT NOT NULL, fingerprint TEXT NOT NULL,
            PRIMARY KEY(key,id))''')


def runs(persona: str) -> list[dict]:
    table()
    with db._tx() as conn:
        return [dict(r) for r in conn.execute('SELECT * FROM memory_daily_runs WHERE persona_id=? ORDER BY day DESC,updated_at DESC LIMIT 30', (persona,))]


async def process(*, messages: list[dict], character_ids: list[str], session_kind: str, name_of: dict,
                  base_url: str, api_key: str, model: str, force: bool, save: bool,
                  feature_id: str, persona_id: str, session_id: str, requested_day: str = "") -> dict:
    from . import memory_extract as extractor
    persona = persona_id or db.get_active_persona_id() or 'dalaoda'
    if requested_day:
        date.fromisoformat(requested_day)
    # 不接受用其他身份的 session 读取原文。
    expected = session_id.split('@', 1)[0] if '@' in session_id else 'dalaoda'
    if session_id and expected != persona:
        raise PermissionError('会话与当前身份不一致')
    rows = []
    if session_id:
        with db._tx() as conn:
            stored = conn.execute('SELECT rowid,* FROM messages WHERE session_id=? ORDER BY created_at,rowid', (session_id,)).fetchall()
        rows = [db._row_to_message(r) for r in stored]
    # 前端等落库后调用；直接调用/游戏的无持久会话也可整理传入记录。
    rows = rows or messages
    if not rows:
        return {'triggered': False, 'memories': [], 'saved': [], 'candidates': []}
    day = requested_day or max(sources.timestamp(m.get('created_at') or '')[:10] for m in rows)
    rows = [m for m in rows if sources.timestamp(m.get('created_at') or '')[:10] == day]
    if not rows:
        return {'triggered': False, 'status': 'empty', 'detail': '这一天没有聊天记录', 'memories': [], 'saved': [], 'candidates': []}
    names = {c['id']: c.get('name', c['id']) for c in db.list_characters()}
    names.update(name_of)
    profile = db.get_profile(persona) or {}
    cleaned = cleaning.clean(rows, names, profile.get('name') or persona)
    key = hashlib.sha256(json.dumps([persona, session_id, day, feature_id]).encode()).hexdigest()
    # Missing source timestamps are synthesized for display; they must not defeat retry deduplication.
    timestamped = {r.get('id', '') for r in rows if r.get('created_at')}
    stable = [{**m, 'created_at': m['created_at'] if m['id'] in timestamped else ''} for m in cleaned]
    fingerprint = hashlib.sha256(json.dumps([stable, model, base_url], ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    table()
    if save:
        with db._tx() as conn:
            previous = conn.execute('SELECT * FROM memory_daily_runs WHERE key=?', (key,)).fetchone()
        if previous and previous['fingerprint'] == fingerprint and previous['status'] in {'completed', 'blocked'} and not force:
            return {'triggered': False, 'status': previous['status'], 'detail': previous['detail'], 'memories': [], 'saved': [], 'candidates': []}
    with _lock:
        if key in _running:
            if save:
                _queued[key] = dict(messages=messages, character_ids=character_ids, session_kind=session_kind,
                                    name_of=name_of, base_url=base_url, api_key=api_key, model=model,
                                    force=force, save=save, feature_id=feature_id, persona_id=persona,
                                    session_id=session_id, requested_day=day)
            return {'triggered': False, 'status': 'processing', 'memories': [], 'saved': [], 'candidates': []}
        _running.add(key)

    def status(state: str, detail: str = '') -> None:
        if save:
            with db._tx() as conn:
                conn.execute('INSERT OR REPLACE INTO memory_daily_runs VALUES (?,?,?,?,?,?,?,?)',
                             (key, persona, session_id, day, fingerprint, state, detail, work.now()))

    proposed, facts, distilled = [], [], []
    try:
        source = work.archive_source(rows, persona, session_id, character_ids, feature_id) if save else ''
        if save:
            cleaning.export(cleaned, persona, session_id, day, feature_id)
        status('processing')
        if not base_url or not model:
            status('unconfigured', '原文已保存，配置整理模型后可重新整理当天记录')
            return {'triggered': False, 'status': 'unconfigured', 'memories': [], 'saved': [], 'candidates': []}
        with db._tx() as conn:
            seen = {r['id']: r['fingerprint'] for r in conn.execute('SELECT id,fingerprint FROM memory_daily_seen WHERE key=?', (key,))}
        def message_key(m: dict) -> str:
            return m['id'] or hashlib.sha256(json.dumps([m['role'], m['content'], m.get('image')], ensure_ascii=False).encode()).hexdigest()

        def message_fingerprint(m: dict) -> str:
            return hashlib.sha256(json.dumps([m['content'], m.get('image'), m.get('frames'), model, base_url], ensure_ascii=False).encode()).hexdigest()

        fresh = [m for m in cleaned if force or not save or seen.get(message_key(m)) != message_fingerprint(m)]
        for group in cleaning.chunks(fresh):
            context_items = [m for m in work.list_items(persona, work.WORK) + work.list_items(persona, work.LONG)
                             if m.get('session_id') == session_id and m.get('feature_id', '') == feature_id
                             and sources.timestamp(m.get('occurred_at', m['created_at']))[:10] == day]
            context = '\n'.join(f"主题={m.get('event_topic') or m['text']}；{m['text']}；{m.get('details', '')}"
                                for m in context_items if m['review_status'] in {'pending', 'approved'})[:4000]
            text = '当天已经整理的事件（只作衔接，勿重复，用户核对版不得推翻）：\n' + context + '\n\n本批新原文：\n'
            text += '\n'.join(f"消息编号={m['id']}\n{cleaning.formatted([m])}" for m in group)
            content: str | list = text
            parts = [{'type': 'text', 'text': text}]
            from .attachments import image_for_model
            for m in group:
                if m.get('role') != 'user':
                    continue
                images = m.get('frames') or ([m['image']] if m.get('image') else [])
                for url in images[:8]:
                    try:
                        parts.append({'type': 'text', 'text': f"以下为消息 {m['id']} 的真实附件"})
                        parts.append({'type': 'image_url', 'image_url': {'url': image_for_model(url)}})
                    except (ValueError, OSError, HTTPException):
                        parts.append({'type': 'text', 'text': '[原附件已不可用，不能推测其内容]'})
            if len(parts) > 1:
                content = parts
            try:
                raw = await extractor.openai.complete_chat(
                    [{'role': 'system', 'content': extractor._SYSTEM}, {'role': 'user', 'content': content}],
                    model=model, base_url=base_url, api_key=api_key, max_tokens=2400, temperature=0.2)
            except Exception as exc:
                blocked = any(word in str(exc).lower() for word in ('prohibited_content', 'content_filter', 'request blocked', 'safety'))
                if blocked:
                    detail = '整理模型拒绝处理这批内容；原始聊天及附件已保存在本地，未生成或批准记忆。可在模型设置更换适合的整理模型后重试。'
                    status('blocked', detail)
                    return {'triggered': True, 'status': 'blocked', 'detail': detail, 'memories': distilled,
                            'saved': [], 'candidates': proposed, 'fact_candidates': facts}
                raise
            if not extractor._strip_fences(raw):
                raise ValueError('整理模型未返回有效 JSON，原文已保存，请重试')
            decoded = json.loads(extractor._strip_fences(raw))
            if not isinstance(decoded, dict) or not isinstance(decoded.get('memories'), list):
                raise ValueError('整理结果缺少有效的 memories 数组，原文已保存')
            parsed = extractor.parse_memories(raw)
            distilled.extend(parsed)
            for item in parsed:
                if not save:
                    continue
                evidence = [m for m in group if m['id'] in item['source_ids']] or group
                if item['kind'] == 'fact':
                    facts.append(work.propose_fact(item['text'], persona, source, evidence)); continue
                with work._lock:
                    scope = 'personal' if session_kind == 'single' or item['private'] else 'shared'
                    who = extractor._resolve_who(item['who'], names)
                    ids = [who] if who else character_ids
                    event_key = hashlib.sha256(json.dumps([key, item['event_key'] or item['text'], scope, sorted(ids)], ensure_ascii=False).encode()).hexdigest()
                    existing = next((m for m in work.list_items(persona, work.WORK) + work.list_items(persona, work.LONG)
                                     if m.get('event_key') == event_key), None)
                    if existing:
                        # 用户编辑、拒绝、批准过的内容不再被后台覆盖。
                        if existing.get('user_edited') or existing['review_status'] != 'pending':
                            continue
                        path, existing = work.get(existing['id'])
                        meta = {k: v for k, v in existing.items() if k not in {'text', 'path', 'revision'}}
                        prior_evidence = existing.get('evidence', [])
                        evidence = list({json.dumps(m, sort_keys=True, ensure_ascii=False): m for m in prior_evidence + evidence}.values())
                        meta.update(details=item['details'], evidence=evidence, aliases=item['aliases'], updated_at=work.now())
                        from .activity_memory import item_sources
                        meta['source_feature_ids'] = sorted(set(meta.get('source_feature_ids', [])) | set(item_sources({**meta, 'source_feature_ids':None})))
                        work.write(path, meta, item['text'])
                        proposed.append(work._item(path))
                    else:
                        created = work.propose(item['text'], persona, ids, category=item['category'] or 'experience',
                                                     scope=scope, source=source, session_id=session_id, feature_id=feature_id,
                                                     evidence=evidence, details=item['details'], occurred_at=evidence[0]['created_at'],
                                                     event_key=event_key, aliases=item['aliases'], automatic=True)
                        path, created = work.get(created['id'])
                        meta = {k: v for k, v in created.items() if k not in {'text', 'path', 'revision'}}
                        meta['event_topic'] = item['event_key']
                        work.write(path, meta, created['text'])
                        proposed.append(work._item(path))
            if save:
                # 整批成功后才推进进度；被拒绝的批次可以显式重试。
                with db._tx() as conn:
                    for m in group:
                        conn.execute('INSERT OR REPLACE INTO memory_daily_seen VALUES (?,?,?)',
                                     (key, message_key(m), message_fingerprint(m)))
        if save:
            report = sources.relative(persona, session_id, day, feature_id).replace(work.SOURCE, work.WORK + '/每日整理', 1)
            events = [m for m in work.list_items(persona, work.LONG) if m.get('session_id') == session_id
                      and m.get('feature_id', '') == feature_id and sources.timestamp(m.get('occurred_at', m['created_at']))[:10] == day]
            work.write(work.root() / report, {'persona_id': persona, 'day': day, 'source': source, 'status': 'submitted'},
                       '\n\n'.join(m['text'] + '\n' + m.get('details', '') for m in events) or '当天暂无需要长期保留的事件。')
        status('completed')
        return {'triggered': True, 'status': 'completed', 'memories': distilled, 'saved': [], 'candidates': proposed, 'fact_candidates': facts}
    except Exception:
        status('failed', '整理未完成，原始聊天及附件已保存，可重试当天整理。')
        raise
    finally:
        with _lock:
            _running.discard(key)
            queued = _queued.pop(key, None)
        if queued:
            async def drain():
                try:
                    await process(**queued)
                except Exception:
                    logging.getLogger(__name__).exception('排队的每日记忆整理失败；原文已保存')
            task = asyncio.create_task(drain())
            _tasks.add(task)
            task.add_done_callback(_tasks.discard)
