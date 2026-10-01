"""人设 CRUD：前端「编辑资料」改存后端 SQLite。"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, HTTPException

from .. import db

router = APIRouter()


@router.get("/characters")
async def list_characters() -> list[dict]:
    return db.list_characters()


@router.post("/characters")
async def create_character(body: dict) -> dict:
    """新建角色（介绍页「＋ 新角色」）。缺 id 或 id 撞车时重新生成。"""
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="角色得有名字")
    char_id = (body.get("id") or "").strip()
    if not char_id or db.get_character(char_id) is not None:
        char_id = f"char-{uuid.uuid4().hex[:10]}"
    db.upsert_character(char_id, body)
    return db.get_character(char_id) or {}


@router.put("/characters/{char_id}")
async def update_character(char_id: str, body: dict) -> dict:
    db.upsert_character(char_id, body)
    return body