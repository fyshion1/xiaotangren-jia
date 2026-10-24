"""聊天 SSE 路由。

模型来源统一读取小窝大脑；旧客户端传来的模型覆盖字段不再生效。

事件：token（正文增量）/ done / error（带上游真实错误信息）。
"""

import json
from typing import Literal
from collections.abc import AsyncIterator

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from .. import db
from ..providers import openai
from ..services.prompt import build_system_prompt
from ..services import reply_suggestions

router = APIRouter()


def _brain_route(vision: bool = False) -> dict:
    brain = db.get_brain_default()
    cfg = {"base_url": brain.get("base_url", ""), "api_key": brain.get("api_key", ""),
           "model": brain.get("model", "")}
    if vision:
        for field in ("base_url", "api_key", "model"):
            cfg[field] = brain.get("vision_" + field) or cfg[field]
    return cfg


class ChatMessage(BaseModel):
    role: str
    content: str
    images: list[str] = Field(default_factory=list, max_length=10)


class ChatRequest(BaseModel):
    messages: list[ChatMessage] = Field(default_factory=list)
    # 本会话在场角色 id（群聊 = 多位；私聊 = 一位）；缺省 = 全员在场。
    character_ids: list[str] = Field(default_factory=list)
    # 当前用户身份 id（§22）。缺省 = 服务端记着的当前身份，再缺省 = 用户。
    persona_id: str | None = None
    # 模型来源由前端显式传入，未传时用服务端默认（见 config）
    base_url: str | None = None
    api_key: str | None = None
    model: str | None = None
    # 单条回复的 token 上限（0 = 使用上游默认值）。
    max_tokens: int | None = None
    # 是否走无审查通道：为真时组装引擎额外追加「无审查专属」越狱块（§7）。
    uncensored: bool = False
    card_display_mode: Literal['chat', 'html'] | None = None
    reply_suggestions: bool = False


def _role_of(role: str) -> str:
    return role if role in {"user", "assistant"} else "user"


def apply_card_display_mode(messages, character_ids, mode):
    from .. import tavern_feature
    if tavern_feature.enabled():
        tavern_feature.load("display").apply_card_display_mode(messages, character_ids, mode)


def _resolve_persona(persona_id: str | None) -> dict | None:
    """取当前用户身份档案。前端没传就按服务端记着的当前身份走，都没有则不带身份块。"""
    pid = (persona_id or "").strip() or db.get_active_persona_id()
    return db.get_profile(pid) if pid else None


def _to_openai_messages(
    messages: list[ChatMessage],
    character_ids: list[str],
    uncensored: bool = False,
    persona: dict | None = None,
) -> list[dict]:
    # 世界书需要原文消息，先转成 dict 再传给组装引擎。
    raw = [{"role": _role_of(m.role), "content": m.content, "images": m.images} for m in messages]
    # Keep the most recent visuals within a shared request budget, including video frames.
    from ..services.attachments import MAX_CONTEXT_IMAGES
    remaining = MAX_CONTEXT_IMAGES
    for message in reversed(raw):
        pictures = message["images"] if message["role"] == "user" else []
        selected = pictures[-remaining:] if remaining else []
        if len(selected) < len(pictures):
            message["content"] += "\n[较早附件未重复发送；需要查看细节请重新上传]"
        message["images"] = selected
        remaining -= len(selected)
    system = build_system_prompt(
        character_ids=character_ids, messages=raw, uncensored=uncensored, persona=persona
    )
    # 群聊双保险之二（§25）：不在场者的发言段落在系统提示里点名之外，
    # 还要从外发历史里洗掉。build_system_prompt 内部已经清洗过一次（供世界书/记忆扫描），
    # 这里对「真正发往模型」的副本再走同一个函数，保证两处口径一致。
    from ..services.prompt.assembler import _strip_absent_speakers

    by_id = {c["id"]: c for c in db.list_characters()}
    ids = [i for i in (character_ids or []) if i]
    present = {by_id[i].get("name") for i in ids if i in by_id}
    if len(present) > 1 and len(by_id) > len(present):
        raw = _strip_absent_speakers(raw, present)
    out: list[dict] = [{"role": "system", "content": system}] if system else []
    from ..services.attachments import image_for_model

    for message in raw:
        images = message.pop("images", []) if message["role"] == "user" else []
        message.pop("images", None)
        if images:
            message["content"] = [
                {"type": "text", "text": message["content"]},
                *[{"type": "image_url", "image_url": {"url": image_for_model(url)}} for url in images],
            ]
        out.append(message)
    return out


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def context_debug(messages: list[dict], model: str) -> dict:
    """记录实际交给 provider 的结构，省略图片字节和密钥。"""
    return {"model": model, "messages": [
        {"role": m["role"], "text": m["content"] if isinstance(m["content"], str) else
         "\n".join(p.get("text", "") for p in m["content"] if p.get("type") == "text"),
         "image_count": sum(p.get("type") == "image_url" for p in m["content"])
         if isinstance(m["content"], list) else 0}
        for m in messages
    ]}


@router.post("/chat/preview")
async def chat_preview(req: ChatRequest) -> dict:
    """只组装、不调用上游（§24）：把「如果现在发这条，会给模型什么」原样返回。

    零 token 消耗，用来核对自我档案 / 世界书 / 记忆到底进没进提示词。
    """
    cfg = _brain_route(any(m.images for m in req.messages))
    messages = _to_openai_messages(
        req.messages, req.character_ids, req.uncensored, _resolve_persona(req.persona_id)
    )
    apply_card_display_mode(messages, req.character_ids, req.card_display_mode)
    if req.reply_suggestions:
        reply_suggestions.add_instructions(messages)
    return {
        "model": cfg["model"],
        "base_url": cfg["base_url"],
        "max_tokens": req.max_tokens if req.max_tokens and req.max_tokens > 0 else None,
        "messages": messages,
        "system": messages[0]["content"] if messages else "",
    }


@router.post("/chat")
async def chat(req: ChatRequest) -> StreamingResponse:
    cfg = _brain_route(any(m.images for m in req.messages))
    if not cfg["base_url"] or not cfg["model"]:
        raise HTTPException(409, "请先在糖人小窝配置大脑 API")
    base_url, api_key, model = cfg["base_url"], cfg["api_key"], cfg["model"]
    messages = _to_openai_messages(
        req.messages, req.character_ids, req.uncensored, _resolve_persona(req.persona_id)
    )
    apply_card_display_mode(messages, req.character_ids, req.card_display_mode)
    if req.reply_suggestions:
        reply_suggestions.add_instructions(messages)
    max_tokens = req.max_tokens if req.max_tokens and req.max_tokens > 0 else None

    async def gen() -> AsyncIterator[str]:
        from ..services.conversation_runtime import transient_stream
        yield _sse("context", context_debug(messages, model))
        async for event in transient_stream(messages, model, base_url, api_key, max_tokens=max_tokens, source="chat", suggestions_enabled=req.reply_suggestions):
            kind = event.pop('type')
            yield _sse(kind, event)

    return StreamingResponse(gen(), media_type="text/event-stream")
