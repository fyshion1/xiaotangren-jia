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
CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    image TEXT NOT NULL DEFAULT '',
    image_source TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'text',
    segments TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages (session_id);
CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    bucket TEXT NOT NULL,
    char_id TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual',
    engine TEXT NOT NULL DEFAULT '',
    dim INTEGER NOT NULL DEFAULT 0,
    vector BLOB,
    fingerprint TEXT NOT NULL DEFAULT '',
    meta TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_memories_bucket ON memories (bucket, char_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_dedupe ON memories (bucket, char_id, fingerprint);
CREATE TABLE IF NOT EXISTS gallery (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL DEFAULT '',
    message_id TEXT NOT NULL DEFAULT '',
    orig TEXT NOT NULL DEFAULT '',
    thumb TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    in_memory INTEGER NOT NULL DEFAULT 1,
    memory_id TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_gallery_orig ON gallery (orig);
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


# ---- 聊天记录（messages，对应《项目要求》§15）----
#
# 文本/元数据进库；图片只存引用路径（附件落盘见 services/attachments.py）。
# 游标 = rowid（单调自增），分页用它做 before 查询，不用 offset。


def _row_to_message(row: sqlite3.Row) -> dict:
    raw_segments = row["segments"]
    segments: list[dict] = []
    if raw_segments:
        try:
            parsed = json.loads(raw_segments)
            if isinstance(parsed, list):
                segments = parsed
        except (ValueError, TypeError):
            segments = []
    return {
        "id": row["id"],
        "seq": row["rowid"],
        "session_id": row["session_id"],
        "role": row["role"],
        "content": row["content"],
        "image": row["image"],
        "image_source": row["image_source"],
        "kind": row["kind"],
        "segments": segments,
        "created_at": row["created_at"],
    }


def append_message(
    session_id: str,
    role: str,
    content: str = "",
    image: str = "",
    image_source: str = "",
    kind: str = "text",
    segments: list[dict] | None = None,
) -> dict:
    """追加一条消息，返回落库后的完整记录（含 seq）。"""
    msg_id = f"m-{uuid.uuid4().hex[:12]}"
    seg_json = json.dumps(segments, ensure_ascii=False) if segments else ""
    with _tx() as conn:
        cur = conn.execute(
            "INSERT INTO messages (id, session_id, role, content, image, image_source, kind, segments) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (msg_id, session_id, role, content, image, image_source, kind, seg_json),
        )
        rowid = cur.lastrowid
    return {
        "id": msg_id,
        "seq": rowid,
        "session_id": session_id,
        "role": role,
        "content": content,
        "image": image,
        "image_source": image_source,
        "kind": kind,
        "segments": segments or [],
    }


def list_messages(session_id: str, before: int | None = None, limit: int = 30) -> list[dict]:
    """游标分页：取 session 内 seq < before 的最近 limit 条（正序返回，便于前端直接追加）。

    before 为空 = 最新的一页。
    """
    limit = max(1, min(int(limit or 30), 200))
    with _tx() as conn:
        if before:
            rows = conn.execute(
                "SELECT rowid, * FROM messages WHERE session_id = ? AND rowid < ? "
                "ORDER BY rowid DESC LIMIT ?",
                (session_id, int(before), limit),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT rowid, * FROM messages WHERE session_id = ? ORDER BY rowid DESC LIMIT ?",
                (session_id, limit),
            ).fetchall()
    return [_row_to_message(r) for r in reversed(rows)]


def count_messages(session_id: str) -> int:
    with _tx() as conn:
        return int(
            conn.execute(
                "SELECT COUNT(*) FROM messages WHERE session_id = ?", (session_id,)
            ).fetchone()[0]
        )


def delete_messages(session_id: str) -> int:
    """清空某会话的聊天记录（附件文件由调用方决定是否回收）。"""
    with _tx() as conn:
        cur = conn.execute("DELETE FROM messages WHERE session_id = ?", (session_id,))
        return int(cur.rowcount or 0)


# ---- 记忆（memories，对应《项目要求》§9.2）----
#
# 分桶规则（§9.2.2）：
#   bucket='home'  → 家记忆（共享），char_id=''
#   bucket='personal' → 个人记忆，char_id=角色 id
# 一条记忆的向量与其口径指纹（engine）一起落库；检索时按余弦相似度 topk。


def _row_to_memory(row: sqlite3.Row) -> dict:
    meta: dict = {}
    if row["meta"]:
        try:
            parsed = json.loads(row["meta"])
            if isinstance(parsed, dict):
                meta = parsed
        except (ValueError, TypeError):
            meta = {}
    return {
        "id": row["id"],
        "bucket": row["bucket"],
        "char_id": row["char_id"],
        "text": row["text"],
        "source": row["source"],
        "engine": row["engine"],
        "dim": row["dim"],
        "vector": row["vector"],
        "meta": meta,
        "created_at": row["created_at"],
    }


def add_memory(
    bucket: str,
    text: str,
    char_id: str = "",
    source: str = "manual",
    engine: str = "",
    vector: bytes | None = None,
    dim: int = 0,
    fingerprint: str = "",
    meta: dict | None = None,
) -> dict | None:
    """写一条记忆。同桶内指纹重复 → 返回 None（幂等去重）。"""
    mem_id = f"mem-{uuid.uuid4().hex[:12]}"
    with _tx() as conn:
        existing = conn.execute(
            "SELECT id FROM memories WHERE bucket = ? AND char_id = ? AND fingerprint = ?",
            (bucket, char_id, fingerprint),
        ).fetchone()
        if existing:
            return None
        conn.execute(
            "INSERT INTO memories (id, bucket, char_id, text, source, engine, dim, vector, "
            "fingerprint, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                mem_id,
                bucket,
                char_id,
                text,
                source,
                engine,
                int(dim),
                vector,
                fingerprint,
                json.dumps(meta or {}, ensure_ascii=False),
            ),
        )
    return {
        "id": mem_id,
        "bucket": bucket,
        "char_id": char_id,
        "text": text,
        "source": source,
        "engine": engine,
        "dim": dim,
        "vector": vector,
        "meta": meta or {},
    }


def list_memories(
    bucket: str | None = None,
    char_id: str | None = None,
    limit: int = 200,
) -> list[dict]:
    sql = "SELECT * FROM memories"
    where: list[str] = []
    args: list = []
    if bucket:
        where.append("bucket = ?")
        args.append(bucket)
    if char_id is not None:
        where.append("char_id = ?")
        args.append(char_id)
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY rowid DESC LIMIT ?"
    args.append(max(1, min(int(limit or 200), 1000)))
    with _tx() as conn:
        rows = conn.execute(sql, args).fetchall()
    return [_row_to_memory(r) for r in rows]


def get_memory(mem_id: str) -> dict | None:
    with _tx() as conn:
        row = conn.execute("SELECT * FROM memories WHERE id = ?", (mem_id,)).fetchone()
    return _row_to_memory(row) if row else None


def delete_memory(mem_id: str) -> bool:
    with _tx() as conn:
        cur = conn.execute("DELETE FROM memories WHERE id = ?", (mem_id,))
        return bool(cur.rowcount)


def clear_memories(bucket: str | None = None, char_id: str | None = None) -> int:
    """清空记忆（可按桶 / 角色收窄）。返回删除条数。"""
    sql = "DELETE FROM memories"
    where: list[str] = []
    args: list = []
    if bucket:
        where.append("bucket = ?")
        args.append(bucket)
    if char_id is not None:
        where.append("char_id = ?")
        args.append(char_id)
    if where:
        sql += " WHERE " + " AND ".join(where)
    with _tx() as conn:
        cur = conn.execute(sql, args)
        return int(cur.rowcount or 0)


def count_memories(bucket: str | None = None) -> int:
    with _tx() as conn:
        if bucket:
            row = conn.execute(
                "SELECT COUNT(*) FROM memories WHERE bucket = ?", (bucket,)
            ).fetchone()
        else:
            row = conn.execute("SELECT COUNT(*) FROM memories").fetchone()
    return int(row[0])


def get_memory_by_fingerprint(bucket: str, char_id: str, fingerprint: str) -> dict | None:
    """按「桶 + 角色 + 内容指纹」查一条记忆（§9.4 画廊去重时复用已有记忆）。"""
    with _tx() as conn:
        row = conn.execute(
            "SELECT * FROM memories WHERE bucket = ? AND char_id = ? AND fingerprint = ?",
            (bucket, char_id, fingerprint),
        ).fetchone()
    return _row_to_memory(row) if row else None


def update_memory_vector(mem_id: str, engine: str, vector: bytes, dim: int) -> None:
    """重建索引时刷新某条记忆的向量与口径（§16.6）。"""
    with _tx() as conn:
        conn.execute(
            "UPDATE memories SET engine = ?, vector = ?, dim = ? WHERE id = ?",
            (engine, vector, int(dim), mem_id),
        )


# ---- 画廊（gallery，对应《项目要求》§9.4）----
#
# 画廊 = 用户主动保留的重要图片。图片文件仍走 attachments 落盘（这里只存引用 URL），
# description 是这条画廊图的文字描述，也是「照片记忆」A 方案喂给 §9.2 RAG 的正文。
# in_memory=1 时该描述同时是一条家记忆，memory_id 指向它（关掉时删除那条记忆）。


def _row_to_gallery(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "session_id": row["session_id"],
        "message_id": row["message_id"],
        "orig": row["orig"],
        "thumb": row["thumb"],
        "description": row["description"],
        "in_memory": bool(row["in_memory"]),
        "memory_id": row["memory_id"],
        "created_at": row["created_at"],
    }


def add_gallery(
    orig: str,
    thumb: str = "",
    description: str = "",
    session_id: str = "",
    message_id: str = "",
    in_memory: bool = True,
    memory_id: str = "",
) -> dict | None:
    """收藏一张图。同一张原图（同一 URL）重复收藏 → 返回 None（幂等）。"""
    with _tx() as conn:
        existing = conn.execute("SELECT id FROM gallery WHERE orig = ?", (orig,)).fetchone()
        if existing:
            return None
        gid = f"gal-{uuid.uuid4().hex[:12]}"
        conn.execute(
            "INSERT INTO gallery (id, session_id, message_id, orig, thumb, description, "
            "in_memory, memory_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (gid, session_id, message_id, orig, thumb, description, int(in_memory), memory_id),
        )
    return get_gallery(gid)


def list_gallery(limit: int = 200) -> list[dict]:
    with _tx() as conn:
        rows = conn.execute(
            "SELECT * FROM gallery ORDER BY rowid DESC LIMIT ?",
            (max(1, min(int(limit or 200), 1000)),),
        ).fetchall()
    return [_row_to_gallery(r) for r in rows]


def get_gallery(gallery_id: str) -> dict | None:
    with _tx() as conn:
        row = conn.execute("SELECT * FROM gallery WHERE id = ?", (gallery_id,)).fetchone()
    return _row_to_gallery(row) if row else None


def get_gallery_by_orig(orig: str) -> dict | None:
    with _tx() as conn:
        row = conn.execute("SELECT * FROM gallery WHERE orig = ?", (orig,)).fetchone()
    return _row_to_gallery(row) if row else None


def update_gallery(
    gallery_id: str,
    description: str | None = None,
    in_memory: bool | None = None,
    memory_id: str | None = None,
) -> None:
    sets: list[str] = []
    args: list = []
    if description is not None:
        sets.append("description = ?")
        args.append(description)
    if in_memory is not None:
        sets.append("in_memory = ?")
        args.append(int(in_memory))
    if memory_id is not None:
        sets.append("memory_id = ?")
        args.append(memory_id)
    if not sets:
        return
    args.append(gallery_id)
    with _tx() as conn:
        conn.execute(f"UPDATE gallery SET {', '.join(sets)} WHERE id = ?", args)


def delete_gallery(gallery_id: str) -> bool:
    with _tx() as conn:
        cur = conn.execute("DELETE FROM gallery WHERE id = ?", (gallery_id,))
        return bool(cur.rowcount)


def count_gallery() -> int:
    with _tx() as conn:
        return int(conn.execute("SELECT COUNT(*) FROM gallery").fetchone()[0])