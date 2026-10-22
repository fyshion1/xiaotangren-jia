"""Desktop-only bounded social queue and offline keyword spotting."""
from __future__ import annotations

import asyncio
import json
import time
import uuid
from datetime import datetime, timezone, timedelta
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

from .. import db
from ..providers import openai
from .session_chat import resolve_session, _append_message
from .nest import _effective_config

router = APIRouter(prefix='/pet/companion')
_lock = asyncio.Lock()
_wake_clients = 0


class SocialIn(BaseModel):
    character_id: str = Field(max_length=120)
    mode: str = 'single'
    session_id: str = Field(max_length=240)
    persona_id: str = Field(max_length=120)
    available_until: float = 0
    buffer_until: float = 0
    permitted: bool = False
    ack: str = Field(default='', max_length=80)


def initialize(c):
    c.execute('''CREATE TABLE IF NOT EXISTS pet_social_state (
        session_id TEXT PRIMARY KEY, last_attempt REAL NOT NULL DEFAULT 0,
        next_at REAL NOT NULL, waiting_user INTEGER NOT NULL DEFAULT 0,
        permit_until REAL NOT NULL DEFAULT 0, heartbeat REAL NOT NULL DEFAULT 0)''')
    c.execute('''CREATE TABLE IF NOT EXISTS pet_social_queue (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, speaker TEXT NOT NULL,
        day TEXT NOT NULL, created REAL NOT NULL, expires REAL NOT NULL,
        state TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', message_id TEXT NOT NULL DEFAULT '',
        usage TEXT NOT NULL DEFAULT '', user_seq INTEGER NOT NULL DEFAULT 0)''')


def validated(body):
    if body.persona_id != (db.get_active_persona_id() or 'dalaoda'):
        raise HTTPException(409, '用户身份已切换')
    session = resolve_session(body.character_id, body.mode, body.persona_id)
    if session['session_id'] != body.session_id:
        raise HTTPException(409, '会话已切换')
    return session


