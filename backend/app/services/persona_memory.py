"""「我的档案 → 记忆」：每个身份从 03 里挑哪些长期记忆带进对话（§22.4）。

两个来源，同一个挑选台：
- `kind='memory'` —— 长期记忆池（`memories` 表，日常聊天 / QQ 里聊过、大老大在 02 里收下的结论）。
- `kind='db'`     —— 个人数据库 `03_AI注入层` 下已批准（`review_status: approved`）的条目。

**兜底不存在**：一个身份没挑过的条目就是一条都不带。新身份开出来是空的，
要哪些自己点 —— 宁可暂时「记不起来」，也不要让两个身份混着看到的记忆打架。

三种状态：
- 挑中 + 开  → 强制注入（不参与相关度打分，原样带进 prompt）
- 挑中 + 关  → 不出现（召回结果里也剔掉）
- 没挑中     → 不出现
"""

from __future__ import annotations

from pathlib import Path

from .. import db
from . import self_profile as sp

KIND_MEMORY = "memory"
KIND_DB = "db"
_KINDS = (KIND_MEMORY, KIND_DB)


def db_pool() -> list[dict]:
    """个人数据库 03 里可选（已批准）的条目。"""
    root = sp.external_ai_layer_root()
    items: list[dict] = []
    if not root.is_dir():
        return items
    for p in sorted(root.rglob("*.md")):
        try:
            block = sp.read_external_block(p)
        except (OSError, UnicodeError):
            continue
        if block.get("review_status") != "approved":
            continue
        items.append({
            "ref_id": p.relative_to(root).as_posix(),
            "title": (block.get("title") or p.stem).strip(),
            "content": (block.get("content") or "").strip(),
            "visible_to": block.get("visible_to", "all"),
            "created_at": block.get("created_at", ""),
        })
    return items


def memory_pool() -> list[dict]:
    """长期记忆池（03）：按写入时间倒序。"""
    items = db.list_memories(limit=1000)
    for m in items:
        m.pop("vector", None)
    items.sort(key=lambda m: m.get("created_at") or "", reverse=True)
    return items


def picked_ids(persona_id: str, kind: str) -> dict[str, bool]:
    """{ref_id: enabled} —— 这个身份挑过的条目。"""
    return {p["ref_id"]: p["enabled"] for p in db.list_persona_picks(persona_id) if p["kind"] == kind}


def overview(persona_id: str) -> dict:
    """前端「我的档案」用：两个池子的全量条目 + 当前身份的开关状态。"""
    mem_on = picked_ids(persona_id, KIND_MEMORY)
    db_on = picked_ids(persona_id, KIND_DB)
    return {
        "persona_id": persona_id,
        "memories": [{**m, "picked": m["id"] in mem_on, "enabled": mem_on.get(m["id"], False)}
                     for m in memory_pool()],
        "database": [{**d, "picked": d["ref_id"] in db_on, "enabled": db_on.get(d["ref_id"], False)}
                     for d in db_pool()],
    }


def injectable(persona_id: str, character_ids: list[str]) -> tuple[list[dict], set[str]]:
    """返回 (要强制注入的条目, 要剔除的记忆 id 集合)。

    个人数据库条目走 `visible_to`（按在场角色过滤）；长期记忆不看角色，只按身份开关。
    """
    picks = db.list_persona_picks(persona_id) if persona_id else []
    off = {p["ref_id"] for p in picks if p["kind"] == KIND_MEMORY and not p["enabled"]}
    on_ids = [p["ref_id"] for p in picks if p["kind"] == KIND_MEMORY and p["enabled"]]
    on_db = {p["ref_id"] for p in picks if p["kind"] == KIND_DB and p["enabled"]}

    items: list[dict] = []
    for m_id in on_ids:
        row = db.get_memory(m_id)
        if row is None:  # 记忆被删了：开关留着也没用，跳过
            continue
        row.pop("vector", None)
        items.append({**row, "title": ""})
    if on_db:
        root = sp.external_ai_layer_root()
        for entry in db_pool():
            if entry["ref_id"] not in on_db:
                continue
            path: Path = root / entry["ref_id"]
            try:
                block = sp.read_external_block(path)
            except (OSError, UnicodeError):
                continue
            if not sp.is_visible(block.get("visible_to", "all"), character_ids):
                continue
            items.append({**entry, "id": f"db:{entry['ref_id']}", "created_at": entry.get("created_at", "")})
    items.sort(key=lambda b: b.get("created_at") or "")
    return items, off


def set_pick(persona_id: str, kind: str, ref_id: str, enabled: bool) -> dict:
    if kind not in _KINDS:
        raise ValueError("kind 只能是 memory / db")
    ref_id = (ref_id or "").strip()
    if not ref_id:
        raise ValueError("ref_id 不能为空")
    if kind == KIND_MEMORY and db.get_memory(ref_id) is None:
        raise LookupError("没有这条记忆")
    if kind == KIND_DB and ref_id not in {d["ref_id"] for d in db_pool()}:
        raise LookupError("个人数据库 03 里没有这条已批准的条目")
    return db.set_persona_pick(persona_id, kind, ref_id, enabled)
