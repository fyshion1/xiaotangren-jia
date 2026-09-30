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
    # 模型来源由前端显式传入，未传时用服务端默认（见 config）
    base_url: str | None = None
    api_key: str | None = None
    model: str | None = None
    # 单条回复的 token 上限（0 = 不限制）。前端「最大回复」面板可调。
    max_tokens: int | None = None
    # 是否走无审查通道：为真时组装引擎额外追加「无审查专属」越狱块（§7）。
    uncensored: bool = False


def _role_of(role: str) -> str:
    return role if role in {"user", "assistant"} else "user"


def _to_openai_messages(
    messages: list[ChatMessage], character_ids: list[str], uncensored: bool = False
) -> list[dict]:
    # 世界书需要原文消息，先转成 dict 再传给组装引擎。
    raw = [{"role": _role_of(m.role), "content": m.content} for m in messages]
    system = build_system_prompt(character_ids=character_ids, messages=raw, uncensored=uncensored)
    out: list[dict] = [{"role": "system", "content": system}] if system else []
    out.extend(raw)
    return out


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@router.post("/chat")
async def chat(req: ChatRequest) -> StreamingResponse:
    from ..config import get_settings

    settings = get_settings()
    base_url = req.base_url or settings.model_base_url
    api_key = req.api_key or settings.model_api_key
    model = req.model or settings.model_chat
    messages = _to_openai_messages(req.messages, req.character_ids, req.uncensored)
    max_tokens = req.max_tokens if req.max_tokens and req.max_tokens > 0 else None

    async def gen() -> AsyncIterator[str]:
        try:
            async for ev in openai.stream_chat_retry(
                messages, model, base_url, api_key, max_tokens=max_tokens
            ):
                if ev["type"] == "text":
                    yield _sse("token", {"text": ev["text"]})
                elif ev["type"] == "done":
                    yield _sse("done", {})
                else:
                    yield _sse("error", {"message": ev["message"]})
        except Exception as exc:  # noqa: BLE001
            yield _sse("error", {"message": str(exc)})

    return StreamingResponse(gen(), media_type="text/event-stream")