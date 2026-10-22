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
from typing import Literal

from fastapi import APIRouter, BackgroundTasks, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from .. import db
from ..features_registry import get_feature
from ..providers import openai
from ..services import media_context, conversation_runtime
from ..services.upstream_diagnostics import upstream_accessibility, _upstream_reason
from ..services import agent_tools, memory_extract
from .chat import ChatMessage, _resolve_persona, _to_openai_messages, apply_card_display_mode
from .nest import _effective_config
from ..services.turn_coordinator import turn as coordinated_turn

router = APIRouter(prefix="/chat/session")
log = logging.getLogger(__name__)
_turn_lock = asyncio.Lock()  # 保留旧测试兼容；实际跨端串行由数据库 turn_coordinator 管理。


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


def _save_voice_prefix(sid: str, request_id: str, voice, status: str) -> dict | None:
    """Settle audio already confirmed by the browser, never the unheard suffix."""
    delivered = voice.delivered_text.strip() if voice is not None else ''
    assistant = None
    with db._tx() as conn:
        if delivered:
            assistant = _append_message(conn, sid, 'assistant', delivered + '\n（语音被打断）')
        conn.execute("UPDATE session_chat_turns SET status=?,assistant_id=? WHERE request_id=?",
                     (status, assistant['id'] if assistant else '', request_id))
    return assistant


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
    memory_model: str = Field(default='', max_length=240)
    persona_id: str = Field(default="", max_length=120)
    images: list[str] = Field(default_factory=list, max_length=10)
    attachment: str = Field(default="", max_length=500)
    saved_user_id: str = ''
    base_url: str = ''
    api_key: str = ''
    model: str = ''
    max_tokens: int | None = None
    uncensored: bool = False
    card_display_mode: Literal['chat', 'html'] | None = None
    history_end_id: str = ''


