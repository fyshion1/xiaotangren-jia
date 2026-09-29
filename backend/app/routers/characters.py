"""人设 CRUD：前端「编辑资料」改存后端 SQLite。"""

from fastapi import APIRouter

from .. import db

router = APIRouter()


@router.get("/characters")
async def list_characters() -> list[dict]:
    return db.list_characters()


@router.put("/characters/{char_id}")
async def update_character(char_id: str, body: dict) -> dict:
    db.upsert_character(char_id, body)
    return body