@router.post('/social')
async def social(body: SocialIn):
    session = validated(body)
    sid, now = session['session_id'], time.time()
    # A fresh client heartbeat can grant at most one hour; no unattended model polling.
    until = min(body.available_until / 1000, now + 3600) if body.permitted and body.buffer_until / 1000 <= now else 0
    with db._tx() as c:
        initialize(c)
        c.execute('INSERT OR IGNORE INTO pet_social_state(session_id,next_at) VALUES(?,?)', (sid, now + 90))
        c.execute('UPDATE pet_social_state SET permit_until=?,heartbeat=? WHERE session_id=?', (until, now, sid))
        c.execute("UPDATE pet_social_queue SET state='expired' WHERE session_id=? AND state='ready' AND expires<=?", (sid, now))
    if _lock.locked():
        return {'status': 'working'}
    async with _lock:
        with db._tx() as c:
            state = dict(c.execute('SELECT * FROM pet_social_state WHERE session_id=?', (sid,)).fetchone())
            last_user = c.execute("SELECT COALESCE(MAX(rowid),0) FROM messages WHERE session_id=? AND role='user'", (sid,)).fetchone()[0]
            if body.ack and until > now:
                row = c.execute("SELECT * FROM pet_social_queue WHERE id=? AND session_id=? AND state IN ('ready','delivered')", (body.ack, sid)).fetchone()
                if row and row['speaker'] in session['character_ids'] and row['expires'] > now and last_user == row['user_seq']:
                    if row['state'] == 'ready':
                        char_row = c.execute('SELECT data FROM characters WHERE id=?', (row['speaker'],)).fetchone()
                        char = json.loads(char_row['data']) if char_row else {}
                        message = _append_message(c, sid, 'assistant', row['text'], [{'speaker': char.get('name', row['speaker']), 'text': row['text']}])
                        from ..services.qq_web_sync import enqueue
                        enqueue(c, message['id'], sid)
                        c.execute("UPDATE pet_social_queue SET state='delivered',message_id=? WHERE id=?", (message['id'], row['id']))
                        c.execute('UPDATE pet_social_state SET waiting_user=?,next_at=? WHERE session_id=?', (max(1, last_user), now + 1200, sid))
                    return {'status': 'delivered'}
            if until <= now:
                return {'status': 'resting'}
            # Only the current roster may speak; expired/absent drafts never leak into another conversation.
            row = c.execute("SELECT * FROM pet_social_queue WHERE session_id=? AND state='ready' ORDER BY created LIMIT 1", (sid,)).fetchone()
            if row:
                if row['speaker'] in session['character_ids'] and last_user == row['user_seq']:
                    return {'status': 'ready', 'item': {'id': row['id'], 'text': row['text'], 'speaker': row['speaker']}}
                c.execute("UPDATE pet_social_queue SET state='expired' WHERE id=?", (row['id'],))
            if now < state['next_at']:
                return {'status': 'later'}
            day = datetime.now(timezone(timedelta(hours=8))).date().isoformat()
            # Reserve attempts before network IO; errors/unknown usage also spend a slot. No retries.
            count = c.execute('SELECT COUNT(*) FROM pet_social_queue WHERE day=?', (day,)).fetchone()[0]
            if count >= 16:
                return {'status': 'daily_limit'}
            candidates = []
            for cid in session['character_ids']:
                last = c.execute('SELECT COALESCE(MAX(created),0) FROM pet_social_queue WHERE speaker=?', (cid,)).fetchone()[0]
                if now - last >= 2400:
                    candidates.append((last, cid))
            if not candidates:
                return {'status': 'later'}
            speaker = min(candidates)[1]
            item_id = uuid.uuid4().hex
            c.execute('INSERT INTO pet_social_queue(id,session_id,speaker,day,created,expires,state,user_seq) VALUES(?,?,?,?,?,?,?,?)',
                      (item_id, sid, speaker, day, now, now + 7200, 'generating', last_user))
            c.execute('UPDATE pet_social_state SET last_attempt=?,next_at=? WHERE session_id=?', (now, now + 1200, sid))
        try:
            from ..services.prompt.assembler import _persona_block
            char = db.get_character(speaker) or {}
            history = [{'role': m['role'], 'content': str(m['content'])[:400]} for m in db.list_messages(sid, limit=4)]
            prompt = _persona_block(char)[:3500] + '\n你想主动来陪大老大聊一句。他欢迎你热情自然地靠近，不要习惯性说“不吵你”“算了算了”或“有事再喊我”；可以顺着最近话题多接一句、分享当下想法、轻轻吐槽或表达想念，不必每次都问问题。按你的人设写1到2句、最多100字。不要声称看到了屏幕、听到了环境声音、执行了工具或知道他在做什么。只输出实际台词，不加角色名。没有想说的只输出[等等]。'
            cfg = _effective_config('desktop_pet')
            result = await openai.complete_chat_full([{'role': 'system', 'content': prompt}, *history,
                {'role': 'user', 'content': '现在可以主动轻轻搭一句话。这是系统调度，不是用户刚发送的聊天。'}],
                cfg['model'], cfg['base_url'], cfg.get('api_key', ''), max_tokens=350, timeout=60)
            text = str(result.get('content') or '').strip()
            valid = bool(text) and text != '[等等]' and len(text) <= 400 and result.get('finish_reason') == 'stop'
            with db._tx() as c:
                c.execute('UPDATE pet_social_queue SET state=?,text=?,usage=? WHERE id=?',
                          ('ready' if valid else 'skipped', text if valid else '', json.dumps(result.get('usage') or {}), item_id))
            # Delivery is a separate fresh poll: revalidate identity, presence and roster then.
            return {'status': 'prepared' if valid else 'skipped'}
        except Exception:
            with db._tx() as c:
                c.execute("UPDATE pet_social_queue SET state='failed' WHERE id=?", (item_id,))
            raise HTTPException(502, '主动招呼暂时没想好，本轮已停下，不会自动重试') from None


@router.get('/wake/config')
def wake_config():
    from ..services.pet_wake import ready
    return {'ready': ready(), 'keywords': ['小糖人在吗', '小糖人小糖人'], 'local_only': True}


@router.websocket('/wake/ws')
async def wake_socket(ws: WebSocket):
    global _wake_clients
    origin = ws.headers.get('origin', '')
    if not origin or urlsplit(origin).netloc != ws.headers.get('host', '') or _wake_clients >= 2:
        await ws.close(code=1008)
        return
    await ws.accept()
    _wake_clients += 1
    try:
        from ..services.pet_wake import Spotter
        spotter = await asyncio.to_thread(Spotter)
        await ws.send_json({'type': 'ready'})
        while True:
            data = await asyncio.wait_for(ws.receive_bytes(), 30)
            if not data or len(data) % 2 or len(data) > 6400:
                await ws.close(code=1009)
                return
            keyword = await asyncio.to_thread(spotter.feed, data)
            if keyword:
                await ws.send_json({'type': 'wake', 'keyword': keyword})
    except WebSocketDisconnect:
        pass
    except Exception:
        try:
            await ws.send_json({'type': 'error', 'message': '本地唤醒不可用，请检查模型或麦克风连接'})
            await ws.close(code=1011)
        except Exception:
            pass
    finally:
        _wake_clients -= 1
