"""生图路由（§7）：四个可插拔引擎，按当前选择分派。

| id | 说明 | ready 判定 |
|---|---|---|
| local | 本地 ComfyUI | `GET {comfyui_url}/system_stats` 可达 |
| cloud | 云端 ComfyUI（CNB 等） | 同上，读 `comfyui_cloud_url` |
| thirdparty | OpenAI 兼容 /images/generations | 填了 `image_base_url` + `image_model` |
| novelai | NovelAI（协议不同，未实接） | 填了 token 才算 ready，调用仍返 501 |

本地与云端 ComfyUI **是同一个 HTTP 协议**，共用 `services/comfyui.py`，只是 base_url 不同。

出图一律落到附件库（`source="generated"`），返回 `{orig, thumb, id}` —— 与
`POST /attachments` 同形，前端不必分支；⭐ 存画廊走的是同一条路。
"""

from __future__ import annotations

import base64

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import config as conf
from .. import db
from ..providers import novelai, openai
from ..services import attachments, comfyui

router = APIRouter()

# 引擎 id 全表（顺序 = 前端 chips 顺序）
_ENGINE_IDS = ("local", "cloud", "thirdparty", "novelai")


class ImageGenRequest(BaseModel):
    prompt: str
    session_id: str = "single-default"  # 落到哪个会话的附件目录
    size: str = "832x1216"  # 竖构图默认（ComfyUI 侧可被工作流自带的尺寸覆盖）
    n: int = 1
    seed: int | None = None
    negative: str = ""
    steps: int | None = None
    cfg: float | None = None
    # 前端「模型设置」里的临时覆盖（thirdparty 用）
    base_url: str | None = None
    api_key: str | None = None
    model: str | None = None


def _comfy_url(engine: str) -> str:
    s = conf.get_settings()
    return (s.comfyui_cloud_url if engine == "cloud" else s.comfyui_url or "").strip()


async def _build_engines() -> list[dict]:
    """动态算 ready —— 不再硬编码布尔。探测很轻（3s 超时），失败即 false。"""
    s = conf.get_settings()
    local_url = (s.comfyui_url or "").strip()
    cloud_url = (s.comfyui_cloud_url or "").strip()
    local_ok, cloud_ok = False, False
    if local_url:
        local_ok = await comfyui.health(local_url)
    if cloud_url:
        cloud_ok = await comfyui.health(cloud_url)

    thirdparty_ok = bool((s.image_base_url or "").strip() and (s.model_image or "").strip())
    novelai_ok = bool((s.novelai_url or "").strip() and (s.novelai_api_key or "").strip())

    return [
        {
            "id": "local",
            "name": "本地 ComfyUI",
            "ready": local_ok,
            "desc": (
                f"3050 4GB 本地跑，免费无限，吃显存。地址：{local_url or '（未配置 COMFYUI_URL）'}"
                + ("" if local_ok else " —— 现在探测不通，确认 ComfyUI 已启动。")
            ),
        },
        {
            "id": "cloud",
            "name": "云端 ComfyUI（CNB 等）",
            "ready": cloud_ok,
            "desc": (
                f"与本地同一套协议，只是地址不同。地址：{cloud_url or '（未配置 COMFYUI_CLOUD_URL）'}"
                + ("" if cloud_ok else " —— 填上转发地址即可切换。")
            ),
        },
        {
            "id": "thirdparty",
            "name": "第三方生图 API",
            "ready": thirdparty_ok,
            "desc": (
                "任意支持 /images/generations 的中转。"
                + (
                    "已配置，可直接用。"
                    if thirdparty_ok
                    else "需在 .env 填 IMAGE_BASE_URL + MODEL_IMAGE（填一个支持 /images/generations 的中转）。"
                )
            ),
        },
        {
            "id": "novelai",
            "name": "NovelAI（未接入）",
            "ready": novelai_ok,
            "desc": (
                "接口不是 OpenAI 兼容（POST /ai/generate-image，Bearer token，返回 zip），"
                "需单独适配，本轮只留插槽。"
                + ("已填 token，但 provider 尚未实现。" if novelai_ok else "填 NOVELAI_URL + NOVELAI_API_KEY 后可见。")
            ),
        },
    ]


def _selected_engine() -> str:
    """当前选中的生图方式：DB 里的用户选择优先，其次环境变量，最后 local。"""
    picked = (db.get_settings().get("image_engine") or "").strip()
    if not picked:
        picked = (conf.get_settings().image_engine or "local").strip()
    return picked if picked in _ENGINE_IDS else "local"


