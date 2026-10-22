"""附件（图片）存储：落盘 + 缩略图，**绝不进数据库 BLOB**（对应《项目要求》§15.1）。

布局（backend/data/attachments/）：
    {session_id}/orig/{id}.{ext}    原图（可被「清理原图」回收，见 §15.3）
    {session_id}/thumb/{id}.jpg     缩略图（永久保留，回看体验靠它）

数据库只存 id 与 URL；对外 URL 前缀统一 `/api/files/`（静态目录挂载点，见 main.py）。
"""

from __future__ import annotations

import base64
import hashlib
import io
import re
import shutil
import subprocess
from pathlib import Path

ATTACHMENTS_DIR = Path(__file__).resolve().parent.parent.parent / "data" / "attachments"

MAX_IMAGE_BYTES = 20 * 1024 * 1024  # 20MB
# 画廊视频（§9.4）：一般 30 秒出头、100MB 以内。这里只做「存得住 + 播得出」，
# 不抽帧 —— 抽帧那条链是聊天的 /api/media/video/*，门槛更紧（15s / 50MB）。
MAX_VIDEO_BYTES = 100 * 1024 * 1024  # 100MB

THUMB_MAX = 512  # 缩略图最长边（px）
THUMB_QUALITY = 82

URL_PREFIX = "/api/files"

_MIME_EXT = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/bmp": "bmp",
}

# 画廊视频：只认这几种容器；存的是原文件，靠浏览器 <video> 直接播。
VIDEO_EXT = {".mp4", ".mov", ".webm", ".mkv", ".avi"}
_VIDEO_MIME_EXT = {
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "video/webm": "webm",
    "video/x-matroska": "mkv",
    "video/x-msvideo": "avi",
}

_DATA_URL_RE = re.compile(r"^data:(?P<mime>[^;,]+)?;base64,(?P<b64>.+)$", re.S)


def ensure_dir() -> None:
    ATTACHMENTS_DIR.mkdir(parents=True, exist_ok=True)


def _safe_token(value: str, fallback: str = "misc") -> str:
    """把 session_id 收敛成安全的目录名，防路径穿越。"""
    token = re.sub(r"[^A-Za-z0-9_.-]", "_", (value or "").strip())[:64]
    return token or fallback


def parse_data_url(data_url: str) -> tuple[bytes, str]:
    """解析 data URL → (原始字节, mime)。非 data URL 直接抛错。"""
    m = _DATA_URL_RE.match((data_url or "").strip())
    if not m:
        raise ValueError("图片格式不对：需要 data:image/...;base64,xxx 形式的 data URL")
    mime = (m.group("mime") or "image/png").lower()
    try:
        raw = base64.b64decode(m.group("b64"), validate=False)
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"base64 解码失败：{exc}") from exc
    if not raw:
        raise ValueError("图片内容为空")
    return raw, mime


def to_data_url(raw: bytes, mime: str = "image/png") -> str:
    """字节 → data URL（喂 vision 模型用；多数中转不接受指向 localhost 的图片地址）。"""
    return f"data:{mime or 'image/png'};base64,{base64.b64encode(raw).decode('ascii')}"


MODEL_IMAGE_MAX = 1280
MAX_CONTEXT_IMAGES = 10


def model_image_data(raw: bytes) -> str:
    """Bound visual resolution and payload; retain original files for local viewing."""
    from fastapi import HTTPException
    from PIL import Image, ImageOps, UnidentifiedImageError

    if len(raw) > MAX_IMAGE_BYTES:
        raise HTTPException(413, "上下文图片超过 20 MB")
    try:
        with Image.open(io.BytesIO(raw)) as source:
            # Animated uploads use the first frame, never the entire animation.
            image = ImageOps.exif_transpose(source)
            image.thumbnail((MODEL_IMAGE_MAX, MODEL_IMAGE_MAX))
            if image.mode in ("RGBA", "LA") or "transparency" in image.info:
                rgba = image.convert("RGBA")
                image = Image.new("RGB", rgba.size, "white")
                image.paste(rgba, mask=rgba.getchannel("A"))
            else:
                image = image.convert("RGB")
            output = io.BytesIO()
            image.save(output, format="JPEG", quality=85, optimize=True)
            return to_data_url(output.getvalue(), "image/jpeg")
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError) as exc:
        raise HTTPException(422, "图片无法解码或分辨率过大，请换一张图片") from exc


