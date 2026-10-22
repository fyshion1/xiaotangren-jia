"""Standalone compute service: no database, QQ connection or autonomy scheduler.

Run: python -m uvicorn app.worker:app --host 0.0.0.0 --port 8010
"""
from __future__ import annotations

import asyncio
import base64
import hmac
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from .config import get_settings
from .services import embedding, comfyui
from .services.compute import PROTOCOL, MAX_RESPONSE


@asynccontextmanager
async def lifespan(app: FastAPI):
    if len(get_settings().worker_token.strip()) < 24:
        raise RuntimeError("WORKER_TOKEN 至少需要 24 个字符；未配置时拒绝启动")
    app.state.task_lock = asyncio.Lock()
    yield


app = FastAPI(title="小糖人算力端", lifespan=lifespan, docs_url=None, redoc_url=None,
              openapi_url=None)


@app.middleware("http")
async def authenticate(request: Request, call_next):
    token = get_settings().worker_token
    supplied = request.headers.get("Authorization", "")
    if len(token.strip()) < 24 or not hmac.compare_digest(
            supplied.encode(), f"Bearer {token}".encode()):
        return JSONResponse({"detail": "Unauthorized"}, status_code=401)
    if request.method == "POST":
        data = bytearray()
        async for chunk in request.stream():
            data.extend(chunk)
            if len(data) > 1024 * 1024:
                return JSONResponse({"detail": "请求超过 1MB"}, status_code=413)
        request._body = bytes(data)
    return await call_next(request)


class EmbeddingTask(BaseModel):
    model_config = ConfigDict(extra="forbid")
    texts: list[str] = Field(min_length=1, max_length=128)
    model: str = Field(min_length=1, max_length=256)


class ImageTask(BaseModel):
    model_config = ConfigDict(extra="forbid")
    prompt: str = Field(min_length=1, max_length=16000)
    negative: str = Field(default="", max_length=16000)
    size: str = Field(default="832x1216", pattern=r"^\d{2,4}x\d{2,4}$")
    n: int = Field(default=1, ge=1, le=4)
    seed: int | None = None
    steps: int | None = Field(default=None, ge=1, le=100)
    cfg: float | None = Field(default=None, ge=0, le=30)


@app.get("/v1/compute/health")
async def health():
    s = get_settings()
    capabilities = []
    if s.worker_embedding_enabled:
        capabilities.append("embeddings")
    if s.worker_images_enabled:
        capabilities.append("images")
    return {"protocol": PROTOCOL, "capabilities": capabilities,
            "embedding_model": s.embed_local_model}


@asynccontextmanager
async def task_slot():
    # Reject concurrent jobs promptly instead of accumulating expensive work.
    lock = app.state.task_lock
    if lock.locked():
        raise HTTPException(503, "算力端忙，请稍后再试")
    async with lock:
        yield


@app.post("/v1/compute/embeddings")
async def embeddings(body: EmbeddingTask):
    s = get_settings()
    if not s.worker_embedding_enabled:
        raise HTTPException(503, "未启用本地向量计算")
    if body.model != s.embed_local_model:
        raise HTTPException(409, "向量模型不一致，请核对两端 EMBED_LOCAL_MODEL 并重建索引")
    if sum(len(text) for text in body.texts) > 200000:
        raise HTTPException(413, "文本超过计算上限")
    from pathlib import Path
    async with task_slot():
        try:
            vectors = await asyncio.to_thread(
                embedding.embed_texts, body.texts, local_model=s.embed_local_model,
                model_dir=Path(s.embed_local_dir) if s.embed_local_dir else None,
                _delegate=False)
        except embedding.EmbeddingError:
            raise HTTPException(503, "本地向量模型未就绪或计算失败") from None
    return {"protocol": PROTOCOL, "model": s.embed_local_model, "vectors": vectors}


@app.post("/v1/compute/images")
async def images(body: ImageTask):
    s = get_settings()
    if not s.worker_images_enabled:
        raise HTTPException(503, "未启用生图计算")
    async with task_slot():
        try:
            workflow = comfyui.load_workflow(s.comfyui_workflow or None,
                                             builtin=comfyui.builtin_workflow_name())
            results = await comfyui.generate(s.comfyui_url, workflow,
                **body.model_dump(), timeout=float(s.comfyui_timeout or 180))
        except (comfyui.ComfyUIError, OSError, ValueError):
            raise HTTPException(503, "算力端 ComfyUI 未就绪或生图失败") from None
    if not results or sum(len(raw) for raw, _ in results) > (MAX_RESPONSE // 4 * 3 - 4096):
        raise HTTPException(502, "生图结果为空或超过传输上限")
    return {"protocol": PROTOCOL, "images": [
        {"data": base64.b64encode(raw).decode("ascii"), "mime": mime} for raw, mime in results]}
