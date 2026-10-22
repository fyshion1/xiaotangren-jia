"""看图（多模态 Vision）路由：上传图片 → Base64 → vision 模型流式回复。

模型来源同样由前端显式传入（base_url/api_key/model），后端无状态转发。
"""

import json
from collections.abc import AsyncIterator

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..providers import openai
from .chat import ChatMessage, _to_openai_messages, _resolve_persona, context_debug

router = APIRouter()

MAX_IMAGE_BYTES = 20 * 1024 * 1024  # 20MB


class VisionRequest(BaseModel):
    messages: list[ChatMessage] = Field(default_factory=list)
    max_tokens: int | None = None
    image_base64: str
    mime: str = "image/png"
    prompt: str = "看看这张图，说说你的感受。"
    character_ids: list[str] = Field(default_factory=list)
    # 当前用户身份 id（§22）；缺省 = 服务端记着的当前身份。
    persona_id: str | None = None
    base_url: str | None = None
    api_key: str | None = None
    model: str | None = None
    # 无审查通道：追加无审查专属越狱块（§7），让模型配合成人向图片。
    uncensored: bool = False


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@router.post("/images/chat")
async def images_chat(req: VisionRequest) -> StreamingResponse:
    from ..config import get_settings

    settings = get_settings()
    base_url = req.base_url or settings.model_base_url
    api_key = req.api_key or settings.model_api_key
    model = req.model or settings.model_vision

    data_url = f"data:{req.mime or 'image/png'};base64,{req.image_base64}"
    history = [*req.messages, ChatMessage(role="user", content=req.prompt, images=[data_url])]
    messages = _to_openai_messages(
        history, req.character_ids, req.uncensored, _resolve_persona(req.persona_id)
    )

    async def gen() -> AsyncIterator[str]:
        from ..services.conversation_runtime import transient_stream
        yield _sse("context", context_debug(messages, model))
        async for event in transient_stream(messages, model, base_url, api_key, max_tokens=req.max_tokens, source="images"):
            kind = event.pop('type')
            yield _sse(kind, event)

    return StreamingResponse(gen(), media_type="text/event-stream")
