"""全局设置（越狱 / 规则等）键值存取。"""

from fastapi import APIRouter, HTTPException

from .. import db

router = APIRouter()


@router.get("/settings")
async def get_settings() -> dict[str, str]:
    return db.get_settings()


@router.put("/settings")
async def put_settings(body: dict[str, str]) -> dict[str, str]:
    if "expert_mode_v1" in body or "agent_tools_v1" in body or "network_access_v1" in body:
        raise HTTPException(403, "请通过对应设置入口修改")
    db.set_settings(body)
    return db.get_settings()