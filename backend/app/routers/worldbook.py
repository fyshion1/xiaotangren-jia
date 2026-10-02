"""世界书词条 CRUD。"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .. import db

router = APIRouter()


class WorldbookBody(BaseModel):
    title: str = ""
    keywords: str = Field(default="", description="逗号分隔的关键词，命中即触发")
    content: str = ""
    enabled: bool = True
    priority: int = 0
    # 归属（§19）：'' = 家共用（群聊用），<角色 id> = 那位角色的专属
    owner: str = ""


@router.get("/worldbook")
async def list_worldbook(owner: str | None = None) -> list[dict]:
    """`?owner=` 过滤出某一档；不带参数 = 全部（编辑面板用）。"""
    return db.list_worldbook(owner)


@router.post("/worldbook")
async def create_worldbook(body: WorldbookBody) -> dict:
    return db.create_worldbook(body.model_dump())


@router.put("/worldbook/{entry_id}")
async def update_worldbook(entry_id: str, body: WorldbookBody) -> dict:
    if db.get_worldbook(entry_id) is None:
        raise HTTPException(status_code=404, detail="词条不存在")
    db.update_worldbook(entry_id, body.model_dump())
    row = db.get_worldbook(entry_id)
    assert row is not None
    return row


@router.delete("/worldbook/{entry_id}")
async def delete_worldbook(entry_id: str) -> dict:
    db.delete_worldbook(entry_id)
    return {"ok": True}