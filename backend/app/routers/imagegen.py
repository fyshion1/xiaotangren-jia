"""生图路由：转发 OpenAI 兼容 /images/generations。

说明：当前主力中转 vsllm 没有生图通道（/v1/models 里查不到），所以默认
model_image 留空；用户可在「模型设置 / 前端」填一个支持生图的中转地址+模型。
本地 ComfyUI / SD WebUI 的接入里已在《项目要求》§7 规划，后续按需补。
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import config as conf
from .. import db
from ..providers import openai

router = APIRouter()


# 生图方式切换器（§7）：三选一，默认腾讯云占位。
# ready=False 表示只占位、还没接实机；前端据此给「未接入」提示，不阻挡选择。
IMAGE_ENGINES = [
    {
        "id": "tencent",
        "name": "腾讯云（占位）",
        "ready": False,
        "desc": "VSCode Remote-SSH 控制云端，免费 4h/天；实机接入排在生图通道就绪之后。",
    },
    {
        "id": "comfyui",
        "name": "本地 ComfyUI / SD（占位）",
        "ready": False,
        "desc": "3060 4GB 本地跑，吃显存但免费无限；填入本地 /v1 地址即可接入。",
    },
    {
        "id": "thirdparty",
        "name": "第三方生图 API",
        "ready": True,
        "desc": "任意支持 /images/generations 的中转，即插即用 —— 现在就能用。",
    },
]


class ImageGenRequest(BaseModel):
    prompt: str
    size: str = "1024x1024"
    n: int = 1
    base_url: str | None = None
    api_key: str | None = None
    model: str | None = None


def _selected_engine() -> str:
    """当前选中的生图方式：DB 里的用户选择优先，其次环境变量，最后默认腾讯云。"""
    picked = (db.get_settings().get("image_engine") or "").strip()
    if not picked:
        picked = (conf.get_settings().image_engine or "tencent").strip()
    ids = {e["id"] for e in IMAGE_ENGINES}
    return picked if picked in ids else "tencent"


@router.get("/images/engines")
async def list_image_engines() -> dict:
    """生图方式列表 + 当前选中项（§7 切换器）。默认腾讯云。"""
    return {"engines": IMAGE_ENGINES, "selected": _selected_engine()}


@router.post("/images/engines/select")
async def select_image_engine(body: dict[str, str]) -> dict:
    """记住用户选中的生图方式。只存选择，不改变上游调用（实机接入后才生效）。"""
    picked = (body.get("id") or "").strip()
    ids = {e["id"] for e in IMAGE_ENGINES}
    if picked not in ids:
        raise HTTPException(status_code=400, detail=f"未知生图方式：{picked}")
    db.set_settings({"image_engine": picked})
    return {"selected": picked}


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