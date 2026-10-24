"""语音（TTS）路由：多引擎、先选引擎后选音色。

引擎：
- edge   微软在线 Neural TTS（经 edge-tts 走 WebSocket），只留「晓晓」默认女声。
- piper  本地轻量离线引擎（piper-tts + onnx），合成快、无需网络。

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

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

router = APIRouter()

# edge-tts 两次合成之间的最小间隔（秒）：连点朗读时避免 WebSocket 连接叠着开而卡顿（§19.18）。
_EDGE_MIN_GAP = 0.25
_edge_last_at = 0.0

from ..data_paths import runtime_root

PIPER_DIR = runtime_root() / "tts" / "piper"

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
    from ..components import package_present, piper_ready
    return [
        {"id": "edge", "name": "Edge 在线（晓晓）", "desc": "微软在线音 · 需另装 online-voice · 需网络", "available": package_present('edge_tts')},
        {"id": "piper", "name": "Piper 本地（轻量）", "desc": "本地离线合成 · 需安装运行库与音色", "available": piper_ready()},
    ]


@router.get("/voice/voices")
async def list_voices(engine: str = "edge") -> list[dict]:
    from ..components import package_present
    if engine == "edge":
        return EDGE_VOICES if package_present('edge_tts') else []
    if engine == "piper":
        if not package_present('piper'):
            return []
        return [
            {"id": vid, "name": name}
            for vid, name in PIPER_VOICES
            if (PIPER_DIR / f"{vid}.onnx").exists()
        ]
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
    from ..components import package_present, piper_ready
    text = req.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="要朗读的文本为空")
    engine = (req.engine or "edge").strip()
    voice = (req.voice or "").strip()

    try:
        if engine == "edge":
            if not package_present('edge_tts'):
                raise HTTPException(status_code=409, detail="未安装在线朗读组件。请安装 online-voice 可选依赖并重启后端。")
            import edge_tts
            voice = voice or "zh-CN-XiaoxiaoNeural"
            # 暂停一下再合成（§19.18）：edge-tts 每次都要新开一条 WebSocket，
            # 连点朗读时前一条的 socket 还没关干净，新的一条就会卡住几秒 —— 用户感觉是「卡顿」。
            # 上一次合成结束到这次之间隔 250ms，给旧连接一点收尾时间；顺序点不会再有这感觉。
            global _edge_last_at
            gap = _EDGE_MIN_GAP - (asyncio.get_running_loop().time() - _edge_last_at)
            if gap > 0:
                await asyncio.sleep(gap)
            try:
                com = edge_tts.Communicate(text, voice)
                buf = bytearray()
                async for chunk in com.stream():
                    if chunk.get("type") == "audio":
                        buf.extend(chunk["data"])
            finally:
                _edge_last_at = asyncio.get_running_loop().time()
            if not buf:
                raise HTTPException(status_code=502, detail="TTS 合成结果为空")
            return Response(content=bytes(buf), media_type="audio/mpeg")

        if engine == "piper":
            if not piper_ready():
                raise HTTPException(status_code=409, detail="本地朗读运行库或音色未就绪。请运行 install-features.py 选择本地说话与听写。")
            voice = voice or "zh_CN-huayan-medium"
            wav_bytes = await asyncio.to_thread(_piper_synthesize, voice, text)
            return Response(content=wav_bytes, media_type="audio/wav")

        raise HTTPException(status_code=400, detail=f"未知引擎 {engine}")
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"TTS 合成失败：{exc}") from exc