async def _extract(turns: list[dict], session: dict, cfg: dict) -> None:
    try:
        from ..services.activity_memory import policy
        state = policy(session['persona_id'], session.get('source_feature_id', 'core'))
        if not state['receive'] or not state['organize']:
            return
        await memory_extract.extract(
            messages=turns[-12:], character_ids=session["character_ids"], session_kind=session["mode"],
            name_of={c["id"]: c.get("name", c["id"]) for c in db.list_characters()},
            base_url=cfg["base_url"], api_key=cfg.get("api_key", ""), model=cfg["model"],
            feature_id="",  # 用户明确要求与普通群聊/私聊共享记忆。
            persona_id=session["persona_id"], session_id=session["session_id"],
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


async def _session_turn(body: SessionTurn, background: BackgroundTasks, emit=None, voice=None) -> dict:
    session = resolve_session(body.character_id, body.mode, body.persona_id)
    async with conversation_runtime.monitor(session, body.request_id, body.feature_id, emit) as progress:
        progress.event('received', {'text': body.text, 'images': body.images, 'attachment': body.attachment})
        return await _run_session_turn(body, background, emit, voice, progress)


async def _run_session_turn(body: SessionTurn, background: BackgroundTasks, emit=None, voice=None, progress=None) -> dict:
    text = body.text.strip()
    if not text:
        raise HTTPException(422, "消息不能为空")
    if body.feature_id == 'core':
        from ..config import get_settings
        defaults = get_settings()
        cfg = {'base_url': body.base_url or defaults.model_base_url, 'api_key': body.api_key or defaults.model_api_key,
               'model': body.model or defaults.model_chat}
    else:
        cfg = _feature(body.feature_id)
    if not cfg.get("base_url") or not cfg.get("model"):
        raise HTTPException(409, "请先在糖人小窝配置大脑 API")
    session = resolve_session(body.character_id, body.mode, body.persona_id)
    session['source_feature_id'] = body.feature_id
    sid = session["session_id"]
    if body.session_id != sid:
        raise HTTPException(409, "身份或会话已切换，请刷新后重新发送")
    if any(not url.startswith("/api/files/") for url in [*body.images, *([body.attachment] if body.attachment else [])]):
        raise HTTPException(422, "图片必须是已保存的本地附件引用")
    fingerprint_parts = [sid, body.feature_id, text]
    if body.card_display_mode:
        fingerprint_parts.append(body.card_display_mode)
    if body.saved_user_id:
        fingerprint_parts.extend([body.saved_user_id, body.history_end_id, body.model, body.base_url, body.uncensored, body.max_tokens, body.card_display_mode])
    if body.images:
        fingerprint_parts.append(body.images)
    if body.attachment:
        fingerprint_parts.append(body.attachment)
    fingerprint = hashlib.sha256(json.dumps(fingerprint_parts, ensure_ascii=False).encode()).hexdigest()
    async with coordinated_turn(session['persona_id'], session['character_ids']):
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
        if not user and body.saved_user_id:
            user = _get_message(body.saved_user_id, sid)
            if not user or user['role'] != 'user' or user['content'] != text:
                raise HTTPException(409, '原始用户消息不存在或已修改')
        with db._tx() as conn:
            if not user:
                user = _append_message(conn, sid, "user", text)
                if body.images or body.attachment:
                    image = body.attachment or body.images[0]
                    conn.execute("UPDATE messages SET image=?, frames=? WHERE id=?",
                                 (image, json.dumps(body.images), user["id"]))
                    user = {**user, "image": image, "frames": body.images}
            if body.feature_id in ('core', 'desktop_pet') and voice is None:
                from ..services.qq_web_sync import enqueue
                enqueue(conn, user['id'], sid)
            conn.execute("INSERT INTO session_chat_turns(request_id,session_id,fingerprint,user_id,status) VALUES(?,?,?,?, 'running') "
                         "ON CONFLICT(request_id) DO UPDATE SET user_id=excluded.user_id,status='running'",
                         (body.request_id, sid, fingerprint, user["id"]))
        rows = db.list_messages(sid, limit=60)
        if body.history_end_id:
            endpoint = _get_message(body.history_end_id, sid)
            if not endpoint:
                raise HTTPException(409, '历史截止消息已删除')
            rows = db.list_messages(sid, before=endpoint['seq'] + 1, limit=60)
        _archive_messages([user], session)
        progress.event('user_persisted', {'message_id': user['id']})
        history = [ChatMessage(role=r["role"], content=outbound(r),
                               images=r.get("frames") or ([r["image"]] if r.get("image") and not re.search(r"\.(mp4|mov|webm|mkv)(?:\?|$)", r["image"], re.I) else [])) for r in rows]
        history, attached = await asyncio.to_thread(media_context.prepare, history, session, text)
        messages = _to_openai_messages(history, session["character_ids"], uncensored=body.uncensored, persona=_resolve_persona(session["persona_id"]))
        apply_card_display_mode(messages, session['character_ids'], body.card_display_mode)
        if messages and messages[0]['role'] == 'system':
            messages[0]['content'] += media_context.instructions(attached)
        elif attached:
            messages.append({'role': 'system', 'content': media_context.instructions(attached)})
        if voice is not None:
            messages.insert(1 if messages and messages[0]['role'] == 'system' else 0,
                            {'role': 'system', 'content': '当前是实时语音通话。保持原有角色和用户身份，用自然口语回答，通常一到三句；不用标题、列表、代码或动作描写。默认用中文，用户明确要求其他语言时遵从。不要提及这条通话指令。'})
        reply_cfg = cfg
        if any(m.images for m in history):
            reply_cfg = {**cfg, "model": cfg.get("vision_model") or cfg["model"],
                   "base_url": cfg.get("vision_base_url") or cfg["base_url"],
                   "api_key": cfg.get("vision_api_key") or cfg.get("api_key", "")}
        parts = []
        raw_parts = []
        summary_stream = media_context.SummaryStream(bool(attached))
        finish_reason = None
        try:
            progress.event('generation')
            if emit and body.feature_id == 'core':
                from .chat import context_debug
                await emit({'type': 'context', **context_debug(messages, reply_cfg['model'])})
            max_tokens = (body.max_tokens if body.max_tokens and body.max_tokens > 0 else None) if body.feature_id == 'core' else (body.max_tokens or 2048)
            tool_config = agent_tools.settings()
            if voice is None and agent_tools.available(body.feature_id, session['persona_id'], tool_config):
                result = await agent_tools.generate(messages, reply_cfg, tool_config,
                    persona_id=session['persona_id'], session_id=sid, feature_id=body.feature_id,
                    request_id=body.request_id, max_tokens=max_tokens, emit=emit)
                raw_parts.append(result.content)
                visible = summary_stream.feed(result.content)
                parts.append(visible)
                finish_reason = result.finish_reason
                if emit:
                    await emit({'type': 'delta', 'text': visible})

            async def text_events():
                if not parts:
                    async for item in openai.stream_chat_retry(messages, reply_cfg["model"], reply_cfg["base_url"], reply_cfg.get("api_key", ""), max_tokens=max_tokens, attempts=1):
                        yield item

            async for event in text_events():
                if event["type"] == "text":
                    raw_parts.append(event['text'])
                    visible = summary_stream.feed(event['text'])
                    parts.append(visible)
                    if emit:
                        if visible:
                            await emit({"type": "delta", "text": visible})
                elif event["type"] == "error":
                    code = event.get('status')
                    raise RuntimeError(f'上游 {code}' if isinstance(code, int) and 400 <= code <= 599 else '模型暂时未能回复')
                elif event['type'] == 'done':
                    finish_reason = event.get('finish_reason')
            tail = summary_stream.finish()
            if tail:
                parts.append(tail)
                if emit:
                    await emit({'type': 'delta', 'text': tail})
            reply = "".join(parts).strip()
            if not reply:
                raise RuntimeError("模型返回了空回复，请重试")
            progress.event('generated', {'raw': ''.join(raw_parts), 'text': reply, 'finish_reason': finish_reason})
            if attached and finish_reason in (None, '', 'stop'):
                try:
                    await asyncio.to_thread(media_context.save, session, summary_stream.summaries(), attached, reply_cfg['model'])
                except Exception:
                    log.warning('Media summary persistence failed request=%s', body.request_id)
            if voice is not None:
                progress.event('voice')
                # 合成结束不代表播放结束；确认音频播完才结算正常回合。
                await voice.finish()
        except asyncio.CancelledError:
            assistant = _save_voice_prefix(sid, body.request_id, voice, 'interrupted')
            if assistant:
                _archive_messages([assistant], session)
            raise
        except Exception as exc:
            assistant = _save_voice_prefix(sid, body.request_id, voice, 'failed')
            if assistant:
                _archive_messages([assistant], session)
            failed_stage = progress.stage
            progress.event('generation_failed', {'raw': ''.join(raw_parts), 'failed_stage': failed_stage, 'error_type': type(exc).__name__})
            check = await upstream_accessibility(reply_cfg) if failed_stage == 'generation' else '生成后的本地处理未完成'
            raise HTTPException(502, f'回复未完成，已保留你的消息；阶段 {failed_stage}，已确认发送 0 条。' + _upstream_reason(exc) + '；' + check + '；未自动重试，模型请求可能已计费。') from exc
        segments = []
        if body.mode == "group":
            matches = list(re.finditer(r"\*\*([^*\n]+)\*\*\s*[：:]\s*", reply))
            segments = [{"speaker": m.group(1), "text": reply[m.end():matches[i + 1].start() if i + 1 < len(matches) else len(reply)].strip()}
                        for i, m in enumerate(matches)]
        with db._tx() as conn:
            assistant = _append_message(conn, sid, "assistant", reply, segments)
            if body.feature_id in ('core', 'desktop_pet') and voice is None:
                from ..services.qq_web_sync import enqueue
                enqueue(conn, assistant['id'], sid)
            conn.execute("UPDATE session_chat_turns SET assistant_id=?,status='done' WHERE request_id=?", (assistant["id"], body.request_id))
        progress.event('persisted', {'message_id': assistant['id'], 'text': assistant['content']})
        if body.auto_memory:
            from ..services.memory_batch import enqueue
            memory_cfg = {**cfg, 'model': body.memory_model or cfg['model']}
            enqueue((session['persona_id'], sid), _extract,
                    [{"role": r["role"], "content": outbound(r)} for r in [*rows, assistant]], session, memory_cfg)
        _archive_messages([assistant], session)
        return {**session, "user": user, "assistant": assistant, "replayed": False, 'finish_reason': finish_reason}


@router.post('/web-stream')
async def web_stream(body: SessionTurn):
    from .chat import _sse
    body.feature_id = 'core'
    background = BackgroundTasks()
    async def events():
        queue = asyncio.Queue(maxsize=128)
        async def produce():
            try:
                result = await _session_turn(body, background, queue.put)
                await queue.put({'type': 'done', 'assistant': result['assistant'], 'finish_reason': result.get('finish_reason')})
            except Exception as exc:
                await queue.put({'type': 'error', 'message': exc.detail if isinstance(exc, HTTPException) else '回复未完成，请重试'})
            await queue.put(None)
        task = asyncio.create_task(produce())
        try:
            yield _sse('status', {'text': '等待本体处理'})
            while (event := await queue.get()) is not None:
                kind = event.pop('type')
                yield _sse('token' if kind == 'delta' else kind, event)
            await task
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
    return StreamingResponse(events(), media_type='text/event-stream', background=background)


def _archive_messages(rows: list[dict], session: dict) -> None:
    from ..services import memory_workflow
    from ..services import activity_memory
    try:
        activity_memory.from_messages(rows, session['persona_id'], session['session_id'], session['character_ids'], session.get('source_feature_id', 'core'))
        memory_workflow.archive_source(rows, session["persona_id"], session["session_id"], session["character_ids"])
    except OSError:
        log.exception("01 对话归档失败，原始消息仍保存在 SQLite")
