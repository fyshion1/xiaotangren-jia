"""其他本机呈现端参与本体会话：同一消息库、Prompt、身份与记忆桶。

与 nest/chat 的外设隔离会话不同，这个接口是普通聊天的另一块屏幕。
不返回模型密钥；模型来源由服务端功能配置合并。窗口/触摸逻辑留在外设。
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import uuid

from fastapi import APIRouter, BackgroundTasks, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from .. import db
from ..features_registry import get_feature
from ..providers import openai
from ..services import memory_extract
from .chat import ChatMessage, _resolve_persona, _to_openai_messages
from .nest import _effective_config

router = APIRouter(prefix="/chat/session")
log = logging.getLogger(__name__)
_turn_lock = asyncio.Lock()  # 本机呈现端轮次串行；普通网页仍沿用自己的发送流程。


def resolve_session(character_id: str, mode: str, persona_id: str = "") -> dict:
    chars = db.list_characters()
    by_id = {c["id"]: c for c in chars}
    if character_id not in by_id:
        raise HTTPException(404, "请在小窝桌宠卡片选择一位现有角色")
    pid = persona_id or db.get_active_persona_id() or "dalaoda"
    if not db.get_profile(pid):
        raise HTTPException(404, "当前用户身份不存在")
    if mode == "group":
        try:
            roster = json.loads(db.get_settings().get("group_roster", "[]"))
        except (ValueError, TypeError):
            roster = []
        natives = [c["id"] for c in chars if not c.get("imported") and c["id"] != "dalaoda"]
        picked = [c["id"] for c in chars if isinstance(roster, list) and c["id"] in roster]
        ids = picked or natives or list(by_id)
        sid, title = "group", "小糖人的家（群聊）"
    elif mode == "single":
        ids = [character_id]
        sid, title = f"single-{character_id}", by_id[character_id].get("name", character_id)
    else:
        raise HTTPException(422, "会话只能是私聊或群聊")
    if pid != "dalaoda":
        sid = f"{pid}@{sid}"
    return {"session_id": sid, "character_ids": ids, "persona_id": pid, "mode": mode, "title": title}


def _feature(feature_id: str) -> dict:
    feature = get_feature(feature_id)
    if not feature:
        raise HTTPException(404, "功能未注册")
    return _effective_config(feature_id)


def _ledger() -> None:
    with db._tx() as conn:
        conn.execute("""CREATE TABLE IF NOT EXISTS session_chat_turns (
            request_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
            user_id TEXT NOT NULL DEFAULT '', assistant_id TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'pending')""")


def _get_message(mid: str, sid: str) -> dict | None:
    with db._tx() as conn:
        row = conn.execute("SELECT rowid, * FROM messages WHERE id=? AND session_id=?", (mid, sid)).fetchone()
    return db._row_to_message(row) if row else None


def _append_message(conn, sid: str, role: str, content: str, segments: list | None = None) -> dict:
    """消息与幂等记录使用同一事务，进程意外退出后重试也不会重复写入。"""
    mid = f"m-{uuid.uuid4().hex[:12]}"
    conn.execute(
        "INSERT INTO messages(id,session_id,role,content,kind,segments) VALUES(?,?,?,?,?,?)",
        (mid, sid, role, content, "groups" if segments else "text",
         json.dumps(segments, ensure_ascii=False) if segments else ""),
    )
    row = conn.execute("SELECT rowid,* FROM messages WHERE id=?", (mid,)).fetchone()
    return db._row_to_message(row)


def outbound(row: dict) -> str:
    if row.get("segments"):
        return "\n\n".join(f"**{s.get('speaker', '')}**：{s.get('text', '')}" for s in row["segments"])
    return row.get("content") or ("[图片]" if row.get("image") else "")


@router.get("")
async def session_state(character_id: str, mode: str = "single", feature_id: str = "desktop_pet") -> dict:
    cfg = _feature(feature_id)
    session = resolve_session(character_id, mode)
    return {**session, "items": db.list_messages(session["session_id"], limit=60),
            "configured": bool(cfg.get("base_url") and cfg.get("model"))}


class SessionTurn(BaseModel):
    feature_id: str = Field(default="desktop_pet", max_length=80)
    character_id: str = Field(min_length=1, max_length=120)
    mode: str = "single"
    session_id: str = Field(min_length=1, max_length=240)
    text: str = Field(min_length=1, max_length=16000)
    request_id: str = Field(min_length=8, max_length=120, pattern=r"^[a-zA-Z0-9_-]+$")
    auto_memory: bool = True


async def _extract(turns: list[dict], session: dict, cfg: dict) -> None:
    try:
        await memory_extract.extract(
            messages=turns[-12:], character_ids=session["character_ids"], session_kind=session["mode"],
            name_of={c["id"]: c.get("name", c["id"]) for c in db.list_characters()},
            base_url=cfg["base_url"], api_key=cfg.get("api_key", ""), model=cfg["model"],
            feature_id="",  # 用户明确要求与普通群聊/私聊共享记忆。
        )
    except Exception:
        log.warning("会话记忆提炼未完成；聊天记录已保存")


@router.post("/turn")
async def session_turn(body: SessionTurn, background: BackgroundTasks) -> dict:
    return await _session_turn(body, background)


@router.post("/stream")
async def session_stream(body: SessionTurn):
    background = BackgroundTasks()
    async def events():
        queue = asyncio.Queue(maxsize=128)

        async def produce():
            try:
                result = await _session_turn(body, background, queue.put)
                await queue.put({"type": "done", "result": result})
            except Exception as exc:
                await queue.put({"type": "error", "message": exc.detail if isinstance(exc, HTTPException) else "回复未完成，请重试这一轮"})
            finally:
                await queue.put(None)

        task = asyncio.create_task(produce())
        try:
            while True:
                event = await queue.get()
                if event is None:
                    break
                yield json.dumps(event, ensure_ascii=False) + "\n"
            await task
        finally:
            if not task.done():
                task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    return StreamingResponse(events(), media_type="application/x-ndjson", background=background, headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


async def _session_turn(body: SessionTurn, background: BackgroundTasks, emit=None) -> dict:
    text = body.text.strip()
    if not text:
        raise HTTPException(422, "消息不能为空")
    cfg = _feature(body.feature_id)
    if not cfg.get("base_url") or not cfg.get("model"):
        raise HTTPException(409, "请先在糖人小窝配置大脑 API")
    session = resolve_session(body.character_id, body.mode)
    sid = session["session_id"]
    if body.session_id != sid:
        raise HTTPException(409, "身份或会话已切换，请刷新后重新发送")
    fingerprint = hashlib.sha256(json.dumps([sid, body.feature_id, text], ensure_ascii=False).encode()).hexdigest()
    async with _turn_lock:
        _ledger()
        with db._tx() as conn:
            old = conn.execute("SELECT * FROM session_chat_turns WHERE request_id=?", (body.request_id,)).fetchone()
        if old and old["fingerprint"] != fingerprint:
            raise HTTPException(409, "这次发送编号已用于另一条消息")
        if old and old["assistant_id"]:
            saved = _get_message(old["assistant_id"], sid)
            if not saved:
                raise HTTPException(409, "该轮消息已删除，请作为新消息发送")
            return {**session, "assistant": saved, "replayed": True}
        user = _get_message(old["user_id"], sid) if old and old["user_id"] else None
        with db._tx() as conn:
            if not user:
                user = _append_message(conn, sid, "user", text)
            conn.execute("INSERT INTO session_chat_turns(request_id,session_id,fingerprint,user_id,status) VALUES(?,?,?,?, 'running') "
                         "ON CONFLICT(request_id) DO UPDATE SET user_id=excluded.user_id,status='running'",
                         (body.request_id, sid, fingerprint, user["id"]))
        rows = db.list_messages(sid, limit=60)
        history = [ChatMessage(role=r["role"], content=outbound(r)) for r in rows]
        messages = _to_openai_messages(history, session["character_ids"], persona=_resolve_persona(session["persona_id"]))
        parts = []
        try:
            async for event in openai.stream_chat_retry(messages, cfg["model"], cfg["base_url"], cfg.get("api_key", ""), max_tokens=2048):
                if event["type"] == "text":
                    parts.append(event["text"])
                    if emit:
                        await emit({"type": "delta", "text": event["text"]})
                elif event["type"] == "error":
                    raise RuntimeError("模型暂时未能回复，请稍后重试")
            reply = "".join(parts).strip()
            if not reply:
                raise RuntimeError("模型返回了空回复，请重试")
        except Exception as exc:
            with db._tx() as conn:
                conn.execute("UPDATE session_chat_turns SET status='failed' WHERE request_id=?", (body.request_id,))
            raise HTTPException(502, "回复未完成，已保留你的消息；可重试这一轮") from exc
        segments = []
        if body.mode == "group":
            matches = list(re.finditer(r"\*\*([^*\n]+)\*\*\s*[：:]\s*", reply))
            segments = [{"speaker": m.group(1), "text": reply[m.end():matches[i + 1].start() if i + 1 < len(matches) else len(reply)].strip()}
                        for i, m in enumerate(matches)]
        with db._tx() as conn:
            assistant = _append_message(conn, sid, "assistant", reply, segments)
            conn.execute("UPDATE session_chat_turns SET assistant_id=?,status='done' WHERE request_id=?", (assistant["id"], body.request_id))
        if body.auto_memory:
            background.add_task(_extract, [{"role": r["role"], "content": outbound(r)} for r in [*rows, assistant]], session, cfg)
        return {**session, "user": user, "assistant": assistant, "replayed": False}
