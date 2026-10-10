"""聊天 SSE 路由。

前端传入显式的模型来源（base_url/api_key/model），后端只做代理转发 + SSE 封装。
不在后端持久化任何可切换的 key —— 符合「前端自己填、后端无状态」的诉求。

事件：token（正文增量）/ done / error（带上游真实错误信息）。
"""

import json
from collections.abc import AsyncIterator

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from .. import db
from ..providers import openai
from ..services.prompt import build_system_prompt

router = APIRouter()


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    messages: list[ChatMessage] = Field(default_factory=list)
    # 本会话在场角色 id（群聊 = 多位；私聊 = 一位）；缺省 = 全员在场。
    character_ids: list[str] = Field(default_factory=list)
    # 当前用户身份 id（§22）。缺省 = 服务端记着的当前身份，再缺省 = 大老大。
    persona_id: str | None = None
    # 模型来源由前端显式传入，未传时用服务端默认（见 config）
    base_url: str | None = None
    api_key: str | None = None
    model: str | None = None
    # 单条回复的 token 上限（0 = 使用上游默认值）。
    max_tokens: int | None = None
    # 是否走无审查通道：为真时组装引擎额外追加「无审查专属」越狱块（§7）。
    uncensored: bool = False


def _role_of(role: str) -> str:
    return role if role in {"user", "assistant"} else "user"


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
    raw = [{"role": _role_of(m.role), "content": m.content} for m in messages]
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
    out.extend(raw)
    return out


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@router.post("/chat/preview")
async def chat_preview(req: ChatRequest) -> dict:
    """只组装、不调用上游（§24）：把「如果现在发这条，会给模型什么」原样返回。

    零 token 消耗，用来核对自我档案 / 世界书 / 记忆到底进没进提示词。
    """
    from ..config import get_settings

    settings = get_settings()
    messages = _to_openai_messages(
        req.messages, req.character_ids, req.uncensored, _resolve_persona(req.persona_id)
    )
    return {
        "model": req.model or settings.model_chat,
        "base_url": req.base_url or settings.model_base_url,
        "max_tokens": req.max_tokens if req.max_tokens and req.max_tokens > 0 else None,
        "messages": messages,
        "system": messages[0]["content"] if messages else "",
    }


@router.post("/chat")
async def chat(req: ChatRequest) -> StreamingResponse:
    from ..config import get_settings

    settings = get_settings()
    base_url = req.base_url or settings.model_base_url
    api_key = req.api_key or settings.model_api_key
    model = req.model or settings.model_chat
    messages = _to_openai_messages(
        req.messages, req.character_ids, req.uncensored, _resolve_persona(req.persona_id)
    )
    max_tokens = req.max_tokens if req.max_tokens and req.max_tokens > 0 else None

    async def gen() -> AsyncIterator[str]:
        try:
            async for ev in openai.stream_chat_retry(
                messages, model, base_url, api_key, max_tokens=max_tokens
            ):
                if ev["type"] == "text":
                    yield _sse("token", {"text": ev["text"]})
                elif ev["type"] == "done":
                    yield _sse("done", {"finish_reason": ev.get("finish_reason")})
                else:
                    yield _sse("error", {"message": ev["message"]})
        except Exception as exc:  # noqa: BLE001
            yield _sse("error", {"message": str(exc)})

    return StreamingResponse(gen(), media_type="text/event-stream")
