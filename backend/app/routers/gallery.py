"""画廊路由（对应《项目要求》§9.4）。

- `POST /api/gallery`          聊天图片气泡的「⭐ 存入画廊」
- `GET  /api/gallery`          列出画廊图（含缩略图、描述、是否进记忆）；可按归属过滤
- `POST /api/gallery/{id}/describe`  让 vision 模型自动写描述（也可由用户手写覆盖）
- `PATCH /api/gallery/{id}`    改描述 / 切换「进小糖人记忆」/ 改归属
- `DELETE /api/gallery/{id}`   移除（连带删掉它的照片记忆）

归属（owner）：'' = 家共用，<charId> = 该角色专属。私聊里 ⭐ 自动归属该角色，
画廊里可手动改。上传图片走已有的 `POST /api/attachments`，再 `POST /gallery` 带 owner。
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from .. import db
from ..services import gallery as gal

router = APIRouter()


class StarIn(BaseModel):
    orig: str  # 原图引用 URL（来自消息的 image / imageOrig）
    thumb: str = ""  # 可省略，缺省由 orig 推导
    session_id: str = ""
    message_id: str = ""
    kind: str = "image"  # §9.4 媒体类型：image（默认）| video（画廊视频）
    description: str = ""
    owner: str = ""  # '' = 家共用，<charId> = 角色专属
    in_memory: bool = True
    private: bool = False  # §26 私密层：界面默认不展示，与记忆无关


class DescribeIn(BaseModel):
    hint: str = ""  # 自定义描述指令；留空用默认
    save: bool = True  # 直接落库并同步记忆
    base_url: str = ""
    api_key: str = ""
    model: str = ""
    uncensored: bool = False  # 无审查通道：注入越狱提示，成人向图片才描述得出（§7）


class UpdateIn(BaseModel):
    description: str | None = None
    in_memory: bool | None = None
    owner: str | None = None
    private: bool | None = None  # §26 切公开层 / 私密层（不影响记忆）


@router.get("/gallery")
async def list_gallery(
    limit: int = Query(200, ge=1, le=1000),
    owner: str | None = Query(None, description="不传 = 全量；'' = 家共用；<charId> = 角色专属"),
    private: bool | None = Query(None, description="不传 = 两层都要；true/false = 只要私密层 / 公开层（§26）"),
) -> dict:
    items = db.list_gallery(limit=limit, owner=owner, private=private)
    return {"items": items, "total": db.count_gallery(owner, private)}


@router.post("/gallery")
async def add_to_gallery(body: StarIn) -> dict:
    """⭐ 存入画廊。同一归属下已收藏过的同一张图直接返回原记录（幂等，不报错）。"""
    if not (body.orig or "").strip():
        raise HTTPException(status_code=400, detail="缺少图片引用（orig）")
    created = gal.star(
        orig=body.orig.strip(),
        session_id=body.session_id,
        message_id=body.message_id,
        kind=body.kind,
        description=body.description,
        owner=body.owner,
        in_memory=body.in_memory,
        private=body.private,
    )
    if created is None:
        raise HTTPException(status_code=400, detail="存不进画廊：图片引用无效")
    return created


@router.post("/gallery/{gallery_id}/describe")
async def describe(gallery_id: str, body: DescribeIn) -> dict:
    """自动写描述（§9.4）：vision 模型看图 → 一段中文描述 → 可选直接进记忆。"""
    from ..config import get_settings

    g = db.get_gallery(gallery_id)
    if g is None:
        raise HTTPException(status_code=404, detail="画廊里没有这张图")
    if g.get("kind") == "video":
        # 视频不给「自动描述」：vision 模型看图，喂一段视频它读不了。
        raise HTTPException(status_code=400, detail="视频不支持自动描述，请手写一句")
    s = get_settings()
    try:
        text = await gal.describe_image(
            g["orig"] or g["thumb"],
            base_url=body.base_url or s.model_base_url,
            api_key=body.api_key or s.model_api_key,
            model=body.model or s.model_vision,
            hint=body.hint,
            uncensored=body.uncensored,
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"自动描述失败：{exc}") from exc
    if not text:
        raise HTTPException(status_code=502, detail="模型没有返回描述")
    if not body.save:
        return {"description": text, "saved": False}
    updated = gal.update_description(gallery_id, text)
    return {"description": text, "saved": True, "item": updated}


@router.patch("/gallery/{gallery_id}")
async def update_gallery(gallery_id: str, body: UpdateIn) -> dict:
    """改描述 / 切归属 / 切换「进小糖人记忆」。改描述或归属时若在记忆中，会同步重建那条记忆。"""
    if db.get_gallery(gallery_id) is None:
        raise HTTPException(status_code=404, detail="画廊里没有这张图")
    item = db.get_gallery(gallery_id)
    if body.owner is not None:
        item = gal.set_owner(gallery_id, body.owner)
    if body.description is not None:
        item = gal.update_description(gallery_id, body.description)
    if body.private is not None:
        item = gal.set_private(gallery_id, body.private)
    if body.in_memory is not None:
        item = gal.attach_memory(gallery_id) if body.in_memory else gal.detach_memory(gallery_id)
    return item or {}


@router.delete("/gallery/{gallery_id}")
async def delete_gallery(gallery_id: str) -> dict:
    if not gal.remove(gallery_id):
        raise HTTPException(status_code=404, detail="画廊里没有这张图")
    return {"ok": True}