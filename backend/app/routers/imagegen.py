"""生图路由：转发 OpenAI 兼容 /images/generations。

说明：当前主力中转 vsllm 没有生图通道（/v1/models 里查不到），所以默认
model_image 留空；用户可在「模型设置 / 前端」填一个支持生图的中转地址+模型。
本地 ComfyUI / SD WebUI 的接入里已在《项目要求》§7 规划，后续按需补。
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import config as conf
from ..providers import openai

router = APIRouter()


class ImageGenRequest(BaseModel):
    prompt: str
    size: str = "1024x1024"
    n: int = 1
    base_url: str | None = None
    api_key: str | None = None
    model: str | None = None


@router.post("/images/generate")
async def generate_images(req: ImageGenRequest) -> dict:
    settings = conf.get_settings()
    base_url = req.base_url or settings.image_base_url or settings.model_base_url
    api_key = req.api_key or settings.model_api_key
    model = (req.model or settings.model_image or "").strip()
    if not model:
        raise HTTPException(
            status_code=400,
            detail="没有配置生图模型：请在「模型设置」里填一个支持 /images/generations 的模型名"
            "（当前 vsllm 中转无生图通道，可另填一个生图中转地址）。",
        )
    try:
        images = await openai.generate_images(req.prompt, model, base_url, api_key, req.size, req.n)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    if not images:
        raise HTTPException(status_code=502, detail="生图接口成功但返回为空（可能该模型不支持此尺寸）。")
    return {"images": images}