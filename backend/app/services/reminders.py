"""Durable one-shot reminders. Models can draft; only UI confirmation schedules."""
from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timedelta, timezone


from .. import db

SHANGHAI = timezone(timedelta(hours=8))
log = logging.getLogger(__name__)
_task: asyncio.Task | None = None


def initialize():
    with db._tx() as conn:
        conn.executescript('''
            CREATE TABLE IF NOT EXISTS reminders (
                id TEXT PRIMARY KEY, persona_id TEXT NOT NULL, session_id TEXT NOT NULL,
                title TEXT NOT NULL, due_at REAL NOT NULL, status TEXT NOT NULL,
                created_at REAL NOT NULL, updated_at REAL NOT NULL,
                expires_at REAL NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
                UNIQUE(persona_id,id)
            );
            CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(status,due_at);
            CREATE INDEX IF NOT EXISTS idx_reminders_identity ON reminders(persona_id,title,due_at);
        ''')


def validate(title: str, due_at: str, now: float | None = None) -> tuple[str, float]:
    title = title.strip()
    if not title or len(title) > 200 or any(ord(c) < 32 for c in title):
        raise ValueError('提醒内容需为 1–200 个可见字符')
    try:
        due = datetime.fromisoformat(due_at)
        if due.utcoffset() != timedelta(hours=8):
            raise ValueError
        stamp = due.replace(microsecond=0).timestamp()
    except (ValueError, OverflowError):
        raise ValueError('请提供带 +08:00 的明确北京时间') from None
    now = time.time() if now is None else now
    if not now + 5 <= stamp <= now + 366 * 86400:
        raise ValueError('提醒时间需在 5 秒后至未来一年内')
    return title, stamp


def tick(now: float | None = None):
    initialize()
    now = time.time() if now is None else now
    with db._tx() as conn:
        conn.execute("UPDATE reminders SET status='expired',revision=revision+1,updated_at=? WHERE status='draft' AND expires_at<=?", (now, now))
        conn.execute("UPDATE reminders SET status='due',revision=revision+1,updated_at=? WHERE status='scheduled' AND due_at<=?", (now, now))


def list_items(persona_id: str, due_only=False) -> list[dict]:
    tick()
    with db._tx() as conn:
        clause = "AND status='due'" if due_only else ''
        rows = conn.execute(f'''SELECT * FROM reminders WHERE persona_id=? {clause}
            ORDER BY CASE status WHEN 'due' THEN 0 WHEN 'draft' THEN 1 WHEN 'scheduled' THEN 2 ELSE 3 END,
            due_at ASC LIMIT 100''', (persona_id,)).fetchall()
    return [dict(r) for r in rows]


class Conflict(ValueError):
    pass


def change(rid: str, persona_id: str, action: str, revision: int,
           title: str = '', due_at: str = '') -> dict:
    tick()
    now = time.time()
    with db._tx() as conn:
        conn.execute('BEGIN IMMEDIATE')
        found = conn.execute('SELECT * FROM reminders WHERE id=? AND persona_id=?', (rid, persona_id)).fetchone()
        if not found:
            raise KeyError(rid)
        row = dict(found)
        # Retried button requests settle to the same result, without rescheduling.
        target = {'confirm': 'scheduled', 'cancel': 'cancelled', 'dismiss': 'dismissed'}.get(action)
        settled = row['status'] == target or (action == 'confirm' and row['status'] in ('due', 'dismissed'))
        if settled and revision < row['revision']:
            return row
        if revision != row['revision']:
            raise Conflict('提醒已变化，请刷新后再操作')
        if action == 'confirm':
            if row['status'] != 'draft' or row['due_at'] < now + 5:
                raise Conflict('草稿已失效或时间已过，请重新设置')
            row['status'] = 'scheduled'
        elif action == 'cancel':
            if row['status'] not in ('draft', 'scheduled', 'due'):
                raise Conflict('这条提醒已结束')
            row['status'] = 'cancelled'
        elif action == 'dismiss':
            if row['status'] != 'due':
                raise Conflict('只有到期提醒可以标记已读')
            row['status'] = 'dismissed'
        elif action == 'edit':
            if row['status'] not in ('draft', 'scheduled'):
                raise Conflict('只能修改待确认或未到期的提醒')
            row['title'], row['due_at'] = validate(title, due_at, now)
            # Editing always returns to draft, so changing a time never silently activates it.
            row['status'] = 'draft'
        else:
            raise ValueError('未知操作')
        conn.execute('''UPDATE reminders SET title=?,due_at=?,status=?,revision=revision+1,
            updated_at=?,expires_at=? WHERE id=? AND persona_id=? AND revision=?''',
            (row['title'], row['due_at'], row['status'], now, min(now + 86400, row['due_at']), rid, persona_id, revision))
        return dict(conn.execute('SELECT * FROM reminders WHERE id=?', (rid,)).fetchone())


async def _run():
    while True:
        try:
            await asyncio.to_thread(tick)
        except Exception:
            log.warning('Reminder scan failed; will retry on next scan')
        await asyncio.sleep(5)


def start():
    global _task
    if _task is None or _task.done():
        _task = asyncio.create_task(_run())


async def stop():
    global _task
    if _task:
        _task.cancel()
        await asyncio.gather(_task, return_exceptions=True)
        _task = None


def __getattr__(name):
    if name in ('ReminderInput', 'draft', 'tool'):
        from .. import tool_feature
        return getattr(tool_feature.load('reminder_tools'), name)
    raise AttributeError(name)
