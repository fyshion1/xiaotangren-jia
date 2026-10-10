"""聊天记录持久化 + 附件（图片）上传路由（对应《项目要求》§15）。

- 文本 / 元数据 → SQLite（db.messages）
- 图片 → 落盘（services.attachments），库里只存引用
- 分页 → 游标（seq = rowid），不用 offset
"""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from .. import db
from ..services import attachments, cleanup

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


class DeleteIn(BaseModel):
    ids: list[str] = Field(default_factory=list)


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


@router.post("/messages/delete-preview")
async def preview_messages(body: DeleteIn) -> dict:
    """删除前预演：会连带删掉多少张图片文件 / 多少条画廊收藏（不改任何数据）。"""
    return cleanup.preview_delete(body.ids)


@router.post("/messages/delete")
async def delete_messages(body: DeleteIn) -> dict:
    """批量真删（QQ 式右键多选走这里）。

    真删语义：消息行删掉；图片不再被任何幸存消息引用时，文件（原图 + 缩略图）真删；
    画廊里这张图的收藏（所有归属下）连同照片记忆一起移除。
    """
    return cleanup.delete_messages(body.ids)


@router.delete("/messages/{message_id}")
async def delete_message(message_id: str) -> dict:
    """单条真删（右键「删除这条」）。级联规则同上。"""
    result = cleanup.delete_messages([message_id])
    if not result["deleted"]:
        raise HTTPException(status_code=404, detail="没有这条消息")
    return result


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
async def attachment_stats(session: str | None = Query(None)) -> dict:
    root = attachments.ATTACHMENTS_DIR
    sessions: list[dict] = []
    if root.is_dir():
        for sess in sorted(p for p in root.iterdir() if p.is_dir()):
            orig = sum(f.stat().st_size for f in (sess / "orig").glob("*") if f.is_file()) if (sess / "orig").is_dir() else 0
            thumb = sum(f.stat().st_size for f in (sess / "thumb").glob("*") if f.is_file()) if (sess / "thumb").is_dir() else 0
            sessions.append({"session": sess.name, "orig_bytes": orig, "thumb_bytes": thumb})
    return {
        "current_session": attachments._safe_token(session) if session else None,
        "sessions": sessions,
        "orig_bytes": sum(s["orig_bytes"] for s in sessions),
        "thumb_bytes": sum(s["thumb_bytes"] for s in sessions),
    }


class ClearOriginalsRequest(BaseModel):
    confirmed: Literal[True]


@router.post("/attachments/clear-originals")
async def clear_originals(body: ClearOriginalsRequest, session: str = Query(..., min_length=1)) -> dict:
    """必须明确会话和确认标记，旧版无参数请求也不能触发删除。"""
    try:
        removed = attachments.clear_originals(session)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return {"removed": removed}