@router.get("/images/engines")
async def list_image_engines() -> dict:
    """生图方式列表 + 当前选中项（§7 切换器）。ready 为实时探测结果。"""
    return {"engines": await _build_engines(), "selected": _selected_engine()}


@router.post("/images/engines/select")
async def select_image_engine(body: dict[str, str]) -> dict:
    """记住用户选中的生图方式（存 DB，重启仍在）。"""
    picked = (body.get("id") or "").strip()
    if picked not in _ENGINE_IDS:
        raise HTTPException(status_code=400, detail=f"未知生图方式：{picked}")
    db.set_settings({"image_engine": picked})
    return {"selected": picked}


# ---- 各引擎的出图实现：统一返回 [(字节, mime), ...] ----


async def _run_comfyui(req: ImageGenRequest, engine: str) -> list[tuple[bytes, str]]:
    s = conf.get_settings()
    base = _comfy_url(engine)
    if not base:
        field = "COMFYUI_CLOUD_URL" if engine == "cloud" else "COMFYUI_URL"
        raise HTTPException(
            status_code=400,
            detail=f"还没填 {field}。{engine} 引擎需要 ComfyUI 地址，写进 backend/.env 即可。",
        )
    try:
        workflow = comfyui.load_workflow(
            s.comfyui_workflow or None, builtin=comfyui.builtin_workflow_name()
        )
    except comfyui.ComfyUIError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    try:
        return await comfyui.generate(
            base,
            workflow,
            prompt=req.prompt,
            negative=req.negative,
            size=req.size,
            n=req.n,
            seed=req.seed,
            steps=req.steps,
            cfg=req.cfg,
            timeout=float(s.comfyui_timeout or 180),
        )
    except comfyui.ComfyUIError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


async def _run_thirdparty(req: ImageGenRequest) -> list[tuple[bytes, str]]:
    s = conf.get_settings()
    base_url = req.base_url or s.image_base_url or s.model_base_url
    api_key = req.api_key or s.model_api_key
    model = (req.model or s.model_image or "").strip()
    if not model:
        raise HTTPException(
            status_code=400,
            detail="thirdparty 引擎缺少生图模型：请在「模型设置」填一个支持 /images/generations 的模型名"
            "（IMAGE_BASE_URL 可单独填一个生图中转，不一定和聊天中转一样）。",
        )
    try:
        items = await openai.generate_images(req.prompt, model, base_url, api_key, req.size, req.n)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    if not items:
        raise HTTPException(status_code=502, detail="生图接口成功但返回为空（可能该模型不支持此尺寸）。")

    out: list[tuple[bytes, str]] = []
    async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=15.0)) as client:
        for item in items:
            if item.get("b64"):
                try:
                    raw = base64.b64decode(item["b64"])
                except Exception as exc:  # noqa: BLE001
                    raise HTTPException(status_code=502, detail=f"上游返回的 base64 解不开：{exc}") from exc
                out.append((raw, "image/png"))
            elif item.get("url"):
                try:
                    resp = await client.get(item["url"])
                except httpx.HTTPError as exc:
                    raise HTTPException(status_code=502, detail=f"下载上游图片失败：{exc}") from exc
                if resp.status_code >= 400:
                    raise HTTPException(status_code=502, detail=f"下载上游图片失败（{resp.status_code}）")
                mime = (resp.headers.get("content-type") or "image/png").split(";")[0].strip()
                out.append((resp.content, mime))
    return out


@router.post("/images/generate")
async def generate_images(req: ImageGenRequest) -> dict:
    """按当前引擎出图，结果统一落附件库，返回 {images: [{id, orig, thumb}, ...]}。"""
    engine = _selected_engine()

    if engine == "novelai":
        raise HTTPException(status_code=501, detail=str(novelai.NovelAINotImplemented(
            "NovelAI 通道还没实接 —— 它的接口不是 OpenAI 兼容，得照官方文档单独适配。"
            "先切到 local / cloud / thirdparty 其中一个。"
        )))

    if engine in ("local", "cloud"):
        results = await _run_comfyui(req, engine)
    elif engine == "thirdparty":
        results = await _run_thirdparty(req)
    else:  # pragma: no cover - _selected_engine 已收口
        raise HTTPException(status_code=400, detail=f"未知生图方式：{engine}")

    images: list[dict] = []
    for raw, mime in results:
        saved = attachments.save_image(req.session_id, raw, mime, source="generated")
        images.append({"id": saved["id"], "orig": saved["orig"], "thumb": saved["thumb"]})
    if not images:
        raise HTTPException(status_code=502, detail="生图跑完了但一张图都没拿到。")
    return {"images": images}