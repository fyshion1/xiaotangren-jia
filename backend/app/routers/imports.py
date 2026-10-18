"""导入入口：Google Takeout 预览 + 酒馆（SillyTavern）角色卡。

酒馆卡走「四步」，慢的两步各自独立、谁慢谁后填：
- `POST /imports/tavern-card/preview` 只读卡：立绘落盘 + 拼 about + 摘开场白（**不建角色、不叫模型**）
- `POST /imports/tavern-card/extract` 用户看过画面之后，再叫模型抽词条（后填）
- `POST /imports/tavern-card/translate` 另要一份中文译文（只给界面看）
- `POST /imports/tavern-card/commit`  用户确认后按草稿建角色（重名是前端先问过的事）

开场白（卡里的 `first_mes`）**存下来但绝不自动发言**：导入框默认不勾，勾了 commit 时
才写成她私聊的第一条；事后想用，走 `POST /imports/tavern-card/{char_id}/greeting`。

**为什么拆开**：读卡 + 拼 about 是纯本地活儿（实测毫秒级），叫模型那两次
是网络活儿（一次 5 秒上下）。合在一个请求里，用户在模型返回前连立绘都看不见 ——
预览先出画面，词条与译文随后到。

读卡与抽取的实现在 `services/card_import.py`：那里的规则是「原文一字不改，
结构化词条只从原文里抽」，本路由只负责把结果接上库与模型。
"""

from __future__ import annotations

import json
import zipfile

from fastapi import APIRouter, File, HTTPException, Query, UploadFile
from pydantic import BaseModel

from .. import db
from ..providers import openai
from ..services import attachments, card_import

router = APIRouter(prefix="/imports", tags=["imports"])

# 立绘与卡片的大小上限：卡本体一般几百 KB，给足余量。
MAX_CARD_BYTES = 20 * 1024 * 1024


@router.post("/google-takeout")
async def preview_google_takeout(file: UploadFile = File(...)) -> dict:  # noqa: B008
    if not (file.filename or "").lower().endswith(".zip"):
        raise HTTPException(400, "请上传 Google Takeout ZIP 文件")
    raw = await file.read()
    if len(raw) > 200 * 1024 * 1024:
        raise HTTPException(413, "导出文件不能超过 200 MB")
    try:
        with zipfile.ZipFile(__import__("io").BytesIO(raw)) as archive:
            names = [n for n in archive.namelist() if not n.endswith("/")]
            json_files = [n for n in names if n.lower().endswith(".json")]
            html_files = [n for n in names if n.lower().endswith((".html", ".htm"))]
            preview = []
            for name in json_files[:20]:
                try:
                    value = json.loads(archive.read(name).decode("utf-8-sig"))
                    preview.append({"file": name, "kind": "json", "items": len(value) if isinstance(value, list) else 1})
                except (UnicodeDecodeError, json.JSONDecodeError):
                    continue
    except zipfile.BadZipFile as exc:
        raise HTTPException(400, "ZIP 文件损坏或格式不正确") from exc
    return {"status": "preview", "filename": file.filename, "file_count": len(names), "json_count": len(json_files), "html_count": len(html_files), "files": preview, "commit_required": True}


