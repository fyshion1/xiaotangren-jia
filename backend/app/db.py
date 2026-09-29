"""SQLite 存储层：人设 / 世界书 / 键值设置（越狱等）。

单用户本地应用，标准库 sqlite3 足够，不引入 ORM。
库文件：backend/data/xiaotangren.db（已被 .gitignore 的 data/ 与 *.db 排除）。
"""

from __future__ import annotations

import json
import sqlite3
import threading
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from .seed_characters import SEED_CHARACTERS
from .seed_worldbook import SEED_WORLDBOOK

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DB_PATH = DATA_DIR / "xiaotangren.db"

_lock = threading.Lock()

_SCHEMA = """
CREATE TABLE IF NOT EXISTS characters (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS worldbook (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    keywords TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    priority INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
);
"""


@contextmanager
def _tx() -> Iterator[sqlite3.Connection]:
    """开一个事务连接：单用户串行，读写都走同一把锁，用完即关。"""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        with _lock:
            yield conn
            conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    """建表 + 首次写入种子数据（幂等）。在启动时调用一次。"""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.executescript(_SCHEMA)
        if conn.execute("SELECT COUNT(*) FROM characters").fetchone()[0] == 0:
            conn.executemany(
                "INSERT INTO characters (id, data) VALUES (?, ?)",
                [(c["id"], json.dumps(c, ensure_ascii=False)) for c in SEED_CHARACTERS],
            )
        if conn.execute("SELECT COUNT(*) FROM worldbook").fetchone()[0] == 0:
            conn.executemany(
                "INSERT INTO worldbook (id, title, keywords, content, enabled, priority) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                [
                    (e["id"], e["title"], e["keywords"], e["content"], e["enabled"], e["priority"])
                    for e in SEED_WORLDBOOK
                ],
            )
        conn.commit()
    finally:
        conn.close()


# ---- 人设（characters）----


def list_characters() -> list[dict]:
    with _tx() as conn:
        rows = conn.execute("SELECT data FROM characters ORDER BY rowid").fetchall()
    return [json.loads(r["data"]) for r in rows]


def get_character(char_id: str) -> dict | None:
    with _tx() as conn:
        row = conn.execute("SELECT data FROM characters WHERE id = ?", (char_id,)).fetchone()
    return json.loads(row["data"]) if row else None


def upsert_character(char_id: str, data: dict) -> None:
    data = {**data, "id": char_id}
    with _tx() as conn:
        conn.execute(
            "INSERT INTO characters (id, data, updated_at) VALUES (?, ?, datetime('now')) "
            "ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
            (char_id, json.dumps(data, ensure_ascii=False)),
        )


# ---- 世界书（worldbook）----


def _row_to_entry(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "title": row["title"],
        "keywords": row["keywords"],
        "content": row["content"],
        "enabled": bool(row["enabled"]),
        "priority": row["priority"],
        "updated_at": row["updated_at"],
    }


def list_worldbook() -> list[dict]:
    with _tx() as conn:
        rows = conn.execute(
            "SELECT * FROM worldbook ORDER BY priority DESC, rowid"
        ).fetchall()
    return [_row_to_entry(r) for r in rows]


def get_worldbook(entry_id: str) -> dict | None:
    with _tx() as conn:
        row = conn.execute("SELECT * FROM worldbook WHERE id = ?", (entry_id,)).fetchone()
    return _row_to_entry(row) if row else None


def create_worldbook(entry: dict) -> dict:
    entry_id = f"wb-{uuid.uuid4().hex[:10]}"
    with _tx() as conn:
        conn.execute(
            "INSERT INTO worldbook (id, title, keywords, content, enabled, priority) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (
                entry_id,
                entry["title"],
                entry["keywords"],
                entry["content"],
                int(entry["enabled"]),
                int(entry["priority"]),
            ),
        )
    row = get_worldbook(entry_id)
    assert row is not None
    return row


def update_worldbook(entry_id: str, entry: dict) -> None:
    with _tx() as conn:
        conn.execute(
            "UPDATE worldbook SET title=?, keywords=?, content=?, enabled=?, priority=?, "
            "updated_at=datetime('now') WHERE id=?",
            (
                entry["title"],
                entry["keywords"],
                entry["content"],
                int(entry["enabled"]),
                int(entry["priority"]),
                entry_id,
            ),
        )


def delete_worldbook(entry_id: str) -> None:
    with _tx() as conn:
        conn.execute("DELETE FROM worldbook WHERE id = ?", (entry_id,))


# ---- 键值设置（settings）----


def get_settings() -> dict[str, str]:
    with _tx() as conn:
        rows = conn.execute("SELECT key, value FROM settings").fetchall()
    return {r["key"]: r["value"] for r in rows}


def set_settings(kv: dict[str, str]) -> None:
    with _tx() as conn:
        for key, value in (kv or {}).items():
            conn.execute(
                "INSERT INTO settings (key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, str(value)),
            )