def image_for_model(url: str) -> str:
    """Resolve and resize all chat images, including inline data and video frames."""
    from fastapi import HTTPException

    if url.startswith("data:image/"):
        if len(url) > ((MAX_IMAGE_BYTES + 2) // 3) * 4 + 128:
            raise HTTPException(413, "上下文图片超过 20 MB")
        try:
            raw, _ = parse_data_url(url)
        except ValueError as exc:
            raise HTTPException(422, "图片 data URL 不合法") from exc
        return model_image_data(raw)
    if url.startswith("/api/media-files/"):
        from ..routers.media import _load_frame
        raw, _ = _load_frame(url)
        return model_image_data(raw)
    path = _resolve_local(url)
    if path is None:
        raise HTTPException(422, "图片必须是本地附件或图片 data URL")
    if not path.is_file():
        raise HTTPException(422, "上下文中的图片文件已清理，请重新上传图片，或减少历史注入条数")
    if path.stat().st_size > MAX_IMAGE_BYTES:
        raise HTTPException(413, "上下文图片超过 20 MB")
    return model_image_data(path.read_bytes())


def thumb_url(orig_url: str) -> str:
    """原图引用 URL → 对应缩略图 URL（与前端 thumbOf 同一套规则）。"""
    if not orig_url:
        return ""
    return re.sub(r"\.[^./]+$", ".jpg", orig_url.replace("/orig/", "/thumb/"))


def _make_thumb(raw: bytes) -> bytes | None:
    """生成 JPEG 缩略图；Pillow 不可用或图片坏掉时返回 None（调用方降级）。"""
    try:
        from PIL import Image
    except Exception:  # noqa: BLE001
        return None
    try:
        img = Image.open(io.BytesIO(raw))
        img = img.convert("RGB") if img.mode not in ("RGB", "L") else img
        img.thumbnail((THUMB_MAX, THUMB_MAX))
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=THUMB_QUALITY, optimize=True)
        return buf.getvalue()
    except Exception:  # noqa: BLE001
        return None


def save_image(session_id: str, raw: bytes, mime: str, source: str = "upload") -> dict:
    """落盘一张图（原图 + 缩略图），返回引用信息（含对外 URL）。"""
    ensure_dir()
    sess = _safe_token(session_id)
    image_id = hashlib.sha1(raw).hexdigest()[:16]
    ext = _MIME_EXT.get((mime or "").lower(), "png")

    orig_dir = ATTACHMENTS_DIR / sess / "orig"
    thumb_dir = ATTACHMENTS_DIR / sess / "thumb"
    orig_dir.mkdir(parents=True, exist_ok=True)
    thumb_dir.mkdir(parents=True, exist_ok=True)

    orig_name = f"{image_id}.{ext}"
    orig_path = orig_dir / orig_name
    if not orig_path.exists():
        orig_path.write_bytes(raw)

    # 缩略图统一 .jpg（永久保留）
    thumb_name = f"{image_id}.jpg"
    thumb_path = thumb_dir / thumb_name
    thumb_bytes = _make_thumb(raw)
    if thumb_bytes:
        if not thumb_path.exists():
            thumb_path.write_bytes(thumb_bytes)
    elif not thumb_path.exists():
        # 没 Pillow / 生成失败 → 原图直接当缩略图用，保证前端能显示
        thumb_path.write_bytes(raw)

    width = height = 0
    try:
        from PIL import Image

        with Image.open(io.BytesIO(raw)) as im:
            width, height = im.size
    except Exception:  # noqa: BLE001
        pass

    return {
        "id": image_id,
        "session": sess,
        "source": source or "upload",
        "kind": "image",
        "width": width,
        "height": height,
        "size": len(raw),
        "thumb": f"{URL_PREFIX}/{sess}/thumb/{thumb_name}",
        "orig": f"{URL_PREFIX}/{sess}/orig/{orig_name}",
    }


def save_video(session_id: str, raw: bytes, ext_or_mime: str = "", source: str = "upload") -> dict:
    """落盘一个视频（画廊用），返回引用信息。**不抽帧、不做缩略图**。

    与 save_image 的区别：视频不做 Pillow 缩略图，thumb 直接指向原文件 —— 前端用
    `<video>` 播它，只靠原 URL 就行。扩展名优先按 mime 推，推不出再按传入的扩展名兜底。
    """
    ensure_dir()
    sess = _safe_token(session_id)
    video_id = hashlib.sha1(raw).hexdigest()[:16]
    token = (ext_or_mime or "").lower().strip()
    if token.startswith("."):
        ext = token.lstrip(".")[:8] or "mp4"
    else:
        ext = _VIDEO_MIME_EXT.get(token, "") or (token[:8] if token else "") or "mp4"
    if not ext.startswith("."):  # 统一成裸扩展名再存盘
        ext = ext.lstrip(".")
    ext = re.sub(r"[^A-Za-z0-9]", "", ext) or "mp4"

    orig_dir = ATTACHMENTS_DIR / sess / "orig"
    thumb_dir = ATTACHMENTS_DIR / sess / "thumb"
    orig_dir.mkdir(parents=True, exist_ok=True)
    thumb_dir.mkdir(parents=True, exist_ok=True)

    orig_name = f"{video_id}.{ext}"
    orig_path = orig_dir / orig_name
    if not orig_path.exists():
        orig_path.write_bytes(raw)

    orig_url = f"{URL_PREFIX}/{sess}/orig/{orig_name}"
    return {
        "id": video_id,
        "session": sess,
        "source": source or "upload",
        "kind": "video",
        "width": 0,
        "height": 0,
        "size": len(raw),
        # 视频不给缩略图，前端拿 thumb 当封面时可用时长/首帧兜底；这里先指向原文件。
        "thumb": orig_url,
        "orig": orig_url,
    }


