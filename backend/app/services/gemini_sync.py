"""仅同步用户主动打开的 Gemini 网页文字，不调用模型或记忆服务。"""
from __future__ import annotations

import hashlib
import json
import re
import secrets
import threading

from .. import db

SESSION_ID = "gemini-test"
_token_lock = threading.Lock()


def pairing_token() -> str:
    with _token_lock:
        path = db.DATA_DIR / "gemini-sync.token"
        path.parent.mkdir(parents=True, exist_ok=True)
        if not path.exists():
            path.write_text(secrets.token_urlsafe(32), encoding="utf-8")
        return path.read_text(encoding="utf-8").strip()


def segment_reply(text: str) -> list[dict]:
    names = {c["name"] for c in db.list_characters()}
    # 只接受实际角色名；说明标题不能被误判成角色。
    pattern = re.compile(r"^\s*(?:\*\*(.+?)\*\*|【(.+?)】|([^：:\n]{1,40}))\s*[：:]?\s*(.*)$")
    segments: list[dict] = []
    speaker = ""
    lines: list[str] = []
    for line in text.splitlines():
        match = pattern.match(line)
        name = next((v for v in match.groups()[:3] if v), "").strip().rstrip("：:") if match else ""
        if name not in names and match:
            # Gemini 常用 emoji + 身份修饰 + 角色名，括号中的补充不属于角色名。
            label = re.split(r"[（(]", name, maxsplit=1)[0].strip()
            decorated = bool(re.match(r"^[^\w\u4e00-\u9fff]|^#{1,6}\s", label))
            candidates = [n for n in names if label.endswith(n)]
            if decorated and len(candidates) == 1 and len(label) <= 30:
                name = candidates[0]
        if name in names:
            if lines:
                segments.append({"speaker": speaker, "text": "\n".join(lines).strip()})
            speaker, lines = name, [match.group(4)]
        else:
            lines.append(line)
    if lines:
        segments.append({"speaker": speaker, "text": "\n".join(lines).strip()})
    return [s for s in segments if s["text"]]


def clean_user_text(text: str) -> str:
    """仅移除已确认的网页署名重复；不合并用户正文中主动重复的句子。"""
    match = re.match(r"^\s*(?:You said|你说|您说)[：:]?\s+([\s\S]*)$", text)
    if not match:
        return text
    content = match.group(1).strip()
    parts = content.split("\n\n", 1)
    if len(parts) == 2 and parts[0].strip() == parts[1].strip():
        return parts[1].strip()
    return content


def reprocess_existing() -> int:
    """从来源原文重建显示格式，不改变消息 ID、时间或顺序。"""
    with db._tx() as conn:
        rows = conn.execute("SELECT m.id,m.role,s.raw_content FROM messages m JOIN gemini_sync_messages s ON m.id=s.message_id WHERE m.session_id=?", (SESSION_ID,)).fetchall()
    parsed = []
    for row in rows:
        content = clean_user_text(row["raw_content"]) if row["role"] == "user" else row["raw_content"]
        segments = segment_reply(content) if row["role"] == "assistant" else []
        parsed.append((content, "groups" if any(s["speaker"] for s in segments) else "text", json.dumps(segments, ensure_ascii=False), row["id"]))
    with db._tx() as conn:
        conn.executemany("UPDATE messages SET content=?,kind=?,segments=? WHERE id=? AND session_id='gemini-test'", parsed)
    return len(parsed)


def sync_messages(conversation_id: str, messages: list[dict]) -> dict:
    # 一次事务内完成映射及消息更新，刷新/重试不会新增重复消息。
    created = updated = 0
    parsed = [(m, segment_reply(m["content"]) if m["role"] == "assistant" else []) for m in messages]
    with db._tx() as conn:
        for message, segments in parsed:
            mid = "gemini-" + hashlib.sha256(f"{conversation_id}:{message['id']}".encode()).hexdigest()[:32]
            exists = conn.execute("SELECT id FROM messages WHERE id=?", (mid,)).fetchone()
            conn.execute(
                "INSERT INTO messages (id,session_id,role,content,kind,segments) VALUES (?,?,?,?,?,?) "
                "ON CONFLICT(id) DO UPDATE SET role=excluded.role,content=excluded.content,kind=excluded.kind,segments=excluded.segments",
                (mid, SESSION_ID, message["role"], clean_user_text(message["content"]) if message["role"] == "user" else message["content"], "groups" if any(s["speaker"] for s in segments) else "text", json.dumps(segments, ensure_ascii=False)),
            )
            conn.execute(
                "INSERT INTO gemini_sync_messages (conversation_id,source_message_id,message_id,raw_content,complete) VALUES (?,?,?,?,?) "
                "ON CONFLICT(conversation_id,source_message_id) DO UPDATE SET raw_content=excluded.raw_content,complete=excluded.complete,updated_at=datetime('now')",
                (conversation_id, message["id"], mid, message["content"], int(message.get("complete", False))),
            )
            created += int(not exists)
            updated += int(bool(exists))
    return {"session_id": SESSION_ID, "created": created, "updated": updated, "memory_enabled": False}
