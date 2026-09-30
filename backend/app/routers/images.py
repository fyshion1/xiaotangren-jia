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

    system = build_system_prompt(
        character_ids=req.character_ids,
        messages=[{"role": "user", "content": req.prompt}],
        uncensored=req.uncensored,
    )
    messages: list[dict] = []
    if system:
        messages.append({"role": "system", "content": system})
    # 图片必须用 data URL（data:image/...;base64,xxx）。裸 base64 会被部分中转
    # （vsllm 等）打成 400「API key not valid」/ 上游拒绝。
    data_url = f"data:{req.mime or 'image/png'};base64,{req.image_base64}"
    messages.append(
        {
            "role": "user",
            "content": [
                {"type": "text", "text": req.prompt},
                {"type": "image_url", "image_url": {"url": data_url}},
            ],
        }
    )

    async def gen() -> AsyncIterator[str]:
        try:
            async for ev in openai.stream_chat_retry(messages, model, base_url, api_key):
                if ev["type"] == "text":
                    yield _sse("token", {"text": ev["text"]})
                elif ev["type"] == "done":
                    yield _sse("done", {})
                else:
                    yield _sse("error", {"message": ev["message"]})
        except Exception as exc:  # noqa: BLE001
            yield _sse("error", {"message": str(exc)})

    return StreamingResponse(gen(), media_type="text/event-stream")