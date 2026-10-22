"""SQLite leases coordinate overlapping personas/characters across workers."""
import asyncio
import time
import uuid
from contextlib import asynccontextmanager

from .. import db


def initialize():
    with db._tx() as c:
        c.execute('CREATE TABLE IF NOT EXISTS chat_leases(key TEXT PRIMARY KEY, owner TEXT NOT NULL, expires REAL NOT NULL)')


@asynccontextmanager
async def turn(persona, characters):
    keys = sorted({f'{persona}:{cid}' for cid in characters} or {f'{persona}:*'})
    owner = uuid.uuid4().hex
    with db._tx() as c:
        c.execute('CREATE TABLE IF NOT EXISTS chat_leases(key TEXT PRIMARY KEY, owner TEXT NOT NULL, expires REAL NOT NULL)')
    deadline = time.time() + 180
    while True:
        acquired = False
        with db._tx() as c:
            c.execute('BEGIN IMMEDIATE')
            c.execute('DELETE FROM chat_leases WHERE expires<?', (time.time(),))
            busy = c.execute('SELECT 1 FROM chat_leases WHERE key IN (' + ','.join('?' for _ in keys) + ')', keys).fetchone()
            if not busy:
                c.executemany('INSERT INTO chat_leases VALUES(?,?,?)', [(key, owner, time.time() + 120) for key in keys])
                acquired = True
        if acquired:
            break
        if time.time() >= deadline:
            from fastapi import HTTPException
            raise HTTPException(429, '前面的回复仍在处理，请稍后重试')
        await asyncio.sleep(.05)

    async def renew():
        while True:
            await asyncio.sleep(20)
            with db._tx() as c:
                c.execute('UPDATE chat_leases SET expires=? WHERE owner=?', (time.time() + 120, owner))
    heartbeat = asyncio.create_task(renew())
    lease = {'owner': owner, 'hold': False}
    failed = False
    try:
        yield lease
    except BaseException:
        failed = True
        raise
    finally:
        heartbeat.cancel()
        await asyncio.gather(heartbeat, return_exceptions=True)
        if failed or not lease['hold']:
            release(owner)


def release(owner):
    initialize()
    with db._tx() as c:
        c.execute('DELETE FROM chat_leases WHERE owner=?', (owner,))


def refresh(owner, persona, characters):
    initialize()
    keys = sorted({f'{persona}:{cid}' for cid in characters})
    with db._tx() as c:
        rows = c.execute('SELECT key FROM chat_leases WHERE owner=? AND expires>?', (owner, time.time())).fetchall()
        if sorted(r[0] for r in rows) != keys:
            return False
        c.execute('UPDATE chat_leases SET expires=? WHERE owner=?', (time.time() + 120, owner))
    return True
