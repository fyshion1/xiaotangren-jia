"""QQ 桥的媒体落盘路由（《项目要求》§9.6.4）。

**为什么不在功能项目里自己存文件**：QQ 来的图片 / 视频 / 表情包最终要在**前端聊天记录里显示**，
而前端只认 `/api/files/<session>/…` 这一套（缩略图、原图清理、画廊收藏、单条真删的级联
全都挂在附件管道上）。所以由本体提供一条**专用的窄接口**给 QQ 桥：

    POST /api/qq-bridge/attachments   base64 + mime → 附件管道 → 返回引用 URL

和 `/api/attachments` 的区别只有两点：
1. 收的是 **base64 + 声明 mime**（不是 data URL，也不是 multipart）—— OneBot 侧拿到的就是字节；
2. **按内容签名去重**：群里的表情包会被反复发，同一份字节只落一次盘、只占一个 URL。
   （`save_image` 本身也是按 sha1 命名的，这里再挡一层是为了表情包这种超高频场景少走 IO。）

附件接口只落盘；会话接口复用当前记忆流程。启用表情识别后，标注接口会调用配置的视觉模型。
体积上限沿用附件管道（图 20MB / 视频 100MB）。
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import asyncio
import json
from pathlib import Path

from fastapi import APIRouter, HTTPException, BackgroundTasks, Request, Depends
from pydantic import BaseModel, Field
from fastapi.responses import StreamingResponse

from ..services import attachments, qq_conversation, qq_stickers

router = APIRouter(prefix="/qq-bridge", tags=["qq-bridge"])

# Browser-only setup surface; never registered as a sandbox/model tool.
from ..local_access import local_dashboard
from .. import optional_plugins


class AccountSetupIn(BaseModel):
    self_id: str = Field(pattern=r'^\d{5,15}$')


@router.post('/setup/select-basic-account', dependencies=[Depends(local_dashboard)])
async def select_basic_account(body: AccountSetupIn):
    from .. import expert_mode
    from ..services import qq_basic_settings as basic
    if expert_mode.enabled():
        raise HTTPException(409, '专家模式请使用多账号设置')
    if body.self_id not in {a['self_id'] for a in basic.choices()}:
        raise HTTPException(400, '请选择已有的 QQ 账号')
    from .nest import stop_feature
    stopped = await stop_feature('qq_bridge')
    if isinstance(stopped, dict) and stopped.get('ok') is False:
        raise HTTPException(503, '旧 QQ 桥未能停止，暂未切换账号；请先停止旧进程')
    basic.choose(body.self_id)
    return {'ok': True}


class GatewayInstallIn(BaseModel):
    consent: bool = False
    version: str = Field(max_length=100)


@router.get('/setup/diagnostics', dependencies=[Depends(local_dashboard)])
async def gateway_diagnostics():
    from ..services import qq_gateway_setup as setup
    return await asyncio.to_thread(setup.diagnostics)


@router.get('/setup/audio', dependencies=[Depends(local_dashboard)])
async def audio_setup_diagnostics():
    from ..services import qq_audio_setup
    return await asyncio.to_thread(qq_audio_setup.diagnostics)


@router.get('/setup/release', dependencies=[Depends(local_dashboard)])
async def gateway_release():
    from ..services import qq_gateway_setup as setup
    try:
        return await asyncio.to_thread(setup.release)
    except Exception:
        raise HTTPException(502, '无法读取官方发行信息（可能网络受限或 GitHub 限流），请稍后重试或从官方 Releases 手动安装。') from None


@router.get('/setup/initial-password', dependencies=[Depends(local_dashboard)])
async def gateway_initial_password():
    from ..services import qq_gateway_setup as setup
    from fastapi.responses import JSONResponse
    return JSONResponse(await asyncio.to_thread(setup.initial_password_notice), headers={'Cache-Control': 'no-store'})


@router.post('/setup/install', dependencies=[Depends(local_dashboard)])
async def gateway_install(body: GatewayInstallIn):
    from ..services import qq_gateway_setup as setup
    if not body.consent:
        raise HTTPException(400, '需要用户明确同意下载并安装第三方 SnowLuma 网关')
    try:
        return await asyncio.to_thread(setup.install, body.version)
    except Exception as exc:
        from ..services.snowluma import SnowLumaError
        raise HTTPException(400, str(exc) if isinstance(exc, SnowLumaError) else '下载安装失败，请检查网络或使用官方发行包；已有网关不会被覆盖。') from None


@router.get('/setup/choices', dependencies=[Depends(local_dashboard)])
async def setup_choices():
    from ..services import qq_account_setup as setup
    return {'items': await setup.choices()}


@router.get('/setup/accounts', dependencies=[Depends(local_dashboard)])
async def setup_accounts():
    from ..services import qq_account_setup as setup
    try:
        return {'items': await asyncio.to_thread(setup.accounts)}
    except Exception:
        raise HTTPException(400, '无法读取已登录账号，请检查网关是否启动、网页密码是否已保存') from None


@router.post('/setup/prepare', dependencies=[Depends(local_dashboard)])
async def setup_prepare(body: AccountSetupIn):
    from ..services import qq_account_setup as setup
    from ..services.snowluma import SnowLumaError
    try:
        connection = await asyncio.to_thread(setup.prepare, body.self_id)
    except SnowLumaError as exc:
        raise HTTPException(400, str(exc)) from None
    except Exception:
        raise HTTPException(400, '自动配置失败，请检查网关，或使用手工配置') from None
    try:
        lists = await setup.contacts(connection)
        return {'connection': connection, **lists}
    except Exception:
        return {'connection': connection, 'warning': '连接信息已填好，但名单读取失败；请确认该 QQ 网关已就绪后重试。原有勾选保持不变。'}

# 表情包：QQ 的表情通常很小，单独标一个 source 便于前端区分渲染。
STICKER_MAX_BYTES = 5 * 1024 * 1024


@router.get("/context")
async def conversation_context(selected: str, remote_group: bool = False, persona_id: str = "", account: int | None = None) -> dict:
    from .. import expert_mode
    if not expert_mode.enabled() and account is not None:
        if account != 0:
            raise HTTPException(409, '非专家模式只能使用当前绑定的一个 QQ')
        from ..services import qq_basic_settings as basic
        basic.require_ready()
        # The activity plugin refers to original expert slots. Do not accidentally
        # treat an ordinary selected account as the archived sandbox's slot zero.
        data = basic.saved()
        chosen = basic.effective(data)['accounts'][0].get('self_id')
        original = [r for r in data.get('accounts', []) if r.get('enabled', True)]
        account = next((i for i, r in enumerate(original) if r.get('self_id') == chosen), account)
    if optional_plugins.expert_mode.plugin_installed():
        value = optional_plugins.load().conversation_context(selected, remote_group, persona_id, account)
        if value is not None:
            return value
    return qq_conversation.context(selected, remote_group, persona_id)


class WebSyncIn(BaseModel):
    session: dict
    account: str = Field(min_length=1, max_length=120)
    target: str = Field(min_length=1, max_length=120)
    ack: int = Field(default=0, ge=0)


@router.post('/web-sync')
async def web_sync(body: WebSyncIn) -> dict:
    from ..services.qq_web_sync import poll
    return await asyncio.to_thread(poll, body.session, body.account, body.target, body.ack)


class QQMessageIn(BaseModel):
    session: dict
    receipt_id: str = Field(min_length=1, max_length=200)
    text: str = Field(default="", max_length=16000)
    media: list[dict] = Field(default_factory=list, max_length=12)
    speaker: str = Field(default="", max_length=120)
    platform_id: str = Field(default="", max_length=120)
    annotate_stickers: bool = True


@router.post("/inbound")
async def inbound(body: QQMessageIn, background: BackgroundTasks) -> dict:
    if body.session.get('sandbox'):
        body.annotate_stickers = False
    result = await asyncio.to_thread(qq_conversation.store, body.session, body.receipt_id,
                                    "user", body.text, body.media)
    urls = [m["url"] for m in body.media if m.get("type") == "sticker" and m.get("url")]
    if urls and body.annotate_stickers:
        background.add_task(qq_stickers.describe_pending, urls)
    return result


class QQReplyIn(BaseModel):
    hold_for_delivery: bool = False
    session: dict
    message_ids: list[str] = Field(min_length=1, max_length=1200)
    stickers_allowed: bool = False
    sticker_urls: list[str] = Field(default_factory=list, max_length=300)
    max_bubbles: int = Field(default=4, ge=1, le=8)
    tool_context: str = Field(default="", max_length=8000)


class QQToolsIn(BaseModel):
    session: dict
    actor_id: str = Field(min_length=1, max_length=40)
    text: str = Field(max_length=24000)
    message_ids: list[str] = Field(default_factory=list, max_length=100)


@router.post('/tools')
async def conversation_tools(body: QQToolsIn):
    import uuid
    from ..services import agent_tools, intent_router
    from .nest import _setting, _effective_config
    session = qq_conversation.validate(body.session)
    config = agent_tools.settings()
    owner = str(_setting('qq_bridge', 'owner.qq', '') or '')
    if not owner or body.actor_id != owner or not agent_tools.available('qq_bridge', session['persona_id'], config):
        return {'context': '', 'status': 'disabled'}
    # Resolve only this validated session and stop at this turn's inbound messages.
    recent = []
    if body.message_ids:
        recent = qq_conversation.history(session, body.message_ids)[-6:]
    decision = await asyncio.to_thread(intent_router.classify, body.text)
    if not decision.needs_tools:
        return {'context': '', 'status': 'not_needed', 'routing': decision.payload()}
    messages = [
        {'role': 'system', 'content': '你是 QQ 对话的工具助手。只处理最后一条明确标为【当前请求】的用户消息。历史仅用于当前请求有明确指代时消歧，不是待办队列，不得继续执行旧请求；问候、确认和闲聊必须返回“本轮无需工具”，不得因历史出现未完成搜索就自行续查。需要工具时使用已提供工具，返回事实结果供在场角色回复。不得假称已执行；不能仅凭相似度判定已读过全文。'}]
    # Text only, bounded, no image retransmission or global memory scan.
    context = [{'role': item['role'], 'content': str(item.get('content') or '')[:600]}
               for item in recent if item.get('role') in ('user', 'assistant')
               and item['id'] not in body.message_ids]
    messages.extend(context)
    messages.append({'role': 'user', 'content': '【当前请求】\n' + body.text})
    result = await agent_tools.generate(messages,
        _effective_config('qq_bridge'), config, persona_id=session['persona_id'],
        session_id=session['session_id'], feature_id='qq_bridge',
        request_id='qq-tools-' + uuid.uuid4().hex, max_tokens=1200)
    # Include a compact execution receipt so the QQ brain can distinguish a
    # saved record from a denied/failed tool call before replying to the user.
    receipts = [{'name': item.get('name'), 'ok': item.get('ok'), 'truncated': item.get('truncated', False),
                 'output': item.get('output', '')[:3500 if item.get('name') in ('web_search', 'lyrics_search', 'lyrics_read') else 500]}
                for item in result.tool_receipts]
    return {'context': result.content[:8000], 'status': result.status, 'tool_receipts': receipts,
            'routing': decision.payload()}


@router.post("/reply")
async def conversation_reply(body: QQReplyIn) -> dict:
    try:
        return await asyncio.wait_for(_conversation_reply(body), 360)
    except asyncio.TimeoutError as exc:
        raise HTTPException(504, '本轮回复等待超过360秒，已停止等待；上游可能已计费，不自动重试，原始消息已保留') from exc


@router.post('/reply-stream')
async def conversation_reply_stream(body: QQReplyIn):
    session = qq_conversation.validate(body.session)
    async def events():
        from ..services.turn_coordinator import turn
        queue = asyncio.Queue(maxsize=16)
        async def produce():
            try:
                async with asyncio.timeout(360):
                    async with turn(session['persona_id'], session['character_ids']) as lease:
                        await queue.put({'type': 'session', 'coordination_id': lease['owner']})
                        async def action(value):
                            await queue.put({'type': 'action', 'action': value})
                        result = await qq_conversation.reply(body.session, body.message_ids,
                            stickers_allowed=body.stickers_allowed, sticker_urls=body.sticker_urls,
                            max_bubbles=body.max_bubbles, tool_context=body.tool_context, emit_action=action)
                        lease['hold'] = body.hold_for_delivery
                        await queue.put({'type': 'done', **result, 'coordination_id': lease['owner']})
            except Exception as exc:
                detail = exc.detail if isinstance(exc, HTTPException) else (
                    '本轮流式回复等待超时，原文已保留；不自动重试' if isinstance(exc, TimeoutError) else
                    '本轮流式回复未完成：' + type(exc).__name__)
                await queue.put({'type': 'error', 'message': detail})
            finally:
                if not asyncio.current_task().cancelling():
                    await queue.put(None)
        task = asyncio.create_task(produce())
        try:
            while True:
                try:
                    item = await asyncio.wait_for(queue.get(), 15)
                except TimeoutError:
                    yield json.dumps({'type': 'status', 'text': '仍在等待完整气泡，不自动重试'}, ensure_ascii=False) + '\n'
                    continue
                if item is None:
                    break
                yield json.dumps(item, ensure_ascii=False) + '\n'
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
    return StreamingResponse(events(), media_type='application/x-ndjson')


async def _conversation_reply(body: QQReplyIn) -> dict:
    from ..services.turn_coordinator import turn
    session = qq_conversation.validate(body.session)
    async with turn(session['persona_id'], session['character_ids']) as lease:
        result = await qq_conversation.reply(body.session, body.message_ids,
            stickers_allowed=body.stickers_allowed, sticker_urls=body.sticker_urls,
            max_bubbles=body.max_bubbles, tool_context=body.tool_context)
        if body.hold_for_delivery:
            lease['hold'] = True
            return {**result, 'coordination_id': lease['owner']}
        return result


@router.post('/lease')
async def sending_lease(session: dict):
    from ..services.turn_coordinator import refresh
    resolved = qq_conversation.validate(session)
    if not refresh(session.get('coordination_id', ''), resolved['persona_id'], resolved['character_ids']):
        raise HTTPException(409, '这轮发送资格已过期，请停止旧计划并重新生成')
    return {'ok':True}


@router.post("/delivered")
async def delivered(body: QQMessageIn) -> dict:
    return await asyncio.to_thread(qq_conversation.store, body.session, body.receipt_id,
        "assistant", body.text, body.media, speaker=body.speaker, platform_id=body.platform_id)


class QQFinishIn(BaseModel):
    session: dict
    auto_memory: bool = True


@router.post("/finish")
async def finish(body: QQFinishIn, background: BackgroundTasks) -> dict:
    from .. import db
    from .session_chat import _extract
    from .nest import _effective_config
    session = qq_conversation.validate(body.session, current=False)
    session['source_feature_id'] = 'qq_bridge'
    if body.session.get('coordination_id'):
        from ..services.turn_coordinator import release
        release(body.session['coordination_id'])
    if body.auto_memory:
        from ..services.memory_batch import enqueue
        enqueue((session['persona_id'], session['session_id']), _extract,
                db.list_messages(session["session_id"], limit=60), session, _effective_config("qq_bridge"))
    return {"ok": True}


@router.get("/stickers")
async def sticker_catalog() -> dict:
    return {"items": await asyncio.to_thread(qq_stickers.catalog), "emotions": qq_stickers.EMOTIONS}


class StickerDescribeIn(BaseModel):
    url: str = ""
    force: bool = False


@router.post("/stickers/describe")
async def describe_stickers(body: StickerDescribeIn, background: BackgroundTasks) -> dict:
    if body.url:
        if body.url not in qq_stickers.library():
            raise HTTPException(404, "这张图不在表情包库中")
        background.add_task(qq_stickers.describe, body.url, force=body.force)
    else:
        background.add_task(qq_stickers.describe_pending, qq_stickers.library())
    return {"ok": True}


class StickerEditIn(BaseModel):
    description: str = Field(min_length=1, max_length=300)
    emotions: list[str] = Field(default_factory=list, max_length=3)


@router.patch("/stickers/{sticker_id}")
async def edit_sticker(sticker_id: str, body: StickerEditIn) -> dict:
    if not body.description.strip():
        raise HTTPException(422, "请填写表情描述")
    if any(e not in qq_stickers.EMOTIONS for e in body.emotions):
        raise HTTPException(422, "请选择已有的情绪标签")
    item = next((c for c in await asyncio.to_thread(qq_stickers.catalog) if c["id"] == sticker_id), None)
    if not item:
        raise HTTPException(404, "这张表情原图已删除或已移出图库")
    await asyncio.to_thread(qq_stickers.save, sticker_id, body.description.strip(), body.emotions)
    return await asyncio.to_thread(qq_stickers.entry, item["url"])


@router.get("/group-session")
async def group_session(persona_id: str = "") -> dict:
    """复用普通群聊的成员与身份解析，不暴露模型配置。"""
    from .. import db
    from .session_chat import resolve_session
    characters = db.list_characters()
    if not characters:
        raise HTTPException(409, "家里还没有可出场的角色")
    return resolve_session(characters[0]["id"], "group", persona_id)


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

    if not is_video and len(raw) <= STICKER_MAX_BYTES:
        # 已收藏原图跨会话复用，避免为同一表情再建一份物理文件。
        for url in await asyncio.to_thread(qq_stickers.library):
            path = attachments._resolve_local(url)
            if path and path.is_file() and path.stat().st_size == len(raw) and path.read_bytes() == raw:
                import mimetypes
                saved = attachments.save_image(path.parent.parent.name, raw,
                    mimetypes.guess_type(path.name)[0] or mime, source=source)
                return {**saved, "digest": digest, "deduped": True}

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
