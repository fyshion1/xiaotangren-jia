"""QQ 桥的媒体落盘路由（《项目要求》§9.6.4）。

**为什么不在功能项目里自己存文件**：QQ 来的图片 / 视频 / 表情包最终要在**前端聊天记录里显示**，
而前端只认 `/api/files/<session>/…` 这一套（缩略图、原图清理、画廊收藏、单条真删的级联
全都挂在附件管道上）。所以由本体提供一条**专用的窄接口**给 QQ 桥：

    POST /api/qq-bridge/attachments   base64 + mime → 附件管道 → 返回引用 URL

和 `/api/attachments` 的区别只有两点：
1. 收的是 **base64 + 声明 mime**（不是 data URL，也不是 multipart）—— OneBot 侧拿到的就是字节；
2. **按内容签名去重**：群里的表情包会被反复发，同一份字节只落一次盘、只占一个 URL。
   （`save_image` 本身也是按 sha1 命名的，这里再挡一层是为了表情包这种超高频场景少走 IO。）

边界：只落盘，不解析、不转码、不上传任何外部服务。体积上限沿用附件管道（图 20MB / 视频 100MB）。
"""

from __future__ import annotations

import base64
import binascii
import hashlib
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..services import attachments

router = APIRouter(prefix="/qq-bridge", tags=["qq-bridge"])

# 表情包：QQ 的表情通常很小，单独标一个 source 便于前端区分渲染。
STICKER_MAX_BYTES = 5 * 1024 * 1024


class QQAttachmentIn(BaseModel):
    session_id: str = Field(min_length=1, max_length=160)
    data: str = Field(min_length=1)          # base64（不带 data: 前缀；带了也容错）
    mime: str = Field(default="", max_length=120)
    filename: str = Field(default="", max_length=255)
    source: str = Field(default="upload", max_length=40)   # upload | generated | sticker | qq


def _guess_mime(mime: str, filename: str) -> str:
    """mime 优先，其次看扩展名 —— 两边都给不出就当图片（QQ 表情多是无声图）。"""
    mime = (mime or "").lower().strip()
    if mime and mime != "application/octet-stream":
        return mime
    ext = Path(filename or "").suffix.lower()
    table = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
             ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
             ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
             ".mkv": "video/x-matroska"}
    return table.get(ext, "image/png")


@router.post("/attachments")
async def save_qq_attachment(body: QQAttachmentIn) -> dict:
    """QQ 来的媒体 → 附件管道。返回 {url, thumb, kind, size, deduped}。"""
    raw_text = body.data.split(",", 1)[1] if body.data.startswith("data:") else body.data
    try:
        raw = base64.b64decode(raw_text, validate=False)
    except (binascii.Error, ValueError) as exc:
        raise HTTPException(status_code=400, detail="data 不是合法的 base64") from exc
    if not raw:
        raise HTTPException(status_code=400, detail="空的文件")
    if len(raw) > attachments.MAX_VIDEO_BYTES:
        raise HTTPException(status_code=413, detail="文件超过 100MB")

    mime = _guess_mime(body.mime, body.filename)
    digest = hashlib.sha1(raw).hexdigest()[:16]
    is_video = mime.startswith("video/")
    source = body.source or "qq"
    if source == "sticker" and len(raw) > STICKER_MAX_BYTES:
        source = "qq"   # 超大「表情」按普通图处理，不享受表情待遇

    # 落盘前先看这份字节是不是已经在盘上（save_* 按内容签名命名：同字节 → 同路径）。
    # 表情包会被反复发，先探一下才知道这次是「又发了一遍」还是「新东西」。
    was_there = False
    if not is_video:
        ext = attachments._MIME_EXT.get(mime.lower(), "png")
        orig_dir = attachments.ATTACHMENTS_DIR / attachments._safe_token(body.session_id) / "orig"
        was_there = (orig_dir / f"{digest}.{ext}").exists()

    try:
        if is_video:
            saved = attachments.save_video(body.session_id, raw, mime, source=source)
        else:
            saved = attachments.save_image(body.session_id, raw, mime, source=source)
    except (OSError, ValueError) as exc:
        raise HTTPException(status_code=500, detail=f"落盘失败：{exc}") from exc

    return {**saved, "digest": digest, "deduped": was_there}