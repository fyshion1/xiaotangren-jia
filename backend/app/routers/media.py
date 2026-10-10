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

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from .. import db
from ..providers import openai
from ..services import attachments
from ..services.prompt import build_system_prompt

router = APIRouter(prefix="/media", tags=["media"])
ROOT = Path(__file__).resolve().parent.parent.parent / "data" / "media_tasks"
MAX_BYTES = 50 * 1024 * 1024  # 50MB
MAX_DURATION = 15  # 秒
MAX_FRAMES = 8  # 抽帧上限（token 安全）
ALLOWED_EXT = (".mp4", ".mov", ".webm", ".mkv")

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
    raw = await file.read()
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
            [ffmpeg, "-y", "-i", str(source), "-vf", "fps=1/2", "-frames:v", str(MAX_FRAMES), str(frames / FRAME_NAME)],
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

    # 抽帧那轮也要知道「在和谁说话」（§22），否则切到汐子后她的反应仍是大老大视角。
    pid = (req.persona_id or "").strip() or db.get_active_persona_id()
    persona = db.get_profile(pid) if pid else None
    system = build_system_prompt(
        character_ids=req.character_ids,
        messages=[{"role": "user", "content": req.prompt}],
        uncensored=req.uncensored,
        persona=persona,
    )
    content: list[dict] = [{"type": "text", "text": req.prompt}]
    for raw, mime in raw_frames:
        # 帧必须用 data URL（data:image/...;base64,xxx）。裸 base64 会被部分中转
        # （vsllm 等）打成 400「API key not valid」/ 上游拒绝。
        content.append({"type": "image_url", "image_url": {"url": attachments.to_data_url(raw, mime)}})
    messages: list[dict] = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": content})

    async def gen() -> AsyncIterator[str]:
        try:
            async for ev in openai.stream_chat_retry(messages, model, base_url, api_key, max_tokens=max_tokens):
                if ev["type"] == "text":
                    yield _sse("token", {"text": ev["text"]})
                elif ev["type"] == "done":
                    yield _sse("done", {"finish_reason": ev.get("finish_reason")})
                else:
                    yield _sse("error", {"message": ev["message"]})
        except Exception as exc:  # noqa: BLE001
            yield _sse("error", {"message": str(exc)})

    return StreamingResponse(gen(), media_type="text/event-stream")