def _mime_of_png(raw: bytes) -> str:
    """卡图就是那份立绘。GIF 卡少见，但 PNG 卡偶尔被改名 —— 统一按 PNG 存。"""
    if raw[:3] == b"GIF":
        return "image/gif"
    if raw[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    return "image/jpeg"


async def _read_upload(file: UploadFile) -> tuple[bytes, dict]:
    """上传的卡 → (原始字节, 归一化后的卡)。读不出就抛 HTTP 4xx。"""
    raw = await file.read()
    if not raw:
        raise HTTPException(400, "这个文件是空的")
    if len(raw) > MAX_CARD_BYTES:
        raise HTTPException(413, f"角色卡不能超过 {MAX_CARD_BYTES // 1024 // 1024} MB")
    try:
        return raw, card_import.read_card(raw, file.filename or "")
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


def _chat_route(base_url: str, api_key: str, model: str) -> tuple[str, str, str]:
    """抽取 / 翻译走聊天那一份上游：前端把自己的配置传进来，留空回退后端 .env。

    抽取与翻译都是「整理原文」而不是「生成内容」，不该逼用户再配一份小窝大脑的 key。
    """
    from ..config import get_settings

    settings = get_settings()
    return (
        model or settings.model_chat,
        base_url or settings.model_base_url,
        api_key or settings.model_api_key,
    )


class CardFieldIn(BaseModel):
    """预览里用户手改过的词条（只覆盖传进来的键）。"""

    id: str = ""
    name: str = ""
    fields: dict = {}
    # 勾了才把卡里的开场白写进她的私聊第一条。**默认不勾** ——
    # 不勾就是不发言，跟以前一样（见 CardImportDialog 的铁规矩 2）。
    greeting: bool = False


class CardTextIn(BaseModel):
    """要翻译的正文（＝预览框里当前那份 about，用户可能改过）。"""

    text: str = ""


@router.post("/tavern-card/preview")
async def preview_tavern_card(
    file: UploadFile = File(...),  # noqa: B008
    extract: bool = Query(True, description="false = 只读卡，不叫模型抽词条（离线 / 没配 key）"),
    base_url: str = Query(""),
    api_key: str = Query(""),
    model: str = Query(""),
) -> dict:
    """读一张酒馆卡 → 立绘落盘 + 拼 about → **立刻就回的草稿**（不建角色、不叫模型）。

    读卡与拼 about 是纯本地活儿（实测毫秒级），所以画面先出来；词条与译文各自
    走下面的 `/extract`、`/translate` 两个请求后填 —— 用户不必盯着转圈等模型。

    `extract=true` 保留旧行为（一个请求里就把词条抽完），给脚本用；界面一律走 false。
    """
    raw, card = await _read_upload(file)

    warnings: list[str] = []
    about, about_warnings = card_import.build_about(card)
    warnings.extend(about_warnings)

    profile = card_import.blank_profile()
    name = card.get("name", "").strip()
    if not name:
        name = (file.filename or "未命名角色").rsplit(".", 1)[0].strip() or "未命名角色"
        warnings.append("卡里没写角色名，先用文件名顶上，记得在预览里改。")
    profile["name"] = name
    profile["about"] = about
    # 开场白：存**去标签后的纯文本**，默认不勾、不自动发言（见 CardImportDialog）。
    profile["greeting"] = card_import.greeting_for(card)

    # 立绘：卡图本身就是立绘 + 头像。落盘走附件管道（正文页 / 会话列表都能自取）。
    if raw[:8] == b"\x89PNG\r\n\x1a\n" or raw[:3] == b"GIF":
        saved = attachments.save_image("characters", raw, _mime_of_png(raw), source="import")
        profile["portrait"] = saved["orig"]
        profile["avatar"] = saved["thumb"]
    else:
        warnings.append("这是 JSON 卡（没有卡图），没有立绘可用 —— 在预览里自己传一张，或先空着。")

    # 词条抽取：只从原文里抽，抽不到就留空。失败不挡导入，降级成「只有 about」。
    if extract and card_import.card_text_for_extract(card):
        fields, extra_warnings = await _run_extract(card, base_url, api_key, model)
        profile.update(fields)
        warnings.extend(extra_warnings)
    elif extract:
        warnings.append("卡里没有可抽取的正文（描述 / 性格 / 场景都是空的），词条留空。")

    # 顺手让前端知道重名情况：同名角色已存在 → 前端先问用户「跳过还是新建第二张」。
    same_name = [c for c in db.list_characters() if (c.get("name") or "").strip() == name]
    return {
        "status": "preview",
        "filename": file.filename,
        "spec": card.get("spec", ""),
        "creator": card.get("creator", ""),
        "tags": card.get("tags", []),
        "has_greeting": bool(profile["greeting"]),
        "profile": profile,
        "warnings": warnings,
        "duplicates": [{"id": c["id"], "name": c.get("name", "")} for c in same_name],
    }


async def _run_extract(card: dict, base_url: str, api_key: str, model: str) -> tuple[dict, list[str]]:
    """从原文抽词条 → (词条, 非致命提醒)。**失败不抛**：抽不到就是空词条 + 一条提醒。"""
    text = card_import.card_text_for_extract(card)
    if not text:
        return {}, ["卡里没有可抽取的正文（描述 / 性格 / 场景都是空的），词条留空。"]
    mdl, url, key = _chat_route(base_url, api_key, model)
    messages = [
        {"role": "system", "content": card_import.extract_system_prompt()},
        {"role": "user", "content": f"【角色名】{card.get('name', '')}\n\n【原文】\n{text}"},
    ]
    try:
        reply = await openai.complete_chat(messages, model=mdl, base_url=url, api_key=key, max_tokens=1200, temperature=0.2)
        return card_import.parse_fields(reply), []
    except Exception as exc:  # noqa: BLE001
        return {}, [f"自动解析词条没成功（{exc}）—— 词条留空，落库后可以手动补。"]


@router.post("/tavern-card/extract")
async def extract_tavern_card(
    file: UploadFile = File(...),  # noqa: B008
    base_url: str = Query(""),
    api_key: str = Query(""),
    model: str = Query(""),
) -> dict:
    """第二步：用户已经看到画面了，这时才叫模型抽词条（后填）。

    卡按原文件再传一次（本地几十几百 KB，毫秒级）—— 这样「喂给模型的原文」始终
    只有 `services/card_import.py` 一个出处，不在前端手里转一道。
    """
    _raw, card = await _read_upload(file)
    fields, warnings = await _run_extract(card, base_url, api_key, model)
    return {"extracted": bool(fields), "fields": fields, "warnings": warnings}


@router.post("/tavern-card/translate")
async def translate_tavern_card(
    body: CardTextIn,
    base_url: str = Query(""),
    api_key: str = Query(""),
    model: str = Query(""),
) -> dict:
    """另要一份中文译文 —— **纯显示用**，回填进 `aboutZh`。

    `about` 原文一个字不动，照旧喂给模型；这份译文只是让界面好读，随时能切回原文看。
    翻的是**传进来的 text**（预览框里当前那份），用户改过就翻改过的。
    """
    text = (body.text or "").strip()
    if not text:
        return {"aboutZh": "", "warnings": []}
    mdl, url, key = _chat_route(base_url, api_key, model)
    messages = [
        {"role": "system", "content": card_import.translate_system_prompt()},
        {"role": "user", "content": text},
    ]
    try:
        reply = await openai.complete_chat(messages, model=mdl, base_url=url, api_key=key, max_tokens=4096, temperature=0.2)
    except Exception as exc:  # noqa: BLE001
        return {"aboutZh": "", "warnings": [f"中文译文没翻成（{exc}）—— 不影响导入，界面继续看原文。"]}
    return {"aboutZh": card_import.clean_translation(reply), "warnings": []}


@router.post("/tavern-card/commit")
async def commit_tavern_card(body: CardFieldIn) -> dict:
    """按（可能被用户改过的）草稿建角色。`id` 留空 = 新建（后端生成 `char-<hex>`）。

    `greeting=true` 时才把卡里的开场白写成她私聊的第一条 —— 用户没勾就一个字不写，
    开场白照样留在档案里（角色介绍页的「插入开场白」随时能用）。
    """
    if not (body.name or "").strip():
        raise HTTPException(400, "角色得有名字")
    fields = dict(body.fields or {})
    fields["name"] = body.name.strip()
    fields["imported"] = True
    char_id = (body.id or "").strip()
    if not char_id or db.get_character(char_id) is not None:
        import uuid

        char_id = f"char-{uuid.uuid4().hex[:10]}"
    db.upsert_character(char_id, fields)

    session_id = ""
    if body.greeting:
        session_id = _seed_greeting(char_id, fields)
    return {**(db.get_character(char_id) or {}), "greeting_session": session_id}


def _private_session_id(char_id: str) -> str:
    """她的私聊会话 id —— 与 `routers/session_chat.resolve_session` 同一套算法。

    当前身份不是默认的「大老大」时才加 `<personaId>@` 前缀（默认身份不加，
    老库里已有的 `single-<charId>` 历史才接得上）。两处口径必须一致，
    不然开场白会写进一个用户根本不会打开的会话里。
    """
    from ..seed_profiles import MAIN_PERSONA_ID

    sid = f"single-{char_id}"
    persona_id = db.get_active_persona_id()
    if persona_id and persona_id != MAIN_PERSONA_ID:
        sid = f"{persona_id}@{sid}"
    return sid


def _seed_greeting(char_id: str, fields: dict) -> str:
    """把开场白写进她的私聊第一条（她说的）。返回写进去的会话 id，没写就是空串。

    只在**会话还空着**时写：用户回头重导 / 再点一次，不该把开场白叠成两条。
    """
    text = (fields.get("greeting") or "").strip()
    if not text:
        return ""
    session_id = _private_session_id(char_id)
    if db.count_messages(session_id) > 0:
        return ""
    db.append_message(session_id=session_id, role="assistant", content=text)
    return session_id


@router.post("/tavern-card/{char_id}/greeting")
async def insert_greeting(char_id: str) -> dict:
    """角色介绍页的「插入开场白」：把档案里存的那份开场白写成她私聊的第一条。

    给「导入时没勾」的人留的后路 —— 卡里的那份一直躺在档案里，什么时候想用都行。
    会话已经聊过就不硬塞（开场白塞在中间很奇怪），如实说明，让用户自己决定要不要清空。
    """
    char = db.get_character(char_id)
    if char is None:
        raise HTTPException(404, "没有这个角色")
    text = (char.get("greeting") or "").strip()
    if not text:
        raise HTTPException(400, "这张卡里没有开场白")

    session_id = _private_session_id(char_id)
    if db.count_messages(session_id) > 0:
        raise HTTPException(400, "这段私聊已经有消息了 —— 开场白该在最前面，先清空再插。")
    db.append_message(session_id=session_id, role="assistant", content=text)
    return {"ok": True, "session_id": session_id, "content": text}


@router.delete("/tavern-card/{char_id}")
async def delete_imported_card(char_id: str, purge: bool = Query(True)) -> dict:
    """删掉导入的角色卡（角色介绍 / 最近对话里都能删）。

    只允许删「导入的」卡：自家四位小糖人和大老大是种子数据，删了下次启动还会补种，
    删了也白删 —— 而且会连带孤立她们的历史。`purge=true` 时把她的会话、个人记忆、
    专属画廊与立绘文件一起清掉；置 false 则只摘掉档案、留个空壳会话列表给她。
    """
    char = db.get_character(char_id)
    if char is None:
        raise HTTPException(404, "没有这个角色")
    if not char.get("imported"):
        raise HTTPException(400, "这是家里的常驻角色（种子数据），不能删 —— 删了下次启动也会被补种回来。")

    db.delete_character(char_id)

    removed = {"sessions": 0, "messages": 0, "memories": 0, "gallery": 0, "files": 0}
    if purge:
        from ..services import cleanup

        for session_id in db.list_session_ids(f"single-{char_id}"):
            for key, value in cleanup.delete_session(session_id).items():
                removed["messages"] += value
            removed["sessions"] += 1
        removed["memories"] = db.clear_memories(char_id=char_id)
        for item in db.list_gallery(owner=char_id, limit=1000):
            if _purge_gallery_item(item):
                removed["gallery"] += 1
        for key in ("portrait", "avatar"):
            url = (char.get(key) or "").strip()
            if url:
                removed["files"] += attachments.delete_by_url(url)
    return {"ok": True, "removed": removed}


def _purge_gallery_item(item: dict) -> bool:
    """画廊一条：删收藏（连带照片记忆）+ 收掉它独占的图片文件。"""
    from ..services import gallery as gal

    if not gal.remove(item["id"]):
        return False
    if not db.list_messages_by_image(item["orig"]):
        attachments.delete_by_url(item["orig"])
    return True
