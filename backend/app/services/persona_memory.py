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
from . import memory_workflow as workflow

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
            "inject": block.get("inject", False),
            "persona_id": workflow.document(p.read_text(encoding="utf-8-sig"))[0].get("persona_id", ""),
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
                     for m in workflow.approved(persona_id)],
        "legacy": [{**m, "review_status": "legacy", "picked": m["id"] in mem_on,
                    "enabled": mem_on.get(m["id"], False)} for m in memory_pool()],
        "database": [{**d, "picked": d["ref_id"] in db_on, "enabled": db_on.get(d["ref_id"], False)}
                     for d in db_pool() if not d.get("persona_id") or d["persona_id"] == persona_id],
    }


def injectable(persona_id: str, character_ids: list[str], query: str = "", *, allow_embeddings: bool = True) -> tuple[list[dict], set[str]]:
    """返回 (要强制注入的条目, 要剔除的记忆 id 集合)。

    个人数据库条目走 `visible_to`（按在场角色过滤）；长期记忆不看角色，只按身份开关。
    """
    picks = db.list_persona_picks(persona_id) if persona_id else []
    off = {p["ref_id"] for p in picks if p["kind"] == KIND_MEMORY and not p["enabled"]}
    on_ids = [p["ref_id"] for p in picks if p["kind"] == KIND_MEMORY and p["enabled"]]
    on_db = {p["ref_id"] for p in picks if p["kind"] == KIND_DB and p["enabled"]}

    items: list[dict] = []
    candidates: list[dict] = []
    approved = {m["id"]: m for m in workflow.approved(persona_id)}
    for m_id in on_ids:
        if m_id.startswith("file:"):
            row = approved.get(m_id)
            if row and workflow.visible(row, persona_id, character_ids):
                row = {**row, "title": "", "injection_reason": "core" if row.get("core") else "related"}
                if row.get("core"):
                    items.append(row)
                else:
                    candidates.append(row)
            continue
        row = db.get_memory(m_id)
        if row is None:  # 记忆被删了：开关留着也没用，跳过
            continue
        # 旧库不会自动升级成已批准条目；保留旧记录供用户迁移审核。
    if on_db:
        root = sp.external_ai_layer_root()
        for entry in db_pool():
            if entry["ref_id"] not in on_db:
                continue
            if entry.get("persona_id") and entry["persona_id"] != persona_id:
                continue
            path: Path = root / entry["ref_id"]
            try:
                block = sp.read_external_block(path)
            except (OSError, UnicodeError):
                continue
            if not sp.is_visible(block.get("visible_to", "all"), character_ids):
                continue
            if not block.get("inject"):
                continue
            items.append({**entry, "id": f"db:{entry['ref_id']}", "created_at": entry.get("created_at", "")})
    if candidates:
        from .memory_retrieval import rank
        items.extend(rank(candidates, query) if allow_embeddings else rank(candidates, query, allow_embeddings=False))
    items.sort(key=lambda b: b.get("created_at") or "", reverse=True)
    items.sort(key=lambda b: (not bool(b.get("core")), -float(b.get("score", 0))))
    # 每类最多 1600 字符，并共享 2400 字符正文预算；文件全文不变。
    selected, sizes = [], {"db": 0, "memory": 0}
    for item in items:
        kind = "db" if item["id"].startswith("db:") else "memory"
        size = len(item.get("text") or item.get("content") or "")
        if sizes[kind] + size <= 1600 and sum(sizes.values()) + size <= 2400:
            selected.append(item)
            sizes[kind] += size
    return selected, off


def set_pick(persona_id: str, kind: str, ref_id: str, enabled: bool) -> dict:
    if kind not in _KINDS:
        raise ValueError("kind 只能是 memory / db")
    ref_id = (ref_id or "").strip()
    if not ref_id:
        raise ValueError("ref_id 不能为空")
    if kind == KIND_MEMORY:
        if ref_id.startswith("file:"):
            if ref_id not in {m["id"] for m in workflow.approved(persona_id)}:
                raise LookupError("没有这条已批准记忆")
            _, item = workflow.get(ref_id.removeprefix("file:"))
            workflow.review(item["id"], persona_id, "save", {"inject": enabled}, item["revision"])
        elif db.get_memory(ref_id) is None:
            raise LookupError("没有这条记忆")
        elif enabled:
            raise ValueError("历史记忆请先转入待审核并批准，再用于对话")
    if kind == KIND_DB and ref_id not in {d["ref_id"] for d in db_pool()
                                        if not d.get("persona_id") or d["persona_id"] == persona_id}:
        raise LookupError("个人数据库 03 里没有这条已批准的条目")
    return db.set_persona_pick(persona_id, kind, ref_id, enabled)
