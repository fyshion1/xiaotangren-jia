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
from pathlib import Path

ATTACHMENTS_DIR = Path(__file__).resolve().parent.parent.parent / "data" / "attachments"

MAX_IMAGE_BYTES = 20 * 1024 * 1024  # 20MB

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
        "width": width,
        "height": height,
        "size": len(raw),
        "thumb": f"{URL_PREFIX}/{sess}/thumb/{thumb_name}",
        "orig": f"{URL_PREFIX}/{sess}/orig/{orig_name}",
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


def clear_originals(session_id: str | None = None) -> int:
    """回收原图（缩略图永久保留，见 §15.3）。返回删除的文件数。"""
    ensure_dir()
    if session_id:
        roots = [ATTACHMENTS_DIR / _safe_token(session_id) / "orig"]
    else:
        roots = [p / "orig" for p in ATTACHMENTS_DIR.iterdir() if p.is_dir()]
    removed = 0
    for root in roots:
        if not root.is_dir():
            continue
        for f in root.iterdir():
            if f.is_file():
                try:
                    f.unlink()
                    removed += 1
                except OSError:
                    pass
    return removed