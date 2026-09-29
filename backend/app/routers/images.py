"""看图（多模态 Vision）路由：上传图片 → Base64 → vision 模型流式回复。"""

import base64
import json
from collections.abc import AsyncIterator
from typing import Literal

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..config import get_settings
from ..providers import openai
from ..services.prompt import build_system_prompt

router = APIRouter()

MAX_IMAGE_BYTES = 20 * 1024 * 1024  # 20MB


class VisionRequest(BaseModel):
    image_base64: str
    mime: str = "image/png"
    prompt: str = "看看这张图，说说你的感受。"


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@router.post("/images/chat")
async def images_chat(req: VisionRequest) -> StreamingResponse:
    settings = get_settings()
    model = settings.model_vision

    system = build_system_prompt()
    messages: list[dict] = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append(
        {
            "role": "user",
            "content": [
                {"type": "text", "text": req.prompt},
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:{req.mime};base64,{req.image_base64}"},
                },
            ],
        }
    )

    async def gen() -> AsyncIterator[str]:
        try:
            async for delta in openai.stream_chat(messages, model):
                yield _sse("token", {"text": delta})
            yield _sse("done", {})
        except Exception as exc:  # noqa: BLE001
            yield _sse("error", {"message": str(exc)})

    return StreamingResponse(gen(), media_type="text/event-stream")