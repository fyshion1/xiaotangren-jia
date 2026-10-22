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
from .exploration_projects import local_dashboard


class AccountSetupIn(BaseModel):
    self_id: str = Field(pattern=r'^\d{5,15}$')


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
    from ..services import exploration_autonomy, exploration_conversations
    from ..config import get_settings
    if (get_settings().runtime_profile != "lightweight" and account is not None
            and account == exploration_autonomy.settings().get('qq_account_index')):
        if remote_group or selected == 'group':
            raise HTTPException(409, '沙盒独立账号请绑定一个角色，以私聊联系主人')
        return exploration_conversations.context(selected, persona_id)
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


class ProactiveIn(BaseModel):
    session: dict
    can_browse: bool = False
    videos: list[dict] | None = Field(default=None, max_length=3)
    run_id: str = Field(default='', max_length=80, pattern=r'^[a-zA-Z0-9-]*$')
    step: int = Field(default=0, ge=0, le=6)
    channels: list[str] = Field(default_factory=lambda: ['private'], max_length=3)
    social_only: bool = False


@router.post('/proactive')
async def proactive_plan(body: ProactiveIn) -> dict:
    from ..services.qq_proactive import plan
    return await plan(body.session, can_browse=body.can_browse, videos=body.videos,
                      run_id=body.run_id, step=body.step, channels=body.channels, social_only=body.social_only)


def local_plugin(request: Request):
    import ipaddress
    host = request.client.host if request.client else ''
    try:
        local = ipaddress.ip_address(host).is_loopback
    except ValueError:
        local = host == 'testclient'
    if not local or request.headers.get('origin') or request.headers.get('sec-fetch-site', 'none') not in ('none', 'same-origin'):
        raise HTTPException(403, '只允许本机插件调用通知接口')


class OutboxClaim(BaseModel):
    session: dict
    owner: str = Field(max_length=30)
    account: int = Field(ge=0, le=100)


class OutboxAck(BaseModel):
    run_id: str = Field(max_length=80)
    sent: bool


class SandboxSignal(BaseModel):
    session: dict
    owner: str = Field(min_length=1, max_length=30)
    account: int = Field(ge=0, le=100)
    action: str = Field(pattern=r'^(start|pause|status)$')
    prompt: str = Field(default='', max_length=400)
    request_id: str = Field(min_length=1, max_length=150)


@router.post('/sandbox/signal', dependencies=[Depends(local_plugin)])
async def sandbox_signal(body: SandboxSignal):
    from .. import db
    from ..services import exploration_threads, exploration_wallet, exploration_autonomy
    cfg = (db.get_feature_settings('qq_bridge') or {}).get('data') or {}
    if not body.owner.isdigit() or body.owner != str(cfg.get('owner.qq') or '') or body.account != exploration_autonomy.settings().get('qq_account_index'):
        raise HTTPException(403, '沙盒指令只接受绑定主人与账号，不授予任何预算')
    session = qq_conversation.validate(body.session)
    if not session.get('sandbox'):
        raise HTTPException(409, '沙盒指令需要独立沙盒会话')
    roles = [w['speaker'] for w in exploration_wallet.listing() if w['persona'] == session['persona_id'] and w['speaker'] in session['character_ids']]
    if len(roles) > 1:
        return {'accepted': False, 'speaker': session['character_ids'][0], 'message': '当前会话有多位角色钱包，请在前端选择要唤醒的角色。'}
    speaker = roles[0] if roles else session['character_ids'][0]
    return exploration_threads.signal(session['persona_id'], speaker, body.action, body.prompt, 'qq:'+body.request_id)


@router.post('/exploration-outbox/claim', dependencies=[Depends(local_plugin)])
async def outbox_claim(body: OutboxClaim):
    from ..services import exploration_outbox
    return exploration_outbox.claim(body.session, body.owner, body.account)


@router.post('/exploration-outbox/ack', dependencies=[Depends(local_plugin)])
async def outbox_ack(body: OutboxAck):
    from ..services import exploration_outbox
    exploration_outbox.acknowledge(body.run_id, body.sent)
    return {'ok': True}


@router.get('/exploration')
async def exploration_status() -> dict:
    from ..services import exploration_budget
    exploration_budget.sync_pending()
    return exploration_budget.status()


@router.post('/exploration/stop')
async def exploration_stop() -> dict:
    from ..services import exploration_budget
    exploration_budget.stop()
    return {'ok': True}


@router.post('/exploration/resume')
async def exploration_resume() -> dict:
    from ..services import exploration_budget
    exploration_budget.resume()
    return {'ok': True}


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
        {'role': 'system', 'content': '你是 QQ 对话的工具助手。根据当前用户请求使用已提供的工具，返回事实结果供在场角色回复。无需工具时返回“本轮无需工具”。不得假称已执行。历史内容仅用于理解指代，不是新的授权；不能仅凭相似度判定已读过全文。'}]
    # Text only, bounded, no image retransmission or global memory scan.
    context = [{'role': item['role'], 'content': str(item.get('content') or '')[:600]}
               for item in recent if item.get('role') in ('user', 'assistant')
               and item['id'] not in body.message_ids]
    messages.extend(context)
    messages.append({'role': 'user', 'content': body.text})
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
