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
from .seed_profiles import MAIN_PERSONA_ID, SEED_PROFILES
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
CREATE TABLE IF NOT EXISTS profiles (
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
    owner TEXT NOT NULL DEFAULT '',
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
CREATE TABLE IF NOT EXISTS gemini_sync_messages (
    conversation_id TEXT NOT NULL,
    source_message_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    raw_content TEXT NOT NULL,
    complete INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (conversation_id, source_message_id)
);
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
    game_id TEXT NOT NULL DEFAULT '',
    world_id TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_memories_bucket ON memories (bucket, char_id);
CREATE TABLE IF NOT EXISTS game_sessions (
    game_id TEXT NOT NULL,
    world_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (game_id, world_id)
);
CREATE TABLE IF NOT EXISTS game_api_configs (
    id TEXT PRIMARY KEY,
    game_id TEXT NOT NULL,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    api_key TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_game_api_config_name ON game_api_configs (game_id, name);
CREATE TABLE IF NOT EXISTS game_commands (
    id TEXT PRIMARY KEY,
    game_id TEXT NOT NULL,
    world_id TEXT NOT NULL,
    character_id TEXT NOT NULL DEFAULT '',
    command TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    result TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_game_commands_queue ON game_commands (game_id, world_id, status, created_at);
CREATE TABLE IF NOT EXISTS game_play_sessions (
    id TEXT PRIMARY KEY,
    game_id TEXT NOT NULL,
    world_id TEXT NOT NULL,
    player_id TEXT NOT NULL DEFAULT '',
    character_ids TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'active',
    record TEXT NOT NULL DEFAULT '{}',
    summary TEXT NOT NULL DEFAULT '',
    summary_memory_id TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_game_play_sessions_scope ON game_play_sessions (game_id, world_id, created_at);
CREATE TABLE IF NOT EXISTS agent_messages (
    id TEXT PRIMARY KEY,
    sender TEXT NOT NULL,
    recipient TEXT NOT NULL DEFAULT '*',
    conversation_id TEXT NOT NULL DEFAULT '',
    correlation_id TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'message',
    payload TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'queued',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    handled_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_agent_messages_inbox ON agent_messages (recipient, status, created_at);
CREATE TABLE IF NOT EXISTS gallery (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL DEFAULT '',
    message_id TEXT NOT NULL DEFAULT '',
    owner TEXT NOT NULL DEFAULT '',
    orig TEXT NOT NULL DEFAULT '',
    thumb TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    in_memory INTEGER NOT NULL DEFAULT 1,
    memory_id TEXT NOT NULL DEFAULT '',
    -- §26 私密层：纯界面开关，与 owner（归属）/ in_memory（进记忆）正交。
    -- 1 = 收进「私密」层，公开画廊列表默认不展示（防别人瞥屏），但仍可正常进记忆。
    private INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
"""

# gallery 的索引单列出来、由 _migrate 统一建：老库还没有 owner 列时，必须先 ALTER 补列
# 再建索引，写在 _SCHEMA 里会在建索引那一步就炸（no such column: owner）。
_GALLERY_INDEXES = (
    "CREATE INDEX IF NOT EXISTS idx_gallery_owner ON gallery (owner)",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_gallery_orig_owner ON gallery (orig, owner)",
)

# 世界书的归属索引同理，也必须等 ALTER 补完 owner 列再建（§19）。
_WORLDBOOK_INDEXES = ("CREATE INDEX IF NOT EXISTS idx_worldbook_owner ON worldbook (owner)",)


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


def _migrate(conn: sqlite3.Connection) -> None:
    """老库补列（幂等）。新库走 _SCHEMA 已有这些列，这里只兜底。"""
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(gallery)")}
    if "owner" not in cols:
        # SQLite 的 ADD COLUMN 不接受「NOT NULL 且无默认值」，必须带 DEFAULT。
        # 老行全部落成 ''（= 家共用），不丢数据。
        conn.execute("ALTER TABLE gallery ADD COLUMN owner TEXT NOT NULL DEFAULT ''")
    if "private" not in cols:
        # 私密层（§26）：老行全部落成 0（= 公开），升级后画廊显示不变。
        conn.execute("ALTER TABLE gallery ADD COLUMN private INTEGER NOT NULL DEFAULT 0")
    # 补列之后才建索引（老库的旧唯一索引 idx_gallery_orig 会让「同图进多个归属」失败）
    for sql in _GALLERY_INDEXES:
        conn.execute(sql)
    conn.execute("DROP INDEX IF EXISTS idx_gallery_orig")

    # 世界书同样按归属分家（§19）：和画廊一个套路。
    # 老库的世界书全部落成 ''（= 家共用），所以升级后旧词条仍然是全家共享的，行为不变。
    wb_cols = {r["name"] for r in conn.execute("PRAGMA table_info(worldbook)")}
    if "owner" not in wb_cols:
        conn.execute("ALTER TABLE worldbook ADD COLUMN owner TEXT NOT NULL DEFAULT ''")
    for sql in _WORLDBOOK_INDEXES:
        conn.execute(sql)
    mem_cols = {r["name"] for r in conn.execute("PRAGMA table_info(memories)")}
    if "game_id" not in mem_cols:
        conn.execute("ALTER TABLE memories ADD COLUMN game_id TEXT NOT NULL DEFAULT ''")
    if "world_id" not in mem_cols:
        conn.execute("ALTER TABLE memories ADD COLUMN world_id TEXT NOT NULL DEFAULT ''")
    # 必须在 ALTER TABLE 补列之后建索引；旧库的 memories 表此时还没有游戏隔离字段。
    conn.execute("CREATE INDEX IF NOT EXISTS idx_memories_game ON memories (game_id, world_id, bucket, char_id)")
    # 旧版唯一索引没有游戏范围，会把不同游戏/世界的同文记忆错误视为重复。
    conn.execute("DROP INDEX IF EXISTS idx_memories_dedupe")
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_dedupe ON memories (bucket, char_id, fingerprint, game_id, world_id)")


def _read_tombstones(conn: sqlite3.Connection) -> list[str]:
    row = conn.execute("SELECT value FROM settings WHERE key = 'deleted_profiles'").fetchone()
    return [i for i in (row["value"] if row else "").split(",") if i]


def _write_tombstones(conn: sqlite3.Connection, ids: list[str]) -> None:
    value = ",".join(dict.fromkeys(i for i in ids if i))
    conn.execute(
        "INSERT INTO settings (key, value) VALUES ('deleted_profiles', ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (value,),
    )


def _migrate_dalaoda(conn: sqlite3.Connection) -> None:
    """把大老大从 characters 迁进 profiles（§22）。幂等：跑过一次之后不再有可迁的行。

    只搬档案，**不动聊天记录 / 记忆 / 画廊** —— 会话 id（`single-dalaoda`）、记忆桶
    （`personal/dalaoda`）、画廊归属都以「大老大」这个 id 为键，id 不变就全部照旧，
    切回大老大身份时历史原样还在。这跟「记忆完全独立于用户视角」是同一条原则。
    """
    row = conn.execute("SELECT id, data FROM characters WHERE id = ?", ("dalaoda",)).fetchone()
    if row is None:
        return
    # 已在 profiles 里的话（重复启动）只删 characters 那份，不覆盖用户改过的档案。
    exists = conn.execute("SELECT id FROM profiles WHERE id = ?", ("dalaoda",)).fetchone()
    if exists is None and "dalaoda" not in _read_tombstones(conn):
        conn.execute(
            "INSERT INTO profiles (id, data) VALUES (?, ?) ON CONFLICT(id) DO NOTHING",
            ("dalaoda", row["data"]),
        )
    conn.execute("DELETE FROM characters WHERE id = ?", ("dalaoda",))


def _backfill_profile_fields(conn: sqlite3.Connection) -> None:
    """给老库里已有的身份档案补上「种子里新加、而这份档案整个键都还没有」的字段（§22）。

    典型场景：大老大的档案是从 characters 抬过来的老数据，里面没有 `relation` 与
    `asCharacter` —— 不补的话，Prompt 里注不进用户身份，汐子视角下他也不会现身。

    判定用「键是否存在」而不是「值是否为空」：用户手动清空 relation（存成 `""`）算他的
    修改，不该被种子填回去。只补顶层缺失键，不递归。
    """
    rows = conn.execute("SELECT id, data FROM profiles").fetchall()
    for row in rows:
        seed = next((p for p in SEED_PROFILES if p["id"] == row["id"]), None)
        if seed is None:
            continue
        data = json.loads(row["data"])
        missing = {k: v for k, v in seed.items() if k not in data}
        if not missing:
            continue
        data.update(missing)
        conn.execute(
            "UPDATE profiles SET data = ?, updated_at = datetime('now') WHERE id = ?",
            (json.dumps(data, ensure_ascii=False), row["id"]),
        )


def init_db() -> None:
    """建表 + 迁移 + 逐条幂等补种。在启动时调用一次。"""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        conn.executescript(_SCHEMA)
        _migrate(conn)
        # 逐条补种：老库也能长出新增的角色（如后来加的小糖人），但已存在的一律不覆盖 ——
        # 用户可能在编辑器里改过，种子不该把改动冲掉。
        conn.executemany(
            "INSERT INTO characters (id, data) VALUES (?, ?) ON CONFLICT(id) DO NOTHING",
            [(c["id"], json.dumps(c, ensure_ascii=False)) for c in SEED_CHARACTERS],
        )
        # 大老大先从 characters 抬出来（老库升级路径），再补种 profiles。
        _migrate_dalaoda(conn)
        # 个人档案（§22）同样逐条补种，且尊重删除墓碑：用户删掉的档案不会被种子复活。
        dead = _read_tombstones(conn)
        conn.executemany(
            "INSERT INTO profiles (id, data) VALUES (?, ?) ON CONFLICT(id) DO NOTHING",
            [
                (p["id"], json.dumps(p, ensure_ascii=False))
                for p in SEED_PROFILES
                if p["id"] not in dead
            ],
        )
        # 补种只覆盖「整行不存在」的情况，补不了「行在、但缺新字段」（老库升级路径）。
        _backfill_profile_fields(conn)
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


# ---- 个人档案（profiles / 私人空间，§22）----
# 表结构、读写方式与 characters 完全一致，只是语义不同：characters 是「被聊的小糖人」，
# profiles 是「用户自己的身份」。拆成两张表而不是加个字段，是为了让两边各自独立演进 ——
# 身份不需要进群聊阵容，角色也不需要「成为」这个动作。


def list_profiles() -> list[dict]:
    with _tx() as conn:
        rows = conn.execute("SELECT data FROM profiles ORDER BY rowid").fetchall()
    return [json.loads(r["data"]) for r in rows]


def get_profile(profile_id: str) -> dict | None:
    with _tx() as conn:
        row = conn.execute("SELECT data FROM profiles WHERE id = ?", (profile_id,)).fetchone()
    return json.loads(row["data"]) if row else None


def upsert_profile(profile_id: str, data: dict) -> None:
    data = {**data, "id": profile_id}
    with _tx() as conn:
        conn.execute(
            "INSERT INTO profiles (id, data, updated_at) VALUES (?, ?, datetime('now')) "
            "ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
            (profile_id, json.dumps(data, ensure_ascii=False)),
        )


def delete_profile(profile_id: str) -> None:
    """删一份身份档案，并记下墓碑 —— 否则下次启动种子会把它复活。

    只删档案行。聊天记录 / 记忆 / 画廊的清理在 `services/cleanup.py` 里做，
    因为那要动文件系统，不该由 db 层操心。
    """
    with _tx() as conn:
        conn.execute("DELETE FROM profiles WHERE id = ?", (profile_id,))
        _write_tombstones(conn, [*_read_tombstones(conn), profile_id])


def get_active_persona_id() -> str:
    """当前正在用的身份 id。缺省（首次启动 / 没设置过）= 大老大。"""
    with _tx() as conn:
        row = conn.execute(
            "SELECT value FROM settings WHERE key = 'active_persona_id'"
        ).fetchone()
    value = (row["value"] if row else "") or ""
    if not value:
        return MAIN_PERSONA_ID
    # 身份被删掉了（或指向了不存在的档案）就回落，免得前端拿到空身份。
    return value if get_profile(value) else MAIN_PERSONA_ID


def set_active_persona_id(profile_id: str) -> None:
    with _tx() as conn:
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('active_persona_id', ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (profile_id,),
        )


def list_session_ids(prefix: str) -> list[str]:
    """消息表里所有以 `prefix` 开头的会话 id（去重）。

    删一份身份档案时用它找出这个身份名下的全部会话（`xizi@group` / `xizi@single-xxx`）。
    """
    with _tx() as conn:
        rows = conn.execute(
            "SELECT DISTINCT session_id FROM messages WHERE session_id LIKE ?",
            (f"{prefix}%",),
        ).fetchall()
    return [r["session_id"] for r in rows]


# ---- 世界书（worldbook）----


def _row_to_entry(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "title": row["title"],
        "keywords": row["keywords"],
        "content": row["content"],
        "enabled": bool(row["enabled"]),
        "priority": row["priority"],
        # 归属：'' = 家共用（群聊 / 未指定时用），<角色 id> = 那位角色的专属（§19）
        "owner": row["owner"] or "",
        "updated_at": row["updated_at"],
    }


def list_worldbook(owner: str | None = None) -> list[dict]:
    """owner=None 取全部；给了值就只取那一档（'' 即家共用）。"""
    with _tx() as conn:
        if owner is None:
            rows = conn.execute("SELECT * FROM worldbook ORDER BY priority DESC, rowid").fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM worldbook WHERE owner = ? ORDER BY priority DESC, rowid",
                (owner,),
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
            "INSERT INTO worldbook (id, title, keywords, content, enabled, priority, owner) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                entry_id,
                entry["title"],
                entry["keywords"],
                entry["content"],
                int(entry["enabled"]),
                int(entry["priority"]),
                entry.get("owner") or "",
            ),
        )
    row = get_worldbook(entry_id)
    assert row is not None
    return row


def update_worldbook(entry_id: str, entry: dict) -> None:
    with _tx() as conn:
        conn.execute(
            "UPDATE worldbook SET title=?, keywords=?, content=?, enabled=?, priority=?, "
            "owner=?, updated_at=datetime('now') WHERE id=?",
            (
                entry["title"],
                entry["keywords"],
                entry["content"],
                int(entry["enabled"]),
                int(entry["priority"]),
                entry.get("owner") or "",
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


def delete_messages_by_session(session_id: str) -> list[dict]:
    """清空某会话并**返回被删的整行** —— `cleanup.delete_session` 要用它们回收图片。

    与上面的 `delete_messages` 的区别只是返回值形状；那个已被 routers/messages.py
    占用为「只报数量」的老接口，不动它。
    """
    with _tx() as conn:
        rows = conn.execute(
            "SELECT rowid, * FROM messages WHERE session_id = ? ORDER BY rowid", (session_id,)
        ).fetchall()
        if rows:
            conn.execute("DELETE FROM messages WHERE session_id = ?", (session_id,))
    return [_row_to_message(r) for r in rows]


def get_message(msg_id: str) -> dict | None:
    with _tx() as conn:
        row = conn.execute("SELECT rowid, * FROM messages WHERE id = ?", (msg_id,)).fetchone()
    return _row_to_message(row) if row else None


def delete_message(msg_id: str) -> dict | None:
    """删一条消息，返回被删的整行（供调用方回收附件 / 级联画廊）。没有则 None。"""
    with _tx() as conn:
        row = conn.execute("SELECT rowid, * FROM messages WHERE id = ?", (msg_id,)).fetchone()
        if row is None:
            return None
        deleted = _row_to_message(row)
        conn.execute("DELETE FROM messages WHERE id = ?", (msg_id,))
    return deleted


def delete_messages_by_ids(ids: list[str]) -> list[dict]:
    """批量删消息（QQ 式多选删除）。一次查一次删，返回被删的行。"""
    clean = [i for i in (ids or []) if i]
    if not clean:
        return []
    placeholders = ",".join("?" * len(clean))
    with _tx() as conn:
        rows = conn.execute(
            f"SELECT rowid, * FROM messages WHERE id IN ({placeholders})", clean
        ).fetchall()
        deleted = [_row_to_message(r) for r in rows]
        if deleted:
            conn.execute(f"DELETE FROM messages WHERE id IN ({placeholders})", clean)
    return deleted


def list_messages_by_image(orig: str, exclude_ids: list[str] | None = None) -> list[str]:
    """这张图片 URL 还被哪些**幸存**消息引用（用于决定文件能否真删）。"""
    if not (orig or "").strip():
        return []
    sql = "SELECT id FROM messages WHERE image = ?"
    args: list = [orig]
    clean = [i for i in (exclude_ids or []) if i]
    if clean:
        sql += f" AND id NOT IN ({','.join('?' * len(clean))})"
        args.extend(clean)
    with _tx() as conn:
        return [r["id"] for r in conn.execute(sql, args).fetchall()]


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
        "game_id": row["game_id"],
        "world_id": row["world_id"],
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
    game_id: str = "",
    world_id: str = "",
) -> dict | None:
    """写一条记忆。同桶内指纹重复 → 返回 None（幂等去重）。"""
    mem_id = f"mem-{uuid.uuid4().hex[:12]}"
    with _tx() as conn:
        existing = conn.execute(
            "SELECT id FROM memories WHERE bucket = ? AND char_id = ? AND fingerprint = ? AND game_id = ? AND world_id = ?",
            (bucket, char_id, fingerprint, game_id, world_id),
        ).fetchone()
        if existing:
            return None
        conn.execute(
            "INSERT INTO memories (id, bucket, char_id, text, source, engine, dim, vector, "
            "fingerprint, meta, game_id, world_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
                game_id,
                world_id,
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
        "game_id": game_id,
        "world_id": world_id,
    }


def list_memories(
    bucket: str | None = None,
    char_id: str | None = None,
    limit: int = 200,
    game_id: str | None = None,
    world_id: str | None = None,
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
    if game_id is not None:
        where.append("game_id = ?")
        args.append(game_id)
    if world_id is not None:
        where.append("world_id = ?")
        args.append(world_id)
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


def get_memory_by_fingerprint(
    bucket: str, char_id: str, fingerprint: str, game_id: str = "", world_id: str = ""
) -> dict | None:
    """按「桶 + 角色 + 内容指纹」查一条记忆（§9.4 画廊去重时复用已有记忆）。"""
    with _tx() as conn:
        row = conn.execute(
            "SELECT * FROM memories WHERE bucket = ? AND char_id = ? AND fingerprint = ? AND game_id = ? AND world_id = ?",
            (bucket, char_id, fingerprint, game_id, world_id),
        ).fetchone()
    return _row_to_memory(row) if row else None


def update_memory_vector(mem_id: str, engine: str, vector: bytes, dim: int) -> None:
    """重建索引时刷新某条记忆的向量与口径（§16.6）。"""
    with _tx() as conn:
        conn.execute(
            "UPDATE memories SET engine = ?, vector = ?, dim = ? WHERE id = ?",
            (engine, vector, int(dim), mem_id),
        )


# ---- 通用游戏接入状态（不包含任何具体游戏实现）----
def upsert_game_session(game_id: str, world_id: str, state: dict) -> dict:
    with _tx() as conn:
        conn.execute("""INSERT INTO game_sessions (game_id, world_id, state, updated_at)
            VALUES (?, ?, ?, datetime('now'))
            ON CONFLICT(game_id, world_id) DO UPDATE SET state=excluded.state, updated_at=excluded.updated_at""",
            (game_id, world_id, json.dumps(state or {}, ensure_ascii=False)))
        row = conn.execute("SELECT * FROM game_sessions WHERE game_id=? AND world_id=?", (game_id, world_id)).fetchone()
    return {"game_id": row["game_id"], "world_id": row["world_id"], "state": json.loads(row["state"]), "updated_at": row["updated_at"]}


def get_game_session(game_id: str, world_id: str) -> dict | None:
    with _tx() as conn:
        row = conn.execute("SELECT * FROM game_sessions WHERE game_id=? AND world_id=?", (game_id, world_id)).fetchone()
    if not row:
        return None
    return {"game_id": row["game_id"], "world_id": row["world_id"], "state": json.loads(row["state"]), "updated_at": row["updated_at"]}

def upsert_game_api_config(game_id: str, name: str, base_url: str, api_key: str, model: str) -> dict:
    cid = f"gapi-{uuid.uuid4().hex[:12]}"
    with _tx() as conn:
        old = conn.execute("SELECT id FROM game_api_configs WHERE game_id=? AND name=?", (game_id, name)).fetchone()
        if old:
            cid = old["id"]
        conn.execute("INSERT INTO game_api_configs (id,game_id,name,base_url,api_key,model) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET base_url=excluded.base_url,api_key=excluded.api_key,model=excluded.model,enabled=1,updated_at=datetime('now')", (cid, game_id, name, base_url, api_key or "", model or ""))
    return get_game_api_config(cid)

def get_game_api_config(config_id: str) -> dict | None:
    with _tx() as conn:
        row = conn.execute("SELECT * FROM game_api_configs WHERE id=?", (config_id,)).fetchone()
    return dict(row) if row else None

def list_game_api_configs(game_id: str) -> list[dict]:
    with _tx() as conn:
        rows = conn.execute("SELECT * FROM game_api_configs WHERE game_id=? AND enabled=1 ORDER BY updated_at DESC", (game_id,)).fetchall()
    return [dict(r) for r in rows]


def enqueue_game_command(game_id: str, world_id: str, character_id: str, command: dict) -> dict:
    cid = f"cmd-{uuid.uuid4().hex[:12]}"
    with _tx() as conn:
        conn.execute("INSERT INTO game_commands (id, game_id, world_id, character_id, command) VALUES (?, ?, ?, ?, ?)",
                     (cid, game_id, world_id, character_id or "", json.dumps(command or {}, ensure_ascii=False)))
    return {"id": cid, "game_id": game_id, "world_id": world_id, "character_id": character_id or "", "command": command or {}, "status": "queued"}


def list_game_commands(game_id: str, world_id: str, status: str = "queued", limit: int = 50) -> list[dict]:
    with _tx() as conn:
        rows = conn.execute("SELECT * FROM game_commands WHERE game_id=? AND world_id=? AND status=? ORDER BY created_at LIMIT ?",
                            (game_id, world_id, status, max(1, min(limit, 100)))).fetchall()
    return [{"id": r["id"], "game_id": r["game_id"], "world_id": r["world_id"], "character_id": r["character_id"],
             "command": json.loads(r["command"]), "status": r["status"], "result": json.loads(r["result"])} for r in rows]


def update_game_command(command_id: str, status: str, result: dict | None = None) -> bool:
    with _tx() as conn:
        cur = conn.execute("UPDATE game_commands SET status=?, result=?, updated_at=datetime('now') WHERE id=?",
                           (status, json.dumps(result or {}, ensure_ascii=False), command_id))
        return bool(cur.rowcount)


def create_game_play_session(game_id: str, world_id: str, player_id: str, character_ids: list[str], record: dict | None = None) -> dict:
    sid = f"play-{uuid.uuid4().hex[:12]}"
    with _tx() as conn:
        conn.execute("INSERT INTO game_play_sessions (id,game_id,world_id,player_id,character_ids,record) VALUES (?,?,?,?,?,?)",
                     (sid, game_id, world_id, player_id or "", json.dumps(character_ids or [], ensure_ascii=False), json.dumps(record or {}, ensure_ascii=False)))
    return get_game_play_session(sid)


def get_game_play_session(session_id: str) -> dict | None:
    with _tx() as conn:
        row = conn.execute("SELECT * FROM game_play_sessions WHERE id = ?", (session_id,)).fetchone()
    if not row:
        return None
    return {"id": row["id"], "game_id": row["game_id"], "world_id": row["world_id"], "player_id": row["player_id"],
            "character_ids": json.loads(row["character_ids"]), "status": row["status"], "record": json.loads(row["record"]),
            "summary": row["summary"], "summary_memory_id": row["summary_memory_id"], "created_at": row["created_at"], "finished_at": row["finished_at"]}


def finish_game_play_session(session_id: str, record: dict | None = None, summary: str | None = None) -> dict | None:
    with _tx() as conn:
        conn.execute("UPDATE game_play_sessions SET status='finished', record=?, summary=COALESCE(?, summary), finished_at=datetime('now') WHERE id=? AND status='active'",
                     (json.dumps(record or {}, ensure_ascii=False), summary, session_id))
    return get_game_play_session(session_id)


def commit_game_play_summary(session_id: str, memory_id: str) -> bool:
    with _tx() as conn:
        cur = conn.execute("UPDATE game_play_sessions SET summary_memory_id=? WHERE id=? AND status='finished'", (memory_id, session_id))
    return bool(cur.rowcount)


def list_game_play_summaries(game_id: str, world_id: str, limit: int = 50) -> list[dict]:
    with _tx() as conn:
        rows = conn.execute("SELECT * FROM game_play_sessions WHERE game_id=? AND world_id=? AND status='finished' AND summary<>'' ORDER BY created_at DESC LIMIT ?", (game_id, world_id, max(1, min(limit, 100)))).fetchall()
    return [get_game_play_session(r["id"]) for r in rows]


# ---- 通用 Agent 协作消息（不绑定游戏）----
def send_agent_message(sender: str, recipient: str, conversation_id: str, correlation_id: str, kind: str, payload: dict) -> dict:
    mid = f"agent-{uuid.uuid4().hex[:12]}"
    with _tx() as conn:
        conn.execute("INSERT INTO agent_messages (id,sender,recipient,conversation_id,correlation_id,kind,payload) VALUES (?,?,?,?,?,?,?)",
                     (mid, sender, recipient or "*", conversation_id or "", correlation_id or "", kind or "message", json.dumps(payload or {}, ensure_ascii=False)))
    return {"id": mid, "sender": sender, "recipient": recipient or "*", "conversation_id": conversation_id or "", "correlation_id": correlation_id or "", "kind": kind or "message", "payload": payload or {}, "status": "queued"}


def list_agent_messages(agent_id: str, status: str | None, conversation_id: str | None, limit: int) -> list[dict]:
    where = ["(recipient = ? OR recipient = '*')"]
    args: list = [agent_id]
    if status:
        where.append("status = ?")
        args.append(status)
    if conversation_id:
        where.append("conversation_id = ?")
        args.append(conversation_id)
    args.append(max(1, min(limit, 200)))
    with _tx() as conn:
        rows = conn.execute(f"SELECT * FROM agent_messages WHERE {' AND '.join(where)} ORDER BY created_at DESC LIMIT ?", args).fetchall()
    return [{"id": r["id"], "sender": r["sender"], "recipient": r["recipient"], "conversation_id": r["conversation_id"], "correlation_id": r["correlation_id"], "kind": r["kind"], "payload": json.loads(r["payload"]), "status": r["status"], "created_at": r["created_at"], "handled_at": r["handled_at"]} for r in rows]


def update_agent_message(message_id: str, status: str) -> bool:
    with _tx() as conn:
        cur = conn.execute("UPDATE agent_messages SET status=?, handled_at=datetime('now') WHERE id=?", (status, message_id))
        return bool(cur.rowcount)


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
        "owner": row["owner"],
        "orig": row["orig"],
        "thumb": row["thumb"],
        "description": row["description"],
        "in_memory": bool(row["in_memory"]),
        "memory_id": row["memory_id"],
        "private": bool(row["private"]),
        "created_at": row["created_at"],
    }


def add_gallery(
    orig: str,
    thumb: str = "",
    description: str = "",
    session_id: str = "",
    message_id: str = "",
    owner: str = "",
    in_memory: bool = True,
    memory_id: str = "",
    private: bool = False,
) -> dict | None:
    """收藏一张图。同一归属下同一张原图重复收藏 → 返回 None（幂等）。

    owner：'' = 家共用，<charId> = 该角色专属。同一张图可以分别存进多个归属。
    private（§26）：1 = 收进私密层（界面默认不展示，与记忆无关）。
    """
    with _tx() as conn:
        existing = conn.execute(
            "SELECT id FROM gallery WHERE orig = ? AND owner = ?", (orig, owner)
        ).fetchone()
        if existing:
            return None
        gid = f"gal-{uuid.uuid4().hex[:12]}"
        conn.execute(
            "INSERT INTO gallery (id, session_id, message_id, owner, orig, thumb, description, "
            "in_memory, memory_id, private) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                gid, session_id, message_id, owner, orig, thumb, description,
                int(in_memory), memory_id, int(private),
            ),
        )
    return get_gallery(gid)


def list_gallery(
    limit: int = 200, owner: str | None = None, private: bool | None = None
) -> list[dict]:
    """owner=None = 全量；owner='' / <charId> = 按归属过滤（空串是合法筛选值）。

    private（§26）：None = 两层都要；True/False = 只要私密层 / 只要公开层。
    """
    sql = "SELECT * FROM gallery"
    where: list[str] = []
    args: list = []
    if owner is not None:
        where.append("owner = ?")
        args.append(owner)
    if private is not None:
        where.append("private = ?")
        args.append(int(private))
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY rowid DESC LIMIT ?"
    args.append(max(1, min(int(limit or 200), 1000)))
    with _tx() as conn:
        rows = conn.execute(sql, args).fetchall()
    return [_row_to_gallery(r) for r in rows]


def get_gallery(gallery_id: str) -> dict | None:
    with _tx() as conn:
        row = conn.execute("SELECT * FROM gallery WHERE id = ?", (gallery_id,)).fetchone()
    return _row_to_gallery(row) if row else None


def get_gallery_by_orig(orig: str, owner: str | None = None) -> dict | None:
    with _tx() as conn:
        if owner is None:
            row = conn.execute(
                "SELECT * FROM gallery WHERE orig = ? ORDER BY rowid", (orig,)
            ).fetchone()
        else:
            row = conn.execute(
                "SELECT * FROM gallery WHERE orig = ? AND owner = ?", (orig, owner)
            ).fetchone()
    return _row_to_gallery(row) if row else None


def list_gallery_by_orig(orig: str) -> list[dict]:
    """这张图在所有归属下的画廊记录（真删时逐条清理）。"""
    with _tx() as conn:
        rows = conn.execute("SELECT * FROM gallery WHERE orig = ?", (orig,)).fetchall()
    return [_row_to_gallery(r) for r in rows]


def update_gallery(
    gallery_id: str,
    description: str | None = None,
    in_memory: bool | None = None,
    memory_id: str | None = None,
    owner: str | None = None,
    private: bool | None = None,
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
    if owner is not None:
        sets.append("owner = ?")
        args.append(owner)
    if private is not None:
        sets.append("private = ?")
        args.append(int(private))
    if not sets:
        return
    args.append(gallery_id)
    with _tx() as conn:
        conn.execute(f"UPDATE gallery SET {', '.join(sets)} WHERE id = ?", args)


def delete_gallery(gallery_id: str) -> bool:
    with _tx() as conn:
        cur = conn.execute("DELETE FROM gallery WHERE id = ?", (gallery_id,))
        return bool(cur.rowcount)


def count_gallery(owner: str | None = None, private: bool | None = None) -> int:
    where: list[str] = []
    args: list = []
    if owner is not None:
        where.append("owner = ?")
        args.append(owner)
    if private is not None:
        where.append("private = ?")
        args.append(int(private))
    sql = "SELECT COUNT(*) FROM gallery"
    if where:
        sql += " WHERE " + " AND ".join(where)
    with _tx() as conn:
        row = conn.execute(sql, args).fetchone()
    return int(row[0])
