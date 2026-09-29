"""全局设置（越狱 / 规则等）键值存取。"""

from fastapi import APIRouter

from .. import db

router = APIRouter()


@router.get("/settings")
async def get_settings() -> dict[str, str]:
    return db.get_settings()


@router.put("/settings")
async def put_settings(body: dict[str, str]) -> dict[str, str]:
    db.set_settings(body)
    return db.get_settings()