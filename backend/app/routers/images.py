"""看图（多模态 Vision）路由：上传图片 → Base64 → vision 模型流式回复。

模型来源同样由前端显式传入（base_url/api_key/model），后端无状态转发。
"""

import json
from collections.abc import AsyncIterator

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..providers import openai
from ..services.prompt import build_system_prompt

router = APIRouter()

MAX_IMAGE_BYTES = 20 * 1024 * 1024  # 20MB


class VisionRequest(BaseModel):
    image_base64: str
    mime: str = "image/png"
    prompt: str = "看看这张图，说说你的感受。"
    character_ids: list[str] = Field(default_factory=list)
    base_url: str | None = None
    api_key: str | None = None
    model: str | None = None


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@router.post("/images/chat")
async def images_chat(req: VisionRequest) -> StreamingResponse:
    from ..config import get_settings

    settings = get_settings()
    base_url = req.base_url or settings.model_base_url
    api_key = req.api_key if req.api_key is not None else settings.model_api_key
    model = req.model or settings.model_vision

    system = build_system_prompt(character_ids=req.character_ids, messages=[{"role": "user", "content": req.prompt}])
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
            async for delta in openai.stream_chat(messages, model, base_url, api_key):
                yield _sse("token", {"text": delta})
            yield _sse("done", {})
        except Exception as exc:  # noqa: BLE001
            yield _sse("error", {"message": str(exc)})

    return StreamingResponse(gen(), media_type="text/event-stream")