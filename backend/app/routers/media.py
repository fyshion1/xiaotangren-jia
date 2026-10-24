"""媒体（视频）路由：浏览器上传视频 → 本地 ffprobe/ffmpeg 抽帧 → 抽帧送视觉模型。

对应《项目要求》/ docs/media-import-plan.md 的视频一节：
- 上传后**只在本地**做预处理：探测时长 / 分辨率 / 音轨，抽 ≤8 张关键帧。
- **完整视频绝不直接发给模型** —— token 消耗有上限（≤8 帧）。
- 第一版只支持 15 秒以内、50 MB 以内的视频。
- ffmpeg / ffprobe 未装 → 明确报错（503），不自动调用系统范围安装。

数据流：
    POST /media/video/analyze   上传视频 → 抽帧 → 返回 task_id + 帧 URL（待确认）
    POST /media/video/chat      （可选预览后）把抽好的帧以「多图」形式送视觉模型，SSE 流式回复
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import uuid
from collections.abc import AsyncIterator
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from .. import db
from ..providers import openai
from ..services import attachments
from .chat import ChatMessage, _to_openai_messages, _resolve_persona, context_debug

router = APIRouter(prefix="/media", tags=["media"])
from ..data_paths import runtime_root

ROOT = runtime_root() / "media_tasks"
MAX_BYTES = 50 * 1024 * 1024  # 50MB
MAX_DURATION = 15  # 秒
MAX_FRAMES = 8  # 抽帧上限（token 安全）
ALLOWED_EXT = (".mp4", ".mov", ".webm", ".mkv")


@router.post('/audio/transcribe-local')
async def transcribe_local_audio(request: Request):
    """Bounded, temporary audio upload; never contacts a cloud provider."""
    import asyncio
    import tempfile
    from ..services.local_voice import transcribe_pcm
    data = bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
        if len(data) > 25 * 1024 * 1024:
            raise HTTPException(413, '语音超过 25MB')
    if not data:
        raise HTTPException(400, '语音为空')
    from ..services import qq_audio_setup
    checks = await asyncio.to_thread(qq_audio_setup.diagnostics)
    needed = dict(checks['checks'])
    if not data.startswith((b'\x02#!SILK_V3', b'#!SILK_V3')):
        needed['pilk'] = True  # Non-SILK inputs do not require QQ's decoder.
    if not all(needed.values()):
        raise HTTPException(503, qq_audio_setup.missing_message(needed))
    ffmpeg = qq_audio_setup.ffmpeg_executable()
    if not ffmpeg:
        raise HTTPException(503, '本地语音识别需要 ffmpeg')
    def run():
        with tempfile.TemporaryDirectory(prefix='local-asr-') as folder:
            source = Path(folder) / 'audio'
            source.write_bytes(data)
            # QQ sends Tencent SILK, which standard ffmpeg builds cannot decode.
            if data.startswith((b'\x02#!SILK_V3', b'#!SILK_V3')):
                try:
                    import pilk
                    pcm = Path(folder) / 'decoded.pcm'
                    pilk.decode(str(source), str(pcm), 16000)
                    if pcm.stat().st_size > 120 * 16000 * 2:
                        raise HTTPException(422, '语音超过 120 秒')
                    source = pcm
                    input_options = ['-f', 's16le', '-ar', '16000', '-ac', '1']
                except ImportError:
                    raise HTTPException(503, 'QQ SILK 解码需要安装 pilk（local-voice 依赖）') from None
                except (OSError, ValueError, RuntimeError):
                    raise HTTPException(422, 'QQ SILK 语音解码失败') from None
            else:
                input_options = []
            try:
                result = subprocess.run([ffmpeg, '-v', 'error', *input_options, '-i', str(source),
                    '-t', '121', '-ar', '16000', '-ac', '1', '-f', 's16le', 'pipe:1'],
                    capture_output=True, timeout=45, check=True)
            except (subprocess.SubprocessError, OSError):
                raise HTTPException(422, '语音解码失败，请检查网关音频格式') from None
            if len(result.stdout) > 120 * 16000 * 2:
                raise HTTPException(422, '语音超过 120 秒')
            try:
                text = transcribe_pcm(result.stdout)
            except (RuntimeError, ImportError):
                raise HTTPException(503, '本地识别不可用，请检查模型和 sherpa-onnx 依赖') from None
            if not text:
                raise HTTPException(422, '本地识别未检测到文字')
            return {'text': text, 'provider': 'local'}
    return await asyncio.to_thread(run)

# 帧文件名：MediaStorage 上传附件存成 "video-<hex>.jpg"（thumb 由 /thumb/ 规则加 .jpg 推导）。
# 所以这里生成的帧不能再叫 video-*.jpg（会和缩略图推导撞名），统一换成交付过的名字。
FRAME_NAME = "frame-%02d.jpg"


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def _task_folder(task_id: str) -> Path:
    """校验 task_id 来自 ROOT 之下，防路径穿越。"""
    if not re.fullmatch(r"[A-Za-z0-9_-]+", task_id or ""):
        raise HTTPException(400, "任务不存在")
    folder = (ROOT / task_id).resolve()
    if ROOT.resolve() not in folder.parents:
        raise HTTPException(400, "任务不存在")
    return folder


def _cleanup(dir: Path) -> None:  # noqa: A002 - 与 http 模块的 Path 无关，纯粹叫顺口
    try:
        shutil.rmtree(dir, ignore_errors=True)
    except Exception:  # noqa: BLE001
        pass


def _resolve_task(task_id: str) -> Path:
    """按 id 找任务目录，找不到 → 404。"""
    folder = _task_folder(task_id)
    if not folder.is_dir():
        raise HTTPException(404, "任务不存在或已过期")
    return folder


def _load_frame(frame_url: str) -> tuple[bytes, str]:
    """把 `/api/media-files/{task_id}/frames/{name}` 解析回本地文件 → (字节, mime)。

    data URL / 任意 http 地址一律拒绝 —— 只认本项目自己抽出来的帧，防 SSRF。
    """
    m = re.fullmatch(r"/api/media-files/(?P<task>[A-Za-z0-9_-]+)/frames/(?P<name>[A-Za-z0-9_.-]+)", frame_url or "")
    if not m:
        raise HTTPException(400, "帧地址不合法，请重新上传视频")
    folder = _task_folder(m.group("task"))
    path = (folder / "frames" / m.group("name")).resolve()
    if folder / "frames" not in path.parents or not path.is_file():
        raise HTTPException(400, "帧不存在，请重新上传视频")
    return path.read_bytes(), "image/jpeg"


def _frame_url(folder: Path, task_id: str, p: Path) -> str:
    return f"/api/media-files/{task_id}/frames/{p.name}"


@router.post("/video/analyze")
async def analyze_video(file: UploadFile = File(...)) -> dict:  # noqa: B008
    """上传视频 → 本地探测 + 抽帧 → 返回任务与帧列表（前端预览 / 直接发都靠它）。"""
    name = (file.filename or "video").lower()
    if not (file.content_type or "").startswith("video/") and not name.endswith(ALLOWED_EXT):
        raise HTTPException(400, "请上传视频文件")
    raw = await file.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise HTTPException(413, "视频不能超过 50 MB")
    ffprobe = shutil.which("ffprobe")
    ffmpeg = shutil.which("ffmpeg")
    if not ffprobe or not ffmpeg:
        raise HTTPException(503, "未找到项目可用的 ffmpeg/ffprobe，请在项目配置中提供路径")
    task_id = f"video-{uuid.uuid4().hex[:12]}"
    folder = ROOT / task_id
    folder.mkdir(parents=True, exist_ok=True)
    source = folder / ("source" + (Path(name).suffix or ".mp4"))
    source.write_bytes(raw)
    try:
        probe = subprocess.run(  # noqa: S603
            [ffprobe, "-v", "error", "-show_format", "-show_streams", "-of", "json", str(source)],
            capture_output=True, text=True, timeout=15, check=True,
        )
        metadata = json.loads(probe.stdout)
        duration = float((metadata.get("format") or {}).get("duration") or 0)
        if duration > MAX_DURATION:
            raise HTTPException(413, f"视频不能超过 {MAX_DURATION} 秒")
        frames = folder / "frames"
        frames.mkdir()
        subprocess.run(  # noqa: S603
            [ffmpeg, "-y", "-i", str(source), "-vf", "fps=1/2,scale=1280:1280:force_original_aspect_ratio=decrease", "-frames:v", str(MAX_FRAMES), str(frames / FRAME_NAME)],
            capture_output=True, timeout=30, check=True,
        )
    except HTTPException:
        _cleanup(folder)
        raise
    except (subprocess.SubprocessError, json.JSONDecodeError, ValueError) as exc:
        _cleanup(folder)
        raise HTTPException(422, "视频无法解析，请确认文件完整") from exc

    # 失败（黑帧 / 纯色）时 ffmpeg 也可能成功 —— 但那只是「没抽到东西」，
    # 文件本身已被认定可解析，这里不按「能否抽满」当失败，交给用户看预览决定。
    picked = sorted(frames.glob("*.jpg"))
    frame_urls = [_frame_url(folder, task_id, p) for p in picked]
    if not frame_urls:
        _cleanup(folder)
        raise HTTPException(422, "没抽出任何帧，请换个视频试试")
    return {
        "task_id": task_id,
        "status": "ready",
        "metadata": metadata,
        "frame_count": len(frame_urls),
        "frames": frame_urls,
        "commit_required": False,
    }


class VideoChatRequest(BaseModel):
    saved_message_id: str = ""
    messages: list[ChatMessage] = Field(default_factory=list)
    task_id: str
    frames: list[str] = Field(default_factory=list)  # /api/media-files/... 帧 URL
    prompt: str = "（这是发给你的视频抽帧）请看帧回答。"
    character_ids: list[str] = Field(default_factory=list)
    persona_id: str | None = None  # 当前用户身份（§22）
    base_url: str | None = None
    api_key: str | None = None
    model: str | None = None
    uncensored: bool = False
    max_tokens: int | None = None


@router.post("/video/chat")
async def video_chat(req: VideoChatRequest) -> StreamingResponse:
    """把抽好的帧以「多图 + 文本」送视觉模型，SSE 流式回复（token / done / error）。"""
    from ..config import get_settings

    settings = get_settings()
    base_url = req.base_url or settings.model_base_url
    api_key = req.api_key or settings.model_api_key
    model = req.model or settings.model_vision
    max_tokens = req.max_tokens if req.max_tokens and req.max_tokens > 0 else None
    task = _resolve_task(req.task_id)
    frames_dir = task / "frames"
    if not frames_dir.is_dir():
        raise HTTPException(404, "任务帧目录不存在，请重新上传视频")

    # 只收本项目自己的帧 URL；同一个任务目录下，最多发 8 张（token 安全线）。
    frames = req.frames or [f"/api/media-files/{req.task_id}/frames/{p.name}" for p in sorted(frames_dir.glob("*.jpg"))]
    if len(frames) > MAX_FRAMES:
        raise HTTPException(400, f"帧数超过 {MAX_FRAMES} 张，请重新上传更短的视频")
    raw_frames: list[tuple[bytes, str]] = []
    for url in frames:
        raw_frames.append(_load_frame(url))

    saved = db.get_message(req.saved_message_id) if req.saved_message_id else None
    # 确认原视频与帧已转入可管理的附件库后，才回收临时抽帧任务。
    if saved and saved.get('image_source') == 'video' and saved.get('image', '').startswith('/api/files/') and saved.get('frames'):
        _cleanup(task)

    history = [*req.messages, ChatMessage(role="user", content=req.prompt, images=[
        attachments.to_data_url(raw, mime) for raw, mime in raw_frames
    ])]
    messages = _to_openai_messages(history, req.character_ids, req.uncensored, _resolve_persona(req.persona_id))

    async def gen() -> AsyncIterator[str]:
        from ..services.conversation_runtime import transient_stream
        yield _sse("context", context_debug(messages, model))
        async for event in transient_stream(messages, model, base_url, api_key, max_tokens=max_tokens, source="media"):
            kind = event.pop('type')
            yield _sse(kind, event)

    return StreamingResponse(gen(), media_type="text/event-stream")
