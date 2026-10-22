"""Only explicitly registered webpage messages enter the durable QQ outbox.

QQ inbound/delivery writes never call enqueue, so they cannot echo back.
Each account/session has one current destination; changing it drops old backlog.
"""
from __future__ import annotations

from fastapi import HTTPException
from .. import db
from . import qq_conversation


def schema(conn):
    conn.execute('''CREATE TABLE IF NOT EXISTS qq_web_outbox (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL)''')
    conn.execute('''CREATE TABLE IF NOT EXISTS qq_web_cursors (
        account TEXT NOT NULL, session_id TEXT NOT NULL, target TEXT NOT NULL,
        cursor INTEGER NOT NULL, pending INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(account,session_id))''')


def enqueue(conn, message_id: str, session_id: str):
    schema(conn)
    qq_conversation._ledger(conn)
    if conn.execute('''SELECT 1 FROM qq_message_receipts r, json_each(r.message_ids) ids
                       WHERE ids.value=? LIMIT 1''', (message_id,)).fetchone():
        return
    conn.execute('INSERT OR IGNORE INTO qq_web_outbox(message_id,session_id) VALUES(?,?)',
                 (message_id, session_id))


def poll(session: dict, account: str, target: str, ack: int = 0) -> dict:
    resolved = qq_conversation.validate(session)
    sid = resolved['session_id']
    with db._tx() as conn:
        schema(conn)
        old = conn.execute('SELECT * FROM qq_web_cursors WHERE account=? AND session_id=?',
                           (account, sid)).fetchone()
        if not old or old['target'] != target:
            # First binding starts now, never replay historical chat into a new QQ target.
            latest = conn.execute('SELECT COALESCE(MAX(seq),0) FROM qq_web_outbox').fetchone()[0]
            conn.execute('INSERT OR REPLACE INTO qq_web_cursors VALUES(?,?,?,?,0)',
                         (account, sid, target, latest))
            return {'item': None}
        cursor, pending = old['cursor'], old['pending']
        if ack:
            if ack != pending and ack != cursor:
                raise HTTPException(409, '同步回执与待发送消息不符')
            cursor = max(cursor, ack)
        row = conn.execute('''SELECT o.seq AS sync_seq,m.rowid AS rowid,m.*
            FROM qq_web_outbox o JOIN messages m ON m.id=o.message_id
            WHERE o.session_id=? AND o.seq>? ORDER BY o.seq LIMIT 1''', (sid, cursor)).fetchone()
        conn.execute('UPDATE qq_web_cursors SET cursor=?,pending=? WHERE account=? AND session_id=?',
                     (cursor, row['sync_seq'] if row else 0, account, sid))
        item = {**db._row_to_message(row), 'sync_seq': row['sync_seq']} if row else None
    return {'item': item}
