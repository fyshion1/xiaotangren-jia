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
from . import tavern_feature

from .data_paths import runtime_root

DATA_DIR = runtime_root()
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
CREATE TABLE IF NOT EXISTS persona_memory_picks (
    persona_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    ref_id TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (persona_id, kind, ref_id)
);
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
    -- 视觉路（§9.6）：功能自己的 vision 配置。留空 = 回退到「小窝大脑默认」的 vision。
    -- needs_vision=0 时前端给一个「屏蔽视觉」开关，不读这一路，也不注入多模态。
    vision_model TEXT NOT NULL DEFAULT '',
    vision_base_url TEXT NOT NULL DEFAULT '',
    vision_api_key TEXT NOT NULL DEFAULT '',
    needs_vision INTEGER NOT NULL DEFAULT 1,
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
    -- §9.4 媒体类型：image（默认，老行）| video（画廊视频，原样存、<video> 直接播）
    kind TEXT NOT NULL DEFAULT 'image',
    description TEXT NOT NULL DEFAULT '',
    in_memory INTEGER NOT NULL DEFAULT 1,
    memory_id TEXT NOT NULL DEFAULT '',
    -- §26 私密层：纯界面开关，与 owner（归属）/ in_memory（进记忆）正交。
    -- 1 = 收进「私密」层，公开画廊列表默认不展示（防别人瞥屏），但仍可正常进记忆。
    private INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS harvest_known (
    path TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL DEFAULT '',
    seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS harvest_events (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL DEFAULT 'achievement',
    source_path TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    date_done TEXT NOT NULL DEFAULT '',
    detected_at TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_harvest_events_status ON harvest_events (status);
-- §9.6 通用「功能动态」流：任何独立功能（B站/QQ/游戏…）把小糖人产出的东西推进来，
-- 前端小窝按 feature_id 渲染成卡片。本项目只当中转站，不解释 payload 的内容。
CREATE TABLE IF NOT EXISTS feature_feed (
    id TEXT PRIMARY KEY,
    feature_id TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'note',
    title TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    cover TEXT NOT NULL DEFAULT '',
    payload TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'new',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_feature_feed_scope ON feature_feed (feature_id, status, created_at);
-- §9.6 功能运行记录：在小窝里点了「逛一轮 / 一直逛」时，本体只负责开进程并记一笔，
-- 用来判断「是不是已经在跑了」，避免重复点出一堆进程。真正的逻辑在 features/<folder>/ 里。
CREATE TABLE IF NOT EXISTS feature_runs (
    id TEXT PRIMARY KEY,
    feature_id TEXT NOT NULL,
    command TEXT NOT NULL DEFAULT '',
    pid INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    stopped_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_feature_runs_scope ON feature_runs (feature_id, started_at);
-- §9.6 「主要看什么」：用户给功能写的**方向说明**（人写的，不是功能数据）。
-- 本体只负责存 / 取；意思由功能项目自己解释 —— 目前逛 B站 把它作为最高优先级的口味指引。
CREATE TABLE IF NOT EXISTS feature_directives (
    feature_id TEXT PRIMARY KEY,
    look_for TEXT NOT NULL DEFAULT '',
    avoid TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- §9.6.5 功能设置：功能项目自己声明的**可配置项**（白名单 / 语音 / 表情包 / 小工具…），
-- 值由用户在**前端**改，存在本体这一行里（一功能一行 JSON）。
-- 声明在注册表（代码级资产），值在这里（用户数据）—— 功能拉回去覆盖自己的 config.json。
CREATE TABLE IF NOT EXISTS feature_settings (
    feature_id TEXT PRIMARY KEY,
    data TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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
    conn.execute("DELETE FROM feature_feed WHERE feature_id = 'bilibili_scout'")
    message_cols = {r['name'] for r in conn.execute('PRAGMA table_info(messages)')}
    if 'frames' not in message_cols:
        conn.execute("ALTER TABLE messages ADD COLUMN frames TEXT NOT NULL DEFAULT '[]'")
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(gallery)")}
    if "owner" not in cols:
        # SQLite 的 ADD COLUMN 不接受「NOT NULL 且无默认值」，必须带 DEFAULT。
        # 老行全部落成 ''（= 家共用），不丢数据。
        conn.execute("ALTER TABLE gallery ADD COLUMN owner TEXT NOT NULL DEFAULT ''")
    if "private" not in cols:
        # 私密层（§26）：老行全部落成 0（= 公开），升级后画廊显示不变。
        conn.execute("ALTER TABLE gallery ADD COLUMN private INTEGER NOT NULL DEFAULT 0")
    if "kind" not in cols:
        # 媒体类型（§9.4 画廊视频）：老行全部落成 image（= 图片），行为不变。
        conn.execute("ALTER TABLE gallery ADD COLUMN kind TEXT NOT NULL DEFAULT 'image'")
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

    # 功能 API 配置加视觉路（§9.6）：老库补列并落默认值 —— needs_vision=1（老功能带视觉能力），
    # 其余留空 = 回退「小窝大脑默认」的 vision 配置，所以升级后行为不变。
    ap_cols = {r["name"] for r in conn.execute("PRAGMA table_info(game_api_configs)")}
    for col, ddl in (
        ("vision_model", "ALTER TABLE game_api_configs ADD COLUMN vision_model TEXT NOT NULL DEFAULT ''"),
        ("vision_base_url", "ALTER TABLE game_api_configs ADD COLUMN vision_base_url TEXT NOT NULL DEFAULT ''"),
        ("vision_api_key", "ALTER TABLE game_api_configs ADD COLUMN vision_api_key TEXT NOT NULL DEFAULT ''"),
        ("needs_vision", "ALTER TABLE game_api_configs ADD COLUMN needs_vision INTEGER NOT NULL DEFAULT 1"),
    ):
        if col not in ap_cols:
            conn.execute(ddl)


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
    """把用户从 characters 迁进 profiles（§22）。幂等：跑过一次之后不再有可迁的行。

    只搬档案，**不动聊天记录 / 记忆 / 画廊** —— 会话 id（`single-dalaoda`）、记忆桶
    （`personal/dalaoda`）、画廊归属都以「用户」这个 id 为键，id 不变就全部照旧，
    切回用户身份时历史原样还在。这跟「记忆完全独立于用户视角」是同一条原则。
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

    典型场景：用户的档案是从 characters 抬过来的老数据，里面没有 `relation` 与
    `asCharacter` —— 不补的话，Prompt 里注不进用户身份，其他身份视角下他也不会现身。

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
    from .services import assets
    assets.backup_before_migration(DB_PATH, DATA_DIR)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        conn.executescript(_SCHEMA)
        _migrate(conn)
        # Only a fresh neutral installation needs a generic default assistant.
        from . import theme_feature
        character_seeds = SEED_CHARACTERS
        if not theme_feature.installed() and conn.execute("SELECT 1 FROM characters LIMIT 1").fetchone():
            character_seeds = []
        # 逐条补种：老库也能长出新增的角色（如后来加的小糖人），但已存在的一律不覆盖 ——
        # 用户可能在编辑器里改过，种子不该把改动冲掉。
        conn.executemany(
            "INSERT INTO characters (id, data) VALUES (?, ?) ON CONFLICT(id) DO NOTHING",
            [(c["id"], json.dumps(c, ensure_ascii=False)) for c in character_seeds],
        )
        # 旧部署只补缺失图片键；显式清空或自定义的图片属于用户编辑，保持原样。
        for seed in character_seeds:
            row = conn.execute("SELECT data FROM characters WHERE id = ?", (seed["id"],)).fetchone()
            if row is None:
                continue
            data = json.loads(row["data"])
            missing = {key: seed[key] for key in ("avatar", "portrait") if key in seed and key not in data}
            if missing:
                data.update(missing)
                conn.execute("UPDATE characters SET data = ? WHERE id = ?",
                             (json.dumps(data, ensure_ascii=False), seed["id"]))
        # 用户先从 characters 抬出来（老库升级路径），再补种 profiles。
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
        if tavern_feature.installed():
            tavern_feature.load("seed").initialize(conn)
        assets.preserve_profile_art(conn, DATA_DIR)
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


def delete_character(char_id: str) -> bool:
    """删一个角色档案行。**不做任何级联** —— 会话 / 记忆 / 画廊的清理由 routers 层安排，
    因为那要动文件系统（与 `delete_profile` 同一套分工）。

    注意：种子角色（自家四位小糖人）删了会被下次启动补种回来，判断留给调用方。
    """
    with _tx() as conn:
        cur = conn.execute("DELETE FROM characters WHERE id = ?", (char_id,))
        return bool(cur.rowcount)


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
    """当前正在用的身份 id。缺省（首次启动 / 没设置过）= 用户。"""
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


# ---- 小窝大脑默认 API（§9.6 通用外设接入层）----
#
# 各功能（游戏 / B站 / QQ…）的模型 API 配置分两层：
#   1) 全局默认（这里）：功能没单独配时用它，**默认带视觉路**。
#   2) 每功能独立（game_api_configs 表，见 upsert_game_api_config）：可覆盖任意字段。
# 与普通聊天配置（前端 localStorage 的 xiaotangren.config）**互不影响**。

BRAIN_DEFAULT_KEY = "nest_brain_default"


def get_brain_default() -> dict:
    """全局默认大脑 API。空 dict = 还没配过。"""
    raw = get_settings().get(BRAIN_DEFAULT_KEY, "")
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except (ValueError, TypeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def set_brain_default(data: dict) -> dict:
    merged = {**(get_brain_default()), **(data or {})}
    set_settings({BRAIN_DEFAULT_KEY: json.dumps(merged, ensure_ascii=False)})
    return get_brain_default()


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
        "frames": json.loads(row["frames"] or "[]"),
    }


def append_message(
    session_id: str,
    role: str,
    content: str = "",
    image: str = "",
    image_source: str = "",
    kind: str = "text",
    segments: list[dict] | None = None,
    frames: list[str] | None = None,
    web_sync: bool = False,
) -> dict:
    """追加一条消息，返回落库后的完整记录（含 seq）。"""
    msg_id = f"m-{uuid.uuid4().hex[:12]}"
    seg_json = json.dumps(segments, ensure_ascii=False) if segments else ""
    with _tx() as conn:
        cur = conn.execute(
            "INSERT INTO messages (id, session_id, role, content, image, image_source, kind, segments, frames) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (msg_id, session_id, role, content, image, image_source, kind, seg_json, json.dumps(frames or [])),
        )
        rowid = cur.lastrowid
        if web_sync:
            from .services.qq_web_sync import enqueue
            enqueue(conn, msg_id, session_id)
    return get_message(msg_id)


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
    sql = "SELECT id FROM messages WHERE (image = ? OR EXISTS (SELECT 1 FROM json_each(messages.frames) WHERE value=?))"
    args: list = [orig, orig]
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
        conn.execute("DELETE FROM persona_memory_picks WHERE kind = 'memory' AND ref_id = ?", (mem_id,))
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
        # 清空后身份那边挑中的行也要跟着清，否则会留下指向已消失记忆的孤儿
        conn.execute(
            "DELETE FROM persona_memory_picks WHERE kind = 'memory' "
            "AND ref_id NOT LIKE 'file:%' "
            "AND ref_id NOT IN (SELECT id FROM memories)"
        )
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


def list_memories_missing_vectors(limit: int = 100, engine: str | None = None) -> list[dict]:
    """找不到向量的记忆：从没算出来的（vector 为空），或口径和当前不一致的。

    engine 给了就顺带收「口径过期」的行 —— 换过 embedding 引擎后重建索引用这个。
    """
    sql = "SELECT * FROM memories WHERE vector IS NULL"
    args: list = []
    if engine:
        sql += " OR (engine <> '' AND engine <> ?)"
        args.append(engine)
    sql += " ORDER BY rowid LIMIT ?"
    args.append(max(1, int(limit)))
    with _tx() as conn:
        rows = conn.execute(sql, args).fetchall()
    return [_row_to_memory(r) for r in rows]


# ---- 身份挑选的记忆（我的档案 → 记忆，§22.4）----
# kind='memory' → ref_id 是 memories.id；kind='db' → ref_id 是个人数据库 03 的 .md 相对路径。
# 一张表可能从来没有某个身份的行 —— 那就等于「这个身份一条都没挑」= 默认空。


def list_persona_picks(persona_id: str) -> list[dict]:
    with _tx() as conn:
        rows = conn.execute(
            "SELECT * FROM persona_memory_picks WHERE persona_id = ? ORDER BY enabled DESC, ref_id",
            (persona_id,),
        ).fetchall()
    return [
        {"kind": r["kind"], "ref_id": r["ref_id"], "enabled": bool(r["enabled"]), "updated_at": r["updated_at"]}
        for r in rows
    ]


def set_persona_pick(persona_id: str, kind: str, ref_id: str, enabled: bool) -> dict:
    with _tx() as conn:
        conn.execute(
            "INSERT INTO persona_memory_picks (persona_id, kind, ref_id, enabled) VALUES (?, ?, ?, ?) "
            "ON CONFLICT(persona_id, kind, ref_id) DO UPDATE SET enabled = excluded.enabled, updated_at = datetime('now')",
            (persona_id, kind, ref_id, 1 if enabled else 0),
        )
        row = conn.execute(
            "SELECT * FROM persona_memory_picks WHERE persona_id = ? AND kind = ? AND ref_id = ?",
            (persona_id, kind, ref_id),
        ).fetchone()
    return {"kind": row["kind"], "ref_id": row["ref_id"], "enabled": bool(row["enabled"]), "updated_at": row["updated_at"]}


def delete_persona_pick(persona_id: str, kind: str, ref_id: str) -> bool:
    with _tx() as conn:
        cur = conn.execute(
            "DELETE FROM persona_memory_picks WHERE persona_id = ? AND kind = ? AND ref_id = ?",
            (persona_id, kind, ref_id),
        )
        return bool(cur.rowcount)


# ---- 角色第一次见到用户（first_met）----

def get_message_range(session_id: str) -> tuple[int, str | None]:
    """(条数, 最早一条的时间)；没有消息时时间是 None。"""
    with _tx() as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS n, MIN(created_at) AS first FROM messages WHERE session_id = ?",
            (session_id,),
        ).fetchone()
    return int(row["n"] or 0), row["first"]


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

def upsert_game_api_config(
    game_id: str,
    name: str,
    base_url: str,
    api_key: str,
    model: str,
    vision_model: str = "",
    vision_base_url: str = "",
    vision_api_key: str = "",
    needs_vision: bool = True,
) -> dict:
    cid = f"gapi-{uuid.uuid4().hex[:12]}"
    with _tx() as conn:
        old = conn.execute("SELECT id FROM game_api_configs WHERE game_id=? AND name=?", (game_id, name)).fetchone()
        if old:
            cid = old["id"]
        conn.execute(
            "INSERT INTO game_api_configs (id,game_id,name,base_url,api_key,model,vision_model,"
            "vision_base_url,vision_api_key,needs_vision) VALUES (?,?,?,?,?,?,?,?,?,?) "
            "ON CONFLICT(id) DO UPDATE SET base_url=excluded.base_url,api_key=excluded.api_key,"
            "model=excluded.model,vision_model=excluded.vision_model,vision_base_url=excluded.vision_base_url,"
            "vision_api_key=excluded.vision_api_key,needs_vision=excluded.needs_vision,enabled=1,"
            "updated_at=datetime('now')",
            (cid, game_id, name, base_url, api_key or "", model or "",
             vision_model or "", vision_base_url or "", vision_api_key or "", 1 if needs_vision else 0),
        )
    return get_game_api_config(cid)

def get_game_api_config(config_id: str) -> dict | None:
    with _tx() as conn:
        row = conn.execute("SELECT * FROM game_api_configs WHERE id=?", (config_id,)).fetchone()
    return dict(row) if row else None

def list_game_api_configs(game_id: str) -> list[dict]:
    with _tx() as conn:
        rows = conn.execute("SELECT * FROM game_api_configs WHERE game_id=? AND enabled=1 ORDER BY updated_at DESC", (game_id,)).fetchall()
    return [dict(r) for r in rows]


def delete_game_api_config(config_id: str) -> bool:
    """删掉某功能的独立 API 配置（§9.6：删后回落「小窝大脑默认」）。"""
    with _tx() as conn:
        cur = conn.execute("DELETE FROM game_api_configs WHERE id=?", (config_id,))
        return bool(cur.rowcount)


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


# ---- 功能运行记录（feature_runs，§9.6）----
#
# 只记「本体替用户开过哪个功能的哪个子命令、pid 是多少」—— 判断是否已在跑，别无他用。
# 功能进程自己死了这里不会立刻知道（读的时候用 psutil 探一下 pid 更准）。


def record_feature_run(feature_id: str, command: str, pid: int) -> dict:
    rid = f"run-{uuid.uuid4().hex[:12]}"
    with _tx() as conn:
        conn.execute("INSERT INTO feature_runs (id,feature_id,command,pid) VALUES (?,?,?,?)",
                     (rid, feature_id, command, int(pid or 0)))
    return {"id": rid, "feature_id": feature_id, "command": command, "pid": int(pid or 0)}


def latest_feature_run(feature_id: str) -> dict | None:
    with _tx() as conn:
        row = conn.execute("SELECT * FROM feature_runs WHERE feature_id=? ORDER BY started_at DESC, rowid DESC LIMIT 1",
                           (feature_id,)).fetchone()
    return dict(row) if row else None


def list_feature_runs(limit: int = 8) -> list[dict]:
    """最近几次「本体替功能开了进程」的记录（崩溃日志里用来佐证「炸之前它在干嘛」）。"""
    with _tx() as conn:
        rows = conn.execute("SELECT * FROM feature_runs ORDER BY rowid DESC LIMIT ?",
                            (int(limit),)).fetchall()
    return [dict(r) for r in rows]


def stop_feature_runs(feature_id: str) -> int:
    with _tx() as conn:
        cur = conn.execute("UPDATE feature_runs SET stopped_at=datetime('now') WHERE feature_id=? AND stopped_at=''",
                           (feature_id,))
        return cur.rowcount


# ---- 通用「功能动态」流（feature_feed，§9.6）----
#
# 任何独立功能（B站小糖人刷到的视频 / QQ 里聊到的东西 / 游戏里的高光…）都可以把成果推进来，
# 前端小窝按 feature_id 渲染成卡片。本项目**只当中转站** —— payload 不解释、不校验业务含义。
# 与 agent_messages 的分工：那是 Agent 之间的协议消息，这是**给人看**的产出流。


def _row_to_feed(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"], "feature_id": row["feature_id"], "kind": row["kind"],
        "title": row["title"], "url": row["url"], "summary": row["summary"],
        "cover": row["cover"], "payload": json.loads(row["payload"]),
        "status": row["status"], "created_at": row["created_at"],
    }


def add_feed_item(
    feature_id: str, title: str, kind: str = "note", url: str = "",
    summary: str = "", cover: str = "", payload: dict | None = None,
) -> dict:
    """功能推一条动态。url 相同且在同一个 feature 下 → 覆盖更新（避免重复推同一个视频）。"""
    fid = f"feed-{uuid.uuid4().hex[:12]}"
    with _tx() as conn:
        if url:
            existing = conn.execute(
                "SELECT id FROM feature_feed WHERE feature_id=? AND url=? LIMIT 1", (feature_id, url)
            ).fetchone()
            if existing:
                conn.execute(
                    "UPDATE feature_feed SET title=?, kind=?, summary=?, cover=?, payload=? WHERE id=?",
                    (title, kind or "note", summary, cover, json.dumps(payload or {}, ensure_ascii=False), existing["id"]),
                )
                row = conn.execute("SELECT * FROM feature_feed WHERE id=?", (existing["id"],)).fetchone()
                return _row_to_feed(row)
        conn.execute(
            "INSERT INTO feature_feed (id,feature_id,kind,title,url,summary,cover,payload) VALUES (?,?,?,?,?,?,?,?)",
            (fid, feature_id, kind or "note", title, url, summary, cover, json.dumps(payload or {}, ensure_ascii=False)),
        )
    with _tx() as conn:
        row = conn.execute("SELECT * FROM feature_feed WHERE id=?", (fid,)).fetchone()
    return _row_to_feed(row)


def list_feed_items(feature_id: str | None = None, status: str | None = None, limit: int = 50) -> list[dict]:
    where: list[str] = []
    args: list = []
    if feature_id:
        where.append("feature_id = ?")
        args.append(feature_id)
    if status:
        where.append("status = ?")
        args.append(status)
    clause = f"WHERE {' AND '.join(where)}" if where else ""
    args.append(max(1, min(limit, 200)))
    with _tx() as conn:
        rows = conn.execute(f"SELECT * FROM feature_feed {clause} ORDER BY created_at DESC LIMIT ?", args).fetchall()
    return [_row_to_feed(r) for r in rows]


def update_feed_status(item_id: str, status: str) -> bool:
    with _tx() as conn:
        cur = conn.execute("UPDATE feature_feed SET status=? WHERE id=?", (status, item_id))
        return bool(cur.rowcount)


def delete_feed_item(item_id: str) -> bool:
    with _tx() as conn:
        cur = conn.execute("DELETE FROM feature_feed WHERE id=?", (item_id,))
        return bool(cur.rowcount)


# ---- 「主要看什么」：用户写给功能的方向说明（feature_directives，§9.6）----
#
# 功能自己那套口味画像（例如逛 B站 的 data/taste.json）是**从行为长出来的**，
# 用户想直接说「我要看什么 / 别给我看什么」时没有地方写 —— 这两句就是那个地方。
# 本体只存原文，**不解释**；功能拉回去当最高优先级的口味指引。


def get_feature_directive(feature_id: str) -> dict:
    with _tx() as conn:
        row = conn.execute("SELECT * FROM feature_directives WHERE feature_id=?", (feature_id,)).fetchone()
    if row is None:
        return {"feature_id": feature_id, "look_for": "", "avoid": "", "updated_at": ""}
    return {"feature_id": row["feature_id"], "look_for": row["look_for"],
            "avoid": row["avoid"], "updated_at": row["updated_at"]}


def set_feature_directive(feature_id: str, look_for: str, avoid: str) -> dict:
    with _tx() as conn:
        conn.execute(
            "INSERT INTO feature_directives (feature_id,look_for,avoid,updated_at) VALUES (?,?,?,datetime('now')) "
            "ON CONFLICT(feature_id) DO UPDATE SET look_for=excluded.look_for, avoid=excluded.avoid, "
            "updated_at=datetime('now')",
            (feature_id, look_for, avoid),
        )
    return get_feature_directive(feature_id)


# ---- 功能设置：用户在前端改的那些开关（feature_settings，§9.6.5）----
#
# **为什么值不放在功能的 config.json 里**：功能是独立项目，用户要改白名单 / 音色 /
# 表情包开关，不该被逼去开终端编辑那个文件（中文还会乱码）。所以：
#   - **声明**（有哪些项、什么类型、默认值）写在 features_registry.py —— 跟着功能代码走；
#   - **值**存在这里，一功能一行 JSON，前端改完立刻生效（功能每轮读一次）。
# 本体**不解释**这些字段的业务含义，只保证「读出来是什么样、写回去还是什么样」。


def get_feature_settings(feature_id: str) -> dict:
    with _tx() as conn:
        row = conn.execute("SELECT * FROM feature_settings WHERE feature_id=?", (feature_id,)).fetchone()
    if row is None:
        return {"feature_id": feature_id, "data": {}, "updated_at": ""}
    try:
        data = json.loads(row["data"])
    except (json.JSONDecodeError, TypeError):
        data = {}
    return {"feature_id": feature_id, "data": data if isinstance(data, dict) else {},
            "updated_at": row["updated_at"]}


def set_feature_settings(feature_id: str, data: dict) -> dict:
    """整份覆盖写（前端每次提交的都是它编辑完的完整表单）。"""
    with _tx() as conn:
        conn.execute(
            "INSERT INTO feature_settings (feature_id,data,updated_at) VALUES (?,?,datetime('now')) "
            "ON CONFLICT(feature_id) DO UPDATE SET data=excluded.data, updated_at=datetime('now')",
            (feature_id, json.dumps(data or {}, ensure_ascii=False)),
        )
    return get_feature_settings(feature_id)


# ---- 画廊（gallery，对应《项目要求》§9.4）----
#
# 画廊 = 用户主动保留的重要图片。图片文件仍走 attachments 落盘（这里只存引用 URL），
# description 是这条画廊图的文字描述，也是「照片记忆」A 方案喂给 §9.2 RAG 的正文。
# in_memory=1 时该描述同时是一条家记忆，memory_id 指向它（关掉时删除那条记忆）。


def _row_to_gallery(row: sqlite3.Row) -> dict:
    keys = row.keys()
    return {
        "id": row["id"],
        "session_id": row["session_id"],
        "message_id": row["message_id"],
        "owner": row["owner"],
        "orig": row["orig"],
        "thumb": row["thumb"],
        # 老库若尚未跑过 _migrate，kind 也可能缺失 —— 兜底成 image。
        "kind": row["kind"] if "kind" in keys else "image",
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
    kind: str = "image",
) -> dict | None:
    """收藏一张图 / 一段视频。同一归属下同一张原图重复收藏 → 返回 None（幂等）。

    owner：'' = 家共用，<charId> = 该角色专属。同一张图可以分别存进多个归属。
    private（§26）：1 = 收进私密层（界面默认不展示，与记忆无关）。
    kind（§9.4）：image = 图片（默认） | video = 视频（画廊里用 <video> 播）。
    """
    kind = "video" if (kind or "").lower() == "video" else "image"
    with _tx() as conn:
        existing = conn.execute(
            "SELECT id FROM gallery WHERE orig = ? AND owner = ?", (orig, owner)
        ).fetchone()
        if existing:
            return None
        gid = f"gal-{uuid.uuid4().hex[:12]}"
        conn.execute(
            "INSERT INTO gallery (id, session_id, message_id, owner, orig, thumb, kind, description, "
            "in_memory, memory_id, private) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                gid, session_id, message_id, owner, orig, thumb, kind, description,
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


# ---- 成果巡检（harvest，任务①）----
#
# 后台低频轮询一个「成果」目录，发现新文件就生成一条待确认事件；
# 用户在前端卡片上打勾收录 / 忽略。这里只管事件与「已知文件」的存取，
# 真正的扫描与落盘在 services/harvest.py。


def list_harvest_known() -> list[dict]:
    with _tx() as conn:
        rows = conn.execute("SELECT path, fingerprint FROM harvest_known").fetchall()
    return [{"path": r["path"], "fingerprint": r["fingerprint"]} for r in rows]


def set_harvest_known(path: str, fingerprint: str) -> None:
    with _tx() as conn:
        conn.execute(
            "INSERT INTO harvest_known (path, fingerprint, seen_at) VALUES (?, ?, datetime('now')) "
            "ON CONFLICT(path) DO UPDATE SET fingerprint = excluded.fingerprint, seen_at = excluded.seen_at",
            (path, fingerprint),
        )


def _row_to_event(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "kind": row["kind"],
        "source_path": row["source_path"],
        "title": row["title"],
        "date_done": row["date_done"],
        "detected_at": row["detected_at"],
        "status": row["status"],
        "note": row["note"],
    }


def add_harvest_event(
    kind: str,
    source_path: str,
    title: str,
    date_done: str,
    detected_at: str,
) -> dict | None:
    """记一条待确认事件；同一来源已有 pending 就跳过（幂等，不重复弹卡）。"""
    with _tx() as conn:
        existing = conn.execute(
            "SELECT id FROM harvest_events WHERE source_path = ? AND status = 'pending'",
            (source_path,),
        ).fetchone()
        if existing:
            return None
        eid = f"hv-{uuid.uuid4().hex[:12]}"
        conn.execute(
            "INSERT INTO harvest_events (id, kind, source_path, title, date_done, detected_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (eid, kind, source_path, title, date_done, detected_at),
        )
    return get_harvest_event(eid)


def get_harvest_event(event_id: str) -> dict | None:
    with _tx() as conn:
        row = conn.execute("SELECT * FROM harvest_events WHERE id = ?", (event_id,)).fetchone()
    return _row_to_event(row) if row else None


def list_harvest_events(status: str | None = None, limit: int = 200) -> list[dict]:
    sql = "SELECT * FROM harvest_events"
    args: list = []
    if status:
        sql += " WHERE status = ?"
        args.append(status)
    sql += " ORDER BY detected_at DESC, rowid DESC LIMIT ?"
    args.append(max(1, min(int(limit or 200), 1000)))
    with _tx() as conn:
        rows = conn.execute(sql, args).fetchall()
    return [_row_to_event(r) for r in rows]


def update_harvest_event(
    event_id: str,
    status: str | None = None,
    date_done: str | None = None,
    title: str | None = None,
    note: str | None = None,
) -> bool:
    sets: list[str] = []
    args: list = []
    if status is not None:
        sets.append("status = ?")
        args.append(status)
    if date_done is not None:
        sets.append("date_done = ?")
        args.append(date_done)
    if title is not None:
        sets.append("title = ?")
        args.append(title)
    if note is not None:
        sets.append("note = ?")
        args.append(note)
    if not sets:
        return False
    args.append(event_id)
    with _tx() as conn:
        cur = conn.execute(f"UPDATE harvest_events SET {', '.join(sets)} WHERE id = ?", args)
        return bool(cur.rowcount)


def list_worldbook(*args, **kwargs):
    """Compatibility API; implementation belongs to the optional feature."""
    return getattr(tavern_feature.load("storage"), "list_worldbook")(*args, **kwargs)


def get_worldbook(*args, **kwargs):
    """Compatibility API; implementation belongs to the optional feature."""
    return getattr(tavern_feature.load("storage"), "get_worldbook")(*args, **kwargs)


def create_worldbook(*args, **kwargs):
    """Compatibility API; implementation belongs to the optional feature."""
    return getattr(tavern_feature.load("storage"), "create_worldbook")(*args, **kwargs)


def update_worldbook(*args, **kwargs):
    """Compatibility API; implementation belongs to the optional feature."""
    return getattr(tavern_feature.load("storage"), "update_worldbook")(*args, **kwargs)


def delete_worldbook(*args, **kwargs):
    """Compatibility API; implementation belongs to the optional feature."""
    return getattr(tavern_feature.load("storage"), "delete_worldbook")(*args, **kwargs)
