"""消息真删的级联清理（对应《项目要求》§15）。

删除一条（或多条）消息时，按「有引用就删」的语义往下清：

1. 消息行本身删掉
2. 它的图片若**不再被任何幸存消息引用** → 真删文件（原图 + 缩略图）
3. 顺带把画廊里这张图的收藏（所有归属下的）连同它的照片记忆一起移除

关键：**删文件前必须查幸存引用**。同一张图可能被两条消息共用（同图重发、
生图结果被引用），只删其中一条时文件必须留下，否则另一条会变成裂图。
"""

from __future__ import annotations

from .. import db
from . import gallery as gal


def _message_image(msg: dict) -> str:
    """消息的图片引用 URL。老数据里 image_source='generated' 的也可能只在 segments 里，这里只看 image。"""
    return (msg.get("image") or "").strip()


def delete_messages(ids: list[str]) -> dict:
    """按 id 批量真删消息，返回 {deleted, files_removed, gallery_removed}。

    单条删除传长度为 1 的列表即可。
    """
    clean = [i for i in (ids or []) if i]
    if not clean:
        return {"deleted": 0, "files_removed": 0, "gallery_removed": 0}

    removed = db.delete_messages_by_ids(clean)
    if not removed:
        return {"deleted": 0, "files_removed": 0, "gallery_removed": 0}

    deleted_ids = [m["id"] for m in removed]
    # 只对「被删消息确实带图」的那些 URL 做清理
    candidates = list(dict.fromkeys(_message_image(m) for m in removed if _message_image(m)))
    orphaned: list[str] = []
    for orig in candidates:
        if not db.list_messages_by_image(orig, exclude_ids=deleted_ids):
            orphaned.append(orig)

    cascade = gal.purge_for_images(orphaned)
    return {
        "deleted": len(removed),
        "files_removed": cascade["files_removed"],
        "gallery_removed": cascade["gallery_removed"],
    }


def preview_delete(ids: list[str]) -> dict:
    """确认框用的预演：只算会连带删掉多少张图 / 画廊收藏，不改任何数据。"""
    clean = [i for i in (ids or []) if i]
    messages = [m for m in (db.get_message(i) for i in clean) if m]
    images = list(dict.fromkeys(_message_image(m) for m in messages if _message_image(m)))
    orphaned = [o for o in images if not db.list_messages_by_image(o, exclude_ids=clean)]
    return {
        "messages": len(messages),
        "images": len(orphaned),
        "gallery": sum(len(db.list_gallery_by_orig(o)) for o in orphaned),
    }
