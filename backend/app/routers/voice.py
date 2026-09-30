"""语音（TTS）路由：多引擎、先选引擎后选音色。

引擎：
- edge   微软在线 Neural TTS（经 edge-tts 走 WebSocket），只留「晓晓」默认女声。
- piper  本地轻量离线引擎（piper-tts + onnx），合成快、无需网络。
- sovits GPT-SoVITS 专属音色（留按钮、暂未安装）。

接口：
- GET  /api/voice/engines           引擎列表（含是否可用）
- GET  /api/voice/voices?engine=xx  某引擎下的音色列表
- POST /api/voice/tts {text, engine, voice} → 音频二进制（edge=audio/mpeg，piper=audio/wav）
"""

from __future__ import annotations

import asyncio
import io
import wave
from functools import lru_cache
from pathlib import Path

import edge_tts
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

router = APIRouter()

PIPER_DIR = Path(__file__).resolve().parent.parent.parent / "data" / "tts" / "piper"

# edge-tts 只留晓晓（用户钦点的舒服女声）。
EDGE_VOICES: list[dict] = [
    {"id": "zh-CN-XiaoxiaoNeural", "name": "晓晓 · 女（温柔，默认）"},
]

# piper 本地音色（文件需存在 data/tts/piper/ 下才列为可用）。
PIPER_VOICES: list[tuple[str, str]] = [
    ("zh_CN-huayan-medium", "华燕 · 女"),
    ("zh_CN-xiao_ya-medium", "小雅 · 女"),
    ("zh_CN-chaowen-medium", "超文 · 男"),
]


class TTSRequest(BaseModel):
    text: str
    engine: str = "edge"
    voice: str = "zh-CN-XiaoxiaoNeural"


@router.get("/voice/engines")
async def list_engines() -> list[dict]:
    return [
        {"id": "edge", "name": "Edge 在线（晓晓）", "desc": "微软在线音 · 免费 · 需网络", "available": True},
        {"id": "piper", "name": "Piper 本地（轻量）", "desc": "本地离线合成 · 低算力友好", "available": True},
        {"id": "sovits", "name": "GPT-SoVITS（专属）", "desc": "小糖人专属音色 · 尚未安装", "available": False},
    ]


@router.get("/voice/voices")
async def list_voices(engine: str = "edge") -> list[dict]:
    if engine == "edge":
        return EDGE_VOICES
    if engine == "piper":
        return [
            {"id": vid, "name": name}
            for vid, name in PIPER_VOICES
            if (PIPER_DIR / f"{vid}.onnx").exists()
        ]
    if engine == "sovits":
        return []
    raise HTTPException(status_code=400, detail=f"未知引擎 {engine}")


# piper 模型加载约 2s，缓存起来别每次请求都加载（单用户串行，锁可省）。
@lru_cache(maxsize=8)
def _load_piper(model_id: str):
    from piper import PiperVoice

    path = PIPER_DIR / f"{model_id}.onnx"
    if not path.exists():
        raise RuntimeError(f"piper 音色文件缺失：{path.name}")
    return PiperVoice.load(str(path))


def _piper_synthesize(model_id: str, text: str) -> bytes:
    """本地合成，包成 WAV（22050Hz 单声道 PCM16）。"""
    voice = _load_piper(model_id)
    chunks = list(voice.synthesize(text))
    if not chunks:
        raise RuntimeError("piper 合成为空")
    buf = io.BytesIO()
    first = chunks[0]
    w = wave.open(buf, "wb")
    w.setnchannels(first.sample_channels)
    w.setsampwidth(first.sample_width)
    w.setframerate(first.sample_rate)
    for c in chunks:
        w.writeframes(c.audio_int16_bytes)
    w.close()
    return buf.getvalue()


@router.post("/voice/tts")
async def tts(req: TTSRequest) -> Response:
    text = req.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="要朗读的文本为空")
    engine = (req.engine or "edge").strip()
    voice = (req.voice or "").strip()

    try:
        if engine == "edge":
            voice = voice or "zh-CN-XiaoxiaoNeural"
            com = edge_tts.Communicate(text, voice)
            buf = bytearray()
            async for chunk in com.stream():
                if chunk.get("type") == "audio":
                    buf.extend(chunk["data"])
            if not buf:
                raise HTTPException(status_code=502, detail="TTS 合成结果为空")
            return Response(content=bytes(buf), media_type="audio/mpeg")

        if engine == "piper":
            voice = voice or "zh_CN-huayan-medium"
            wav_bytes = await asyncio.to_thread(_piper_synthesize, voice, text)
            return Response(content=wav_bytes, media_type="audio/wav")

        if engine == "sovits":
            raise HTTPException(status_code=400, detail="GPT-SoVITS 尚未安装，专属音色敬请期待")

        raise HTTPException(status_code=400, detail=f"未知引擎 {engine}")
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"TTS 合成失败：{exc}") from exc