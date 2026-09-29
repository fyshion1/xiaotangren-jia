"""聊天 SSE 路由。

前端传入显式的模型来源（base_url/api_key/model），后端只做代理转发 + SSE 封装。
不在后端持久化任何可切换的 key —— 符合「前端自己填、后端无状态」的诉求。
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
    # 模型来源由前端显式传入，未传时用服务端默认（见 config）
    base_url: str | None = None
    api_key: str | None = None
    model: str | None = None


def _role_of(role: str) -> str:
    return role if role in {"user", "assistant"} else "user"


def _to_openai_messages(messages: list[ChatMessage]) -> list[dict]:
    system = build_system_prompt()
    out: list[dict] = [{"role": "system", "content": system}] if system else []
    out.extend({"role": _role_of(m.role), "content": m.content} for m in messages)
    return out


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@router.post("/chat")
async def chat(req: ChatRequest) -> StreamingResponse:
    from ..config import get_settings

    settings = get_settings()
    base_url = req.base_url or settings.model_base_url
    api_key = req.api_key if req.api_key is not None else settings.model_api_key
    model = req.model or settings.model_chat
    messages = _to_openai_messages(req.messages)

    async def gen() -> AsyncIterator[str]:
        try:
            async for delta in openai.stream_chat(messages, model, base_url, api_key):
                yield _sse("token", {"text": delta})
            yield _sse("done", {})
        except Exception as exc:  # noqa: BLE001
            yield _sse("error", {"message": str(exc)})

    return StreamingResponse(gen(), media_type="text/event-stream")