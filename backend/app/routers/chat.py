"""聊天 SSE 路由。"""

import json
from collections.abc import AsyncIterator

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..config import get_settings
from ..providers import openai
from ..services.prompt import build_system_prompt

router = APIRouter()


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    messages: list[ChatMessage] = Field(default_factory=list)
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
    settings = get_settings()
    model = req.model or settings.model_chat
    messages = _to_openai_messages(req.messages)

    async def gen() -> AsyncIterator[str]:
        try:
            async for delta in openai.stream_chat(messages, model):
                yield _sse("token", {"text": delta})
            yield _sse("done", {})
        except Exception as exc:  # noqa: BLE001
            yield _sse("error", {"message": str(exc)})

    return StreamingResponse(gen(), media_type="text/event-stream")