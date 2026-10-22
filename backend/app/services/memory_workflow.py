"""文件是真源：原始对话 → 待审核 → 人工批准的关系记忆。

SQLite 只用于旧记录和可重建向量索引；本模块不把候选当成正式记忆。
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import uuid
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timezone, timedelta
from pathlib import Path

from .. import db

ROOT = Path(__file__).resolve().parents[3] / "个人记忆库"
SOURCE = "01_源记忆"
WORK = "02_AI记忆处理层"
LONG = "03_长期记忆池"
CATEGORIES = {"experience": "共同经历", "bond": "羁绊", "promise": "约定", "vision": "长期愿景"}
STATES = {"active", "completed", "paused", "cancelled", "expired"}
_lock = threading.RLock()
_store_root = ContextVar('memory_workflow_store', default=None)


@contextmanager
def isolated_store(directory: Path):
    """Reuse the file workflow without changing the app store or its picks.

    Only trusted host services choose this path. Context-local, including when
    copied to worker threads; never change process environment/global ROOT.
    """
    token = _store_root.set(Path(directory).resolve())
    try:
        yield
    finally:
        _store_root.reset(token)


def root() -> Path:
    return _store_root.get() or Path(os.getenv("PERSONAL_MEMORY_ROOT", str(ROOT))).resolve()


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def document(raw: str) -> tuple[dict, str]:
    """读取本模块 JSON 标量 frontmatter，也兼容已有简单 YAML 字段。"""
    match = re.match(r"\A\ufeff?---\r?\n(.*?)\r?\n---(?:\r?\n|$)", raw, re.S)
    if not match:
        return {}, raw
    meta = {}
    for line in match[1].splitlines():
        key, sep, value = line.partition(":")
        if not sep:
            continue
        value = value.strip()
        try:
            meta[key.strip()] = json.loads(value)
        except ValueError:
            meta[key.strip()] = value.strip("\"'")
    return meta, raw[match.end():]


def serialize(meta: dict, text: str) -> str:
    return "---\n" + "\n".join(f"{k}: {json.dumps(v, ensure_ascii=False)}" for k, v in meta.items()) + "\n---\n" + text.strip() + "\n"


def write(path: Path, meta: dict, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(f".{uuid.uuid4().hex}.tmp")
    temp.write_text(serialize(meta, text), encoding="utf-8")
    os.replace(temp, path)


def initialize() -> None:
    for folder in (SOURCE, f"{WORK}/待审核", f"{WORK}/已拒绝", f"{WORK}/已处理", LONG, "01_清洗层", ".versions"):
        (root() / folder).mkdir(parents=True, exist_ok=True)


def merge(persona_id: str, records: list[dict]) -> dict:
    if len(records) < 2:
        raise ValueError("至少选择两条待审核候选")
    with _lock:
        items = [get(r["id"])[1] for r in records]
        if len({m["id"] for m in items}) != len(items):
            raise ValueError("不能重复选择同一条候选")
        for item, record in zip(items, records):
            if item["persona_id"] != persona_id:
                raise PermissionError("不能合并其他身份的记忆")
            if item["revision"] != record["revision"] or item["review_status"] != "pending":
                raise RuntimeError("候选已修改或已审核，请刷新")
            if (item["scope"], sorted(item["character_ids"]), item.get("feature_id", "")) != (
                    items[0]["scope"], sorted(items[0]["character_ids"]), items[0].get("feature_id", "")):
                raise ValueError("只能合并可见范围和功能归属相同的候选")
        result = propose("\n".join(m["text"] for m in items), persona_id, items[0]["character_ids"],
                         category=items[0]["category"], scope=items[0]["scope"],
                         feature_id=items[0].get("feature_id", ""),
                         source="；".join(m["source"] for m in items),
                         evidence=[e for m in items for e in m.get("evidence", [])])
        for item in items:
            review(item["id"], persona_id, "archive", {}, item["revision"])
        return result


def archive_history(persona_id: str) -> int:
    with db._tx() as conn:
        if persona_id == "dalaoda":
            rows = conn.execute("SELECT rowid,* FROM messages WHERE instr(session_id,'@')=0 AND session_id!='gemini-test'").fetchall()
        else:
            rows = conn.execute("SELECT rowid,* FROM messages WHERE substr(session_id,1,?)=?",
                                (len(persona_id) + 1, persona_id + "@")).fetchall()
    sessions: dict[str, list[dict]] = {}
    for row in rows:
        saved = db._row_to_message(row)
        sessions.setdefault(saved['session_id'], []).append(saved)
    for session, messages in sessions.items():
        archive_source(messages, persona_id, session, [])
    return len(rows)


def _files(layer: str) -> list[Path]:
    base = root() / layer
    return sorted(p for p in base.rglob("*.md") if p.resolve().is_relative_to(root()) and not p.is_symlink()) if base.is_dir() else []


def _item(path: Path) -> dict:
    meta, text = document(path.read_text(encoding="utf-8-sig"))
    if (meta.get('review_status') == 'pending' and meta.get('expires_at')
            and not meta.get('user_edited') and not meta.get('keep_pending')):
        try:
            if datetime.fromisoformat(meta['expires_at']) <= datetime.now(timezone.utc):
                meta['review_status'] = 'expired'
                meta['inject'] = False
        except (ValueError, TypeError):
            pass
    return {**meta, "text": text.strip(), "path": path.relative_to(root()).as_posix(),
            "revision": hashlib.sha256(path.read_bytes()).hexdigest()}


def list_items(persona_id: str, layer: str | None = None) -> list[dict]:
    out = []
    paths = _files(layer) if layer else _files(WORK) + _files(LONG)
    for path in paths:
        item = _item(path)
        if item.get("id") and item.get("persona_id") == persona_id:
            if layer is not None or item.get('review_status') != 'approved':
                out.append(item)
    return sorted(out, key=lambda m: m.get("updated_at", m.get("created_at", "")), reverse=True)


def get(item_id: str) -> tuple[Path, dict]:
    if not re.fullmatch(r"[a-zA-Z0-9_-]{1,100}", item_id):
        raise ValueError("记忆编号无效")
    for layer in (LONG, WORK):
        for path in _files(layer):
            item = _item(path)
            if item.get("id") == item_id:
                return path, item
    raise LookupError("记忆不存在")


def archive_source(messages: list[dict], persona_id: str, session_id: str, character_ids: list[str], feature_id: str = "") -> str:
    from .memory_sources import archive
    initialize()
    return archive(messages, persona_id, session_id, feature_id)


def propose(text: str, persona_id: str, character_ids: list[str], *, category: str = "experience",
            scope: str = "personal", source: str = "", session_id: str = "", feature_id: str = "",
            evidence: list[dict] | None = None, legacy_id: str = "", details: str = "",
            occurred_at: str = "", event_key: str = "", aliases: dict | None = None,
            automatic: bool = False) -> dict:
    from .memory_sources import timestamp
    text = text.strip()
    if not text or len(text) > 6000:
        raise ValueError("候选记忆须为 1～6000 字")
    if not persona_id:
        raise ValueError("需要明确用户身份")
    if category not in CATEGORIES or scope not in {"personal", "shared"}:
        raise ValueError("记忆类型或范围无效")
    if scope == "personal" and not character_ids:
        raise ValueError("私密记忆至少需要一位相关角色")
    initialize()
    with _lock:
        # 只对相同身份、角色、命名空间、内容去重，不跨身份复用候选。
        key = hashlib.sha256(json.dumps([persona_id, sorted(character_ids), scope, feature_id, text, event_key], ensure_ascii=False).encode()).hexdigest()
        for item in list_items(persona_id, WORK) + list_items(persona_id, LONG):
            if item.get("fingerprint") == key:
                if not automatic and item.get('automatic') and item['review_status'] == 'pending':
                    path, item = get(item['id'])
                    meta = {k:v for k,v in item.items() if k not in {'text', 'path', 'revision'}}
                    write(path, {**meta, 'keep_pending': True, 'user_edited': True}, item['text'])
                    return _item(path)
                return item
        item_id = "mw-" + uuid.uuid4().hex[:20]
        meta = {"id": item_id, "persona_id": persona_id, "character_ids": character_ids,
                "category": category, "scope": scope, "state": "active", "review_status": "pending",
                "source": source, "session_id": session_id, "feature_id": feature_id,
                "evidence": evidence or [], "legacy_id": legacy_id, "fingerprint": key,
                "details": details, "occurred_at": timestamp(occurred_at or now()), "event_key": event_key,
                "aliases": aliases or {}, "redact": False, "user_edited": False, "allow_injection": True,
                "created_at": now(), "updated_at": now(), "inject": False, "core": False}
        from .activity_memory import item_sources
        meta['source_feature_ids'] = item_sources(meta)
        if automatic:
            meta.update(automatic=True, expires_at=(datetime.now(timezone.utc) + timedelta(hours=24)).isoformat())
        path = root() / LONG / "待审核" / f"{item_id}.md"
        write(path, meta, text)
        return _item(path)


def review(item_id: str, persona_id: str, action: str, changes: dict, revision: str) -> dict:
    with _lock:
        path, item = get(item_id)
        if item["persona_id"] != persona_id:
            raise PermissionError("不能操作其他身份的记忆")
        if revision != item["revision"]:
            raise RuntimeError("记忆已修改，请刷新后重新审核")
        if action in {'approve', 'save', 'keep', 'restore'}:
            from .memory_integration import replaced_ids
            if item_id in replaced_ids(persona_id):
                raise RuntimeError('该短句已由批准的事件草稿替代，请刷新查看')
        if action not in {"save", "approve", "reject", "archive", "keep", "restore"}:
            raise ValueError("未知审核动作")
        if action == 'restore' and item.get('review_status') != 'expired':
            raise ValueError('只有过期候选可以恢复')
        if action == 'keep' and item.get('review_status') != 'pending':
            raise ValueError('只有待审核候选可以保留待审')
        if action == 'save' and item.get('review_status') == 'expired':
            raise ValueError('请先恢复过期候选')
        text = str(changes.get("text", item["text"])).strip()
        if not text or len(text) > 6000:
            raise ValueError("记忆正文须为 1～6000 字")
        meta = {k: v for k, v in item.items() if k not in {"text", "path", "revision"}}
        for key in ("category", "scope", "character_ids", "state", "core", "inject", "details", "occurred_at", "redact", "aliases"):
            if key in changes:
                meta[key] = changes[key]
        if not isinstance(meta.get('details', ''), str) or len(meta.get('details', '')) > 5000:
            raise ValueError('事件详情须为 5000 字以内的文本')
        if not isinstance(meta.get('redact', False), bool) or not isinstance(meta.get('aliases', {}), dict):
            raise ValueError('脱敏设置无效')
        if not all(isinstance(k, str) and k and isinstance(v, str) and v for k, v in meta.get('aliases', {}).items()):
            raise ValueError('脱敏映射应为姓名与替代称呼')
        from .memory_sources import timestamp
        meta['occurred_at'] = timestamp(str(meta.get('occurred_at') or item['created_at']))
        if 'inject' in changes:
            meta['allow_injection'] = bool(changes['inject'])
        if action == 'save' or action == 'approve':
            meta['user_edited'] = True
        if meta["category"] not in CATEGORIES or meta["scope"] not in {"personal", "shared"} or meta["state"] not in STATES:
            raise ValueError("类型、范围或约定状态无效")
        if (not isinstance(meta["character_ids"], list) or not all(isinstance(cid, str) for cid in meta["character_ids"])
                or (meta["scope"] == "personal" and not meta["character_ids"])):
            raise ValueError("私密记忆必须指定相关角色")
        if not isinstance(meta["core"], bool) or not isinstance(meta["inject"], bool):
            raise ValueError("开关值无效")
        if action == "approve" and item.get("review_status") != "pending":
            raise ValueError("只有待审核候选可以批准")
        if action == 'approve' and item.get('integration_records'):
            from .memory_integration import validate
            validate(persona_id, item['integration_records'])
        if (action == "approve" or item.get("review_status") == "approved") and len(text) + len(meta.get('details', '')) > 1600:
            raise ValueError("正式记忆请精简到 1600 字以内，详细原文保留在 01/02")
        if action == "reject" and item.get("review_status") != "pending":
            raise ValueError("只有待审核候选可以拒绝")
        # 正式文件每次编辑都有快照。正文更新保留原始证据。
        write(root() / ".versions" / item_id / f"{uuid.uuid4().hex}.md", {k: v for k, v in item.items() if k not in {"text", "path", "revision"}}, item["text"])
        target = path
        if action == "approve":
            meta.update(review_status="approved", reviewed_at=now(), reviewed_by=persona_id,
                        inject=bool(changes.get("inject", True)), core=bool(changes.get("core", False)))
            if item.get('integration_records'):
                meta['replacement_committed'] = True
            target = root() / LONG / CATEGORIES[meta["category"]] / f"{item_id}.md"
        elif action in {"reject", "archive"}:
            meta.update(review_status="rejected" if action == "reject" else "archived", inject=False)
            target = root() / WORK / ("已拒绝" if action == "reject" else "已处理") / f"{item_id}.md"
        elif action in {'keep', 'restore'}:
            meta.update(review_status='pending', keep_pending=True, inject=False)
        elif item.get("review_status") != "approved":
            meta["inject"] = False
        meta["updated_at"] = now()
        write(target, meta, text)
        if target != path:
            path.unlink()
        if action == "approve" and _store_root.get() is None:
            db.set_persona_pick(persona_id, "memory", "file:" + item_id, bool(meta["inject"]))
        return _item(target)


def injection_text(item: dict) -> str:
    text = item['text'] + ('\n' + item['details'] if item.get('details') else '')
    if item.get('redact'):
        for name, alias in sorted(item.get('aliases', {}).items(), key=lambda pair: -len(pair[0])):
            text = text.replace(name, alias)
    return '[' + str(item.get('occurred_at') or item.get('created_at', ''))[:13].replace('T', ' ') + '时] ' + text


def approved(persona_id: str) -> list[dict]:
    all_items = list_items(persona_id, LONG) + list_items(persona_id, WORK)
    replaced = {r['id']: m['id'] for m in all_items if m.get('replacement_committed')
                for r in m.get('integration_records', [])}
    return [{**m, 'summary': m['text'], 'text': injection_text(m), "id": "file:" + m["id"],
             'superseded_by': replaced.get(m['id'], ''),
             "bucket": "home" if m["scope"] == "shared" else "personal",
             "char_id": (m.get("character_ids") or [""])[0], "source": m.get("source", "")}
            for m in list_items(persona_id, LONG) if m.get("review_status") == "approved"]


def visible(item: dict, persona_id: str, character_ids: list[str], feature_id: str = "") -> bool:
    from .activity_memory import memory_visible
    return (item.get("persona_id") == persona_id and item.get("review_status") == "approved"
            and not item.get('superseded_by') and memory_visible(item)
            and bool(item.get("inject")) and item.get("feature_id", "") == feature_id
            and (item.get("scope") == "shared" or bool(set(item.get("character_ids", [])) & set(character_ids)))
            and item.get("state", "active") not in {"cancelled", "expired", "paused"})


def propose_fact(text: str, persona_id: str, source: str, evidence: list[dict]) -> dict:
    from .self_profile import external_ai_layer_root
    database = external_ai_layer_root().parent
    key = hashlib.sha256(json.dumps([persona_id, text], ensure_ascii=False).encode()).hexdigest()[:24]
    target = database / "02_AI工作层" / "待确认" / f"chat-fact-{key}.md"
    with _lock:
        if not target.exists():
            write(target, {"title": text[:32], "persona_id": persona_id, "source": "个人记忆库/" + source,
                           "evidence": evidence, "review_status": "pending", "inject": False,
                           "status": "draft", "visible_to": "all", "created_at": now()}, text)
    return {"path": target.relative_to(database).as_posix(), "text": text}


def fact_candidates(persona_id: str) -> list[dict]:
    from .self_profile import external_ai_layer_root
    database = external_ai_layer_root().parent
    base = database / "02_AI工作层"
    items = []
    if base.is_dir():
        for path in base.rglob("*.md"):
            if not path.resolve().is_relative_to(database.resolve()) or path.is_symlink():
                continue
            meta, text = document(path.read_text(encoding="utf-8-sig"))
            if meta.get("review_status") == "pending" and meta.get("persona_id") == persona_id:
                items.append({**meta, "text": text, "path": path.relative_to(database).as_posix()})
    return items
