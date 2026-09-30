"""画廊 + 照片记忆（对应《项目要求》§9.4）。

画廊 = 用户主动收藏的重要图片：图片文件仍走 §15.1 的 attachments 落盘，
这里只管「这张图的文字描述」以及它是否进小糖人的长期记忆。

照片记忆（A 方案，默认）：把描述当作一条**家记忆**写进 §9.2 的记忆层，
检索时以「你有一张照片：<描述>」的形式注入。关闭某条的「进记忆」勾选时，
连带删掉它对应的那条记忆 —— 图片本身仍留在画廊里。

分桶说明：§9.4 只要求「照片记忆」，没要求按角色分。默认进家记忆（大家都能想起
这张照片），需要私密时用户可在记忆面板里删掉这条、或把描述写得更含蓄。
"""

from __future__ import annotations

from .. import db
from ..providers import openai
from . import attachments
from . import memory as mem

# 照片记忆在 Prompt 里的前缀（§9.4 原文措辞）
PHOTO_PREFIX = "你有一张照片："


def _norm(text: str) -> str:
    return " ".join((text or "").split())


def _memory_text(description: str) -> str:
    return f"{PHOTO_PREFIX}{_norm(description)}"


async def describe_image(
    image_url: str,
    *,
    base_url: str = "",
    api_key: str = "",
    model: str = "",
    hint: str = "",
) -> str:
    """让 vision 模型看一眼画廊图，自动写一段描述（用户可以再改）。

    image_url：对外 URL（/api/files/...）—— 读回本地文件转 data URL 再发，
    因为多数中转（vsllm 等）不接受指向 localhost 的图片地址。
    失败时抛 RuntimeError，由路由转成 502，前端允许用户手写描述。
    """
    raw = _read_local(image_url)
    if raw is None:
        raise RuntimeError("读不到这张图的本地文件（可能原图已被清理）")
    b64 = attachments.to_data_url(raw)
    prompt = hint.strip() or "用一两句中文描述这张图：画面里有什么、谁在做什么、什么氛围。"
    messages = [
        {"role": "system", "content": "你在为一张收藏的照片写简短的中文描述，只输出描述本身，不要寒暄、不要解释。"},
        {
            "role": "user",
            "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": b64}},
            ],
        },
    ]
    return (await openai.complete_chat(messages, model, base_url, api_key, max_tokens=300, temperature=0.5)).strip()


def _read_local(url: str) -> bytes | None:
    """把 /api/files/{sess}/{orig|thumb}/{name} 读回本地字节；找不到返回 None。"""
    prefix = f"{attachments.URL_PREFIX}/"
    rel = (url or "").strip()
    if not rel.startswith(prefix):
        return None
    path = attachments.ATTACHMENTS_DIR / rel[len(prefix):]
    try:
        # 防路径穿越：解析后必须在附件根目录内
        path = path.resolve()
        if not path.is_relative_to(attachments.ATTACHMENTS_DIR.resolve()):
            return None
        return path.read_bytes() if path.is_file() else None
    except (OSError, ValueError):
        return None


def attach_memory(gallery_id: str, description: str = "") -> dict | None:
    """把一条画廊描述挂成家记忆（§9.4 A 方案）。返回落库后的画廊记录。"""
    g = db.get_gallery(gallery_id)
    if g is None:
        return None
    desc = _norm(description or g["description"])
    if not desc:
        # 没有描述就没有可检索的正文 —— 保留「想进记忆」的意向，等补上描述再真正建记忆
        db.update_gallery(gallery_id, in_memory=True, memory_id="")
        return db.get_gallery(gallery_id)

    text = _memory_text(desc)
    # 已经为这条画廊记过（内容未变）→ 复用，不重复写
    if g["memory_id"]:
        existing = db.get_memory(g["memory_id"])
        if existing and existing["text"] == text:
            db.update_gallery(gallery_id, description=desc, in_memory=True)
            return db.get_gallery(gallery_id)
        db.delete_memory(g["memory_id"])  # 描述改过 → 旧记忆作废，下面重建

    record = mem.remember(
        text=text,
        bucket=mem.HOME,
        char_id="",
        source="gallery",
        meta={"gallery_id": gallery_id, "kind": "photo", "orig": g["orig"], "thumb": g["thumb"]},
    )
    if record is None:
        # 幂等去重命中 → 取回已存在的那条
        existing = db.get_memory_by_fingerprint(mem.HOME, "", mem.emb.text_fingerprint(text))
        record = existing
    db.update_gallery(
        gallery_id, description=desc, in_memory=True, memory_id=(record["id"] if record else "")
    )
    return db.get_gallery(gallery_id)


def detach_memory(gallery_id: str) -> dict | None:
    """取消「进小糖人记忆」：删掉对应记忆，图仍在画廊里。"""
    g = db.get_gallery(gallery_id)
    if g is None:
        return None
    if g["memory_id"]:
        db.delete_memory(g["memory_id"])
    db.update_gallery(gallery_id, in_memory=False, memory_id="")
    return db.get_gallery(gallery_id)


def update_description(gallery_id: str, description: str) -> dict | None:
    """改描述：进记忆的同步刷新那条记忆（走 attach_memory 的重建路径）。"""
    g = db.get_gallery(gallery_id)
    if g is None:
        return None
    if g["in_memory"]:
        return attach_memory(gallery_id, description)
    db.update_gallery(gallery_id, description=_norm(description))
    return db.get_gallery(gallery_id)


def remove(gallery_id: str) -> bool:
    """从画廊移除：连带删掉它的照片记忆（图文件由 §15.3 的清理流程回收）。"""
    g = db.get_gallery(gallery_id)
    if g is None:
        return False
    if g["memory_id"]:
        db.delete_memory(g["memory_id"])
    return db.delete_gallery(gallery_id)


def star(
    *,
    orig: str,
    session_id: str = "",
    message_id: str = "",
    description: str = "",
    in_memory: bool = True,
) -> dict | None:
    """「⭐ 存入画廊」：同一张原图重复收藏 → 返回已存在的那条（幂等）。"""
    existing = db.get_gallery_by_orig(orig)
    if existing:
        return existing
    created = db.add_gallery(
        orig=orig,
        thumb=attachments.thumb_url(orig),
        description=_norm(description),
        session_id=session_id,
        message_id=message_id,
        # 先记下「要不要进记忆」的意向；描述为空时暂不建记忆（避免留一条空正文的孤儿记忆），
        # 等描述补上（用户手写或自动描述）再真正建。
        in_memory=in_memory,
    )
    if created is None:
        return db.get_gallery_by_orig(orig)
    if in_memory and created["description"]:
        return attach_memory(created["id"], created["description"])
    return created