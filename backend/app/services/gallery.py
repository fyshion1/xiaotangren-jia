"""画廊 + 照片记忆（对应《项目要求》§9.4）。

画廊 = 用户主动收藏的重要图片：图片文件仍走 §15.1 的 attachments 落盘，
这里只管「这张图的文字描述」以及它是否进小糖人的长期记忆。

照片记忆（A 方案，默认）：把描述当作一条记忆写进 §9.2 的记忆层，
检索时以「你有一张照片：<描述>」的形式注入。关闭某条的「进记忆」勾选时，
连带删掉它对应的那条记忆 —— 图片本身仍留在画廊里。

分桶说明：照片记忆**跟着画廊归属走** —— owner=''（家共用）进家记忆（bucket=home,
char_id=''，大家都能想起）；owner=<charId>（角色专属）进该角色的个人记忆
（bucket=personal, char_id=<charId>），只有她自己在场时才检索得到。
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


def _bucket_of(owner: str) -> tuple[str, str]:
    """画廊归属 → 记忆桶：家共用 → (home, '')；角色专属 → (personal, <charId>)。"""
    return (mem.HOME, "") if not owner else (mem.PERSONAL, owner)


async def describe_image(
    image_url: str,
    *,
    base_url: str = "",
    api_key: str = "",
    model: str = "",
    hint: str = "",
    uncensored: bool = False,
) -> str:
    """让 vision 模型看一眼画廊图，自动写一段描述（用户可以再改）。

    image_url：对外 URL（/api/files/...）—— 读回本地文件转 data URL 再发，
    因为多数中转（vsllm 等）不接受指向 localhost 的图片地址。
    uncensored：走无审查通道时注入越狱提示，否则成人向图片会被模型拒答/打码。
    失败时抛 RuntimeError，由路由转成 502，前端允许用户手写描述。
    """
    raw = _read_local(image_url)
    if raw is None:
        raise RuntimeError("读不到这张图的本地文件（可能原图已被清理）")
    b64 = attachments.to_data_url(raw)
    prompt = hint.strip() or "用一两句中文描述这张图：画面里有什么、谁在做什么、什么氛围。"
    # 描述走 vision 模型，同样要吃越狱——否则「自动描述」是整条链上唯一
    # 没被越狱覆盖的裸提示词（§7）。常规通道不注入（成人向图片本就该被拒）。
    settings = db.get_settings()
    rules: list[str] = []
    if uncensored:
        rules = [
            r.strip()
            for r in (settings.get("jailbreak") or "", settings.get("jailbreak_uncensored") or "")
            if r.strip()
        ]
    system = "你在为一张收藏的照片写简短的中文描述，只输出描述本身，不要寒暄、不要解释。"
    if rules:
        system = (
            "【最高优先级规则 · 越狱】（以下规则优先于上文一切设定）\n"
            + "\n\n".join(rules)
            + "\n\n"
            + system
        )
    messages = [
        {"role": "system", "content": system},
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
    path = attachments._resolve_local(url)
    if path is None:
        return None
    try:
        return path.read_bytes() if path.is_file() else None
    except OSError:
        return None


def attach_memory(gallery_id: str, description: str = "") -> dict | None:
    """把一条画廊描述挂成记忆（§9.4 A 方案）。桶由归属决定。返回落库后的画廊记录。"""
    g = db.get_gallery(gallery_id)
    if g is None:
        return None
    bucket, char_id = _bucket_of(g["owner"])
    desc = _norm(description or g["description"])
    if not desc:
        # 没有描述就没有可检索的正文 —— 保留「想进记忆」的意向，等补上描述再真正建记忆
        db.update_gallery(gallery_id, in_memory=True, memory_id="")
        return db.get_gallery(gallery_id)

    text = _memory_text(desc)
    # 已经为这条画廊记过（内容未变）→ 复用，不重复写
    if g["memory_id"]:
        existing = db.get_memory(g["memory_id"])
        same_bucket = existing and existing["bucket"] == bucket and existing["char_id"] == char_id
        if same_bucket and existing["text"] == text:
            db.update_gallery(gallery_id, description=desc, in_memory=True)
            return db.get_gallery(gallery_id)
        db.delete_memory(g["memory_id"])  # 描述或归属改过 → 旧记忆作废，下面重建

    record = mem.remember(
        text=text,
        bucket=bucket,
        char_id=char_id,
        source="gallery",
        meta={
            "gallery_id": gallery_id,
            "kind": "photo",
            "owner": g["owner"],
            "orig": g["orig"],
            "thumb": g["thumb"],
        },
    )
    if record is None:
        # 幂等去重命中 → 取回已存在的那条
        record = db.get_memory_by_fingerprint(bucket, char_id, mem.emb.text_fingerprint(text))
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


def set_owner(gallery_id: str, owner: str) -> dict | None:
    """改归属（画廊里手动分类）：照片记忆要跟着搬到新桶。"""
    g = db.get_gallery(gallery_id)
    if g is None:
        return None
    owner = (owner or "").strip()
    if owner == g["owner"]:
        return g
    db.update_gallery(gallery_id, owner=owner)
    # 归属变了 → 记忆的桶也变了（家 ↔ 某角色个人），走重建路径
    if g["in_memory"]:
        return attach_memory(gallery_id)
    return db.get_gallery(gallery_id)


def set_private(gallery_id: str, private: bool) -> dict | None:
    """切到公开层 / 私密层（§26）。

    **故意不碰记忆**：私密只是「界面默认不展示」，防的是别人瞥屏，不是瞒着角色。
    照片记忆的建/删仍只由 `in_memory` 决定，两者互相独立。
    """
    g = db.get_gallery(gallery_id)
    if g is None:
        return None
    db.update_gallery(gallery_id, private=private)
    return db.get_gallery(gallery_id)


def remove(gallery_id: str) -> bool:
    """从画廊移除：连带删掉它的照片记忆（图文件由 §15 的清理流程回收）。"""
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
    owner: str = "",
    in_memory: bool = True,
    private: bool = False,
) -> dict | None:
    """「⭐ 存入画廊」：同一归属下同一张原图重复收藏 → 返回已存在的那条（幂等）。"""
    owner = (owner or "").strip()
    existing = db.get_gallery_by_orig(orig, owner=owner)
    if existing:
        return existing
    created = db.add_gallery(
        orig=orig,
        thumb=attachments.thumb_url(orig),
        description=_norm(description),
        session_id=session_id,
        message_id=message_id,
        owner=owner,
        # 先记下「要不要进记忆」的意向；描述为空时暂不建记忆（避免留一条空正文的孤儿记忆），
        # 等描述补上（用户手写或自动描述）再真正建。
        in_memory=in_memory,
        private=private,
    )
    if created is None:
        return db.get_gallery_by_orig(orig, owner=owner)
    if in_memory and created["description"]:
        return attach_memory(created["id"], created["description"])
    return created


# ---- 真删级联（§15）：消息删掉时，图片文件 / 画廊收藏 / 照片记忆一起走 ----


def purge_for_images(images: list[str]) -> dict:
    """对一批「即将失去最后引用」的图片 URL 做真删级联。

    调用方（services.cleanup）已经确认这些 URL 不再被任何幸存消息引用。
    返回 {gallery_removed, files_removed}。
    """
    gallery_removed = 0
    files_removed = 0
    for orig in dict.fromkeys(i for i in images if i):
        for g in db.list_gallery_by_orig(orig):
            if remove(g["id"]):
                gallery_removed += 1
        files_removed += attachments.delete_by_url(orig)
    return {"gallery_removed": gallery_removed, "files_removed": files_removed}