"""聊天记录持久化 + 附件（图片）上传路由（对应《项目要求》§15）。

- 文本 / 元数据 → SQLite（db.messages）
- 图片 → 落盘（services.attachments），库里只存引用
- 分页 → 游标（seq = rowid），不用 offset
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from .. import db
from ..services import attachments

router = APIRouter()


class MessageIn(BaseModel):
    session_id: str
    role: str
    content: str = ""
    image: str = ""  # 附件引用 URL（来自 /api/attachments）
    image_source: str = ""  # upload / generated
    kind: str = "text"
    segments: list[dict] = Field(default_factory=list)


class AttachmentIn(BaseModel):
    session_id: str
    data_url: str
    source: str = "upload"


@router.get("/messages")
async def list_messages(
    session: str = Query(..., min_length=1),
    before: int | None = Query(None),
    limit: int = Query(30, ge=1, le=200),
) -> dict:
    items = db.list_messages(session, before=before, limit=limit)
    return {
        "items": items,
        "total": db.count_messages(session),
        # 本页最早的 seq：前端向上翻页时带回去当 before
        "next_cursor": items[0]["seq"] if items else None,
        "has_more": bool(items) and db.count_messages(session) > 0 and _has_earlier(session, items),
    }


def _has_earlier(session: str, items: list[dict]) -> bool:
    if not items:
        return False
    return db.list_messages(session, before=items[0]["seq"], limit=1) != []


@router.post("/messages")
async def create_message(body: MessageIn) -> dict:
    if body.role not in ("user", "assistant"):
        raise HTTPException(status_code=400, detail="role 必须是 user / assistant")
    return db.append_message(
        session_id=body.session_id,
        role=body.role,
        content=body.content,
        image=body.image,
        image_source=body.image_source,
        kind=body.kind,
        segments=body.segments,
    )


@router.delete("/messages")
async def clear_messages(session: str = Query(..., min_length=1)) -> dict:
    removed = db.delete_messages(session)
    return {"removed": removed}


@router.post("/attachments")
async def upload_attachment(body: AttachmentIn) -> dict:
    """data URL → 落盘（原图 + 缩略图）→ 返回引用。上传图与生图共用这条管道。"""
    try:
        raw, mime = attachments.parse_data_url(body.data_url)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if len(raw) > attachments.MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="图片超过 20MB")
    return attachments.save_image(body.session_id, raw, mime, source=body.source)


@router.get("/attachments/stats")
async def attachment_stats() -> dict:
    root = attachments.ATTACHMENTS_DIR
    sessions: list[dict] = []
    if root.is_dir():
        for sess in sorted(p for p in root.iterdir() if p.is_dir()):
            orig = sum(f.stat().st_size for f in (sess / "orig").glob("*") if f.is_file()) if (sess / "orig").is_dir() else 0
            thumb = sum(f.stat().st_size for f in (sess / "thumb").glob("*") if f.is_file()) if (sess / "thumb").is_dir() else 0
            sessions.append({"session": sess.name, "orig_bytes": orig, "thumb_bytes": thumb})
    return {
        "sessions": sessions,
        "orig_bytes": sum(s["orig_bytes"] for s in sessions),
        "thumb_bytes": sum(s["thumb_bytes"] for s in sessions),
    }


@router.post("/attachments/clear-originals")
async def clear_originals(session: str | None = Query(None)) -> dict:
    """回收原图（缩略图永久保留）。session 为空 = 全部会话。"""
    removed = attachments.clear_originals(session)
    return {"removed": removed}