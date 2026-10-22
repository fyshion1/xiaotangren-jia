"""Primary-side configuration; token is never returned to the browser."""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from typing import Literal

from .. import db
from ..services import compute

router = APIRouter(prefix="/compute", tags=["compute"])


class ConfigInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mode: Literal["native", "delegated"]
    worker_url: str = Field(default="", max_length=2048)
    token: str | None = Field(default=None, max_length=4096)
    clear_token: bool = False


@router.get("/config")
def get_config():
    from ..config import get_settings
    cfg = compute.configuration()
    return {"mode": cfg.mode, "worker_url": cfg.worker_url, "has_token": bool(cfg.token),
            "profile": get_settings().runtime_profile}


@router.put("/config")
def save_config(body: ConfigInput):
    previous = compute.configuration()
    # Never silently forward an old host's secret when changing destinations.
    same_host = body.worker_url.strip().rstrip("/") == previous.worker_url
    token = "" if body.clear_token else (body.token or "").strip() or (previous.token if same_host or body.mode == "native" else "")
    try:
        cfg = compute.ComputeConfig(mode=body.mode, worker_url=body.worker_url, token=token)
    except ValidationError:
        raise HTTPException(422, "委托模式需要有效的 HTTP(S) 地址和访问密钥") from None
    db.set_feature_settings(compute.KEY, cfg.model_dump())
    with compute._lock:
        compute._failures.clear()
    return get_config()


@router.get("/status")
async def status():
    return await compute.status()