def _resolve_local(url: str) -> Path | None:
    """把 /api/files/{sess}/{orig|thumb}/{name} 解析回本地路径；越界或格式不对返回 None。

    防路径穿越：resolve() 后必须仍在 ATTACHMENTS_DIR 之内（与 services/gallery.py 同一套规则）。
    """
    prefix = f"{URL_PREFIX}/"
    rel = (url or "").strip()
    if not rel.startswith(prefix):
        return None
    try:
        path = (ATTACHMENTS_DIR / rel[len(prefix):]).resolve()
        if not path.is_relative_to(ATTACHMENTS_DIR.resolve()):
            return None
    except (OSError, ValueError):
        return None
    return path


def delete_by_url(url: str) -> int:
    """真删一张图的文件（§15 真删流程）。返回删除的文件数。

    传入原图 URL 时连同它的缩略图一起删（缩略图恒为 .jpg，由 orig 的 hash 推导）；
    只传缩略图 URL 时只删缩略图 —— 反向推不出原图扩展名，不猜。
    """
    path = _resolve_local(url)
    if path is None:
        return 0
    targets = [path]
    if "/orig/" in path.as_posix():
        targets.append(path.parent.parent / "thumb" / f"{path.stem}.jpg")
    removed = 0
    for f in targets:
        try:
            if f.is_file():
                f.unlink()
                removed += 1
        except OSError:
            pass
    return removed


def list_session_files(session_id: str) -> dict:
    """列出某会话下的原图文件（存储管理用），带大小 / 类型 / 被引用次数。

    只列 `orig/` 里的文件 —— 缩略图是衍生物、不单独给用户删（删原图时按 hash 一并回收）。
    引用次数（消息里还挂着 / 画廊里还有收藏）由 routers 层补齐，这里只给磁盘事实。
    """
    sess = _safe_token(session_id)
    root = ATTACHMENTS_DIR / sess / "orig"
    items: list[dict] = []
    if root.is_dir():
        for f in sorted(root.iterdir(), key=lambda p: p.name):
            if not f.is_file() or f.is_symlink():
                continue
            ext = f.suffix.lower()
            try:
                size = f.stat().st_size
                mtime = f.stat().st_mtime
            except OSError:
                continue
            items.append({
                "name": f.name,
                "stem": f.stem,
                "ext": ext,
                "kind": "video" if ext in VIDEO_EXT else "image",
                "size": size,
                "mtime": mtime,
                "orig": f"{URL_PREFIX}/{sess}/orig/{f.name}",
                "thumb": (
                    f"{URL_PREFIX}/{sess}/orig/{f.name}"
                    if ext in VIDEO_EXT
                    else f"{URL_PREFIX}/{sess}/thumb/{f.stem}.jpg"
                ),
            })
    return {"session": sess, "items": items, "count": len(items)}


def delete_selected(session_id: str, names: list[str]) -> dict:
    """只删用户点名的那几个文件（存储管理「选择删什么」）。

    names 是 orig 目录里的文件名（含扩展名）。文件名先白名单校验（防路径穿越），
    再按 hash 把同名缩略图一并回收。返回删掉的文件数与被忽略的名字。
    """
    sess = _safe_token(session_id)
    root = (ATTACHMENTS_DIR / sess / "orig").resolve()
    if not root.is_dir():
        return {"removed": 0, "skipped": list(names or [])}
    removed = 0
    skipped: list[str] = []
    for name in names or []:
        safe = re.sub(r"[^A-Za-z0-9_.-]", "", (name or "").strip())
        if not safe or safe in {".", ".."}:
            skipped.append(name)
            continue
        path = (root / safe).resolve()
        if root not in path.parents or not path.is_file():
            skipped.append(name)
            continue
        try:
            path.unlink()
            removed += 1
        except OSError:
            skipped.append(name)
            continue
        # 缩略图恒为 {hash}.jpg
        thumb = path.parent.parent / "thumb" / f"{path.stem}.jpg"
        try:
            if thumb.is_file():
                thumb.unlink()
                removed += 1
        except OSError:
            pass
    return {"removed": removed, "skipped": skipped}


def clear_originals(session_id: str) -> int:
    """只回收明确指定会话的原图；空值绝不能扩大成全部会话。"""
    if not session_id or not session_id.strip() or _safe_token(session_id) in {".", ".."}:
        raise ValueError("必须指定有效的会话，不能清理全部会话")
    session_dir = ATTACHMENTS_DIR / _safe_token(session_id)
    root = session_dir / "orig"
    if session_dir.is_symlink() or root.is_symlink() or not root.resolve().is_relative_to(ATTACHMENTS_DIR.resolve()):
        raise ValueError("无效的附件目录")
    roots = [root]
    removed = 0
    for root in roots:
        if not root.is_dir():
            continue
        for f in root.iterdir():
            if f.is_file():
                try:
                    f.unlink()
                    removed += 1
                except OSError as exc:
                    raise OSError(f"已清理 {removed} 个原图文件，部分文件无法删除，请刷新后重试") from exc
    return removed
