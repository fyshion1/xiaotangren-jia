"""Same-origin continuous voice calls; providers stay behind the backend."""
from __future__ import annotations

import asyncio
import contextlib
import json
import uuid
import logging
from urllib.parse import urlsplit
from typing import Literal

from fastapi import APIRouter, BackgroundTasks, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field
from async_timeout import timeout

from ..config import get_settings
from ..services.voice_stream import FISH_MODELS, Recognizer, SpeechDelivery
from ..services.local_voice import LocalRecognizer, LocalVoiceError, PiperSynthesizer, CosyVoiceSynthesizer, KokoroSynthesizer, local_asr_ready, PIPER_DIR, PIPER_VOICES
from .session_chat import SessionTurn, _session_turn, resolve_session

router = APIRouter(prefix='/voice/call')
logger = logging.getLogger(__name__)


class CallSetup(BaseModel):
    character_id: str = Field(min_length=1, max_length=120)
    persona_id: str = Field(default='', max_length=120)
    session_id: str = Field(min_length=1, max_length=240)
    base_url: str = Field(default='', max_length=2000)
    api_key: str = Field(default='', max_length=4000)
    model: str = Field(default='', max_length=200)
    max_tokens: int | None = Field(default=None, ge=1, le=262144)
    uncensored: bool = False
    auto_memory: bool = True
    asr_provider: str = 'bailian'
    asr_key: str = Field(default='', max_length=4000)
    asr_model: str = Field(default='', max_length=200)
    asr_region: str = 'beijing'
    fish_key: str = Field(default='', max_length=4000)
    fish_model: str = 's2.1-pro-free'
    voice_id: str = Field(default='', max_length=200)
    tts_provider: str = 'fish'
    cosyvoice_playback: Literal['smooth', 'stream'] = 'smooth'
    mode: Literal['single', 'group'] = 'single'
    feature_id: Literal['core', 'desktop_pet'] = 'core'
    input_only: bool = False


@router.get('/config')
async def capabilities():
    cfg = get_settings()
    cosyvoice_speakers = await _cosyvoice_speakers()
    kokoro_speakers = await _kokoro_speakers()
    return {'asr_provider': cfg.voice_asr_provider, 'asr_model': cfg.voice_asr_model,
            'asr_region': cfg.voice_asr_region,
            'bailian_configured': bool(cfg.dashscope_api_key),
            'soniox_configured': bool(cfg.soniox_api_key),
            'fish_configured': bool(cfg.fish_audio_api_key),
            'fish_model': cfg.fish_audio_model, 'voice_id': cfg.voice_fish_id,
            'local_asr_ready': local_asr_ready() and _local_asr_installed(),
            'piper_voices': [v for v in PIPER_VOICES if (PIPER_DIR / f'{v}.onnx').is_file()],
            'cosyvoice_ready': bool(cosyvoice_speakers), 'cosyvoice_speakers': cosyvoice_speakers,
            'kokoro_ready': bool(kokoro_speakers), 'kokoro_speakers': kokoro_speakers}


async def _kokoro_speakers():
    import httpx
    try:
        async with httpx.AsyncClient(timeout=0.5, trust_env=False) as client:
            r = await client.get('http://127.0.0.1:50001/speakers')
            r.raise_for_status()
            data = r.json()
            if data.get('sample_rate') == 24000:
                return [v for v in data.get('speakers', []) if v in ('zf_001', 'zf_002', 'zf_003', 'zf_004')]
    except (httpx.HTTPError, ValueError, TypeError):
        pass
    return []


async def _cosyvoice_ready():
    return bool(await _cosyvoice_speakers())


async def _cosyvoice_speakers():
    import httpx
    try:
        async with httpx.AsyncClient(timeout=0.5, trust_env=False) as client:
            response = await client.get('http://127.0.0.1:50000/speakers')
            response.raise_for_status()
            payload = response.json()
            if payload.get('sample_rate') == 22050:
                return [name for name in payload.get('speakers', []) if isinstance(name, str)]
    except (httpx.HTTPError, ValueError, TypeError):
        pass
    return []


def _local_asr_installed():
    import importlib.util
    return importlib.util.find_spec('sherpa_onnx') is not None


@router.websocket('/ws')
async def call_socket(ws: WebSocket):
    # Protect browser-local credentials and microphone access from cross-site socket calls.
    origin = ws.headers.get('origin', '')
    if not origin or urlsplit(origin).netloc != ws.headers.get('host', ''):
        await ws.close(code=1008)
        return
    await ws.accept()
    lock = asyncio.Lock()
    alive = True

    async def send(value):
        if not alive:
            return
        async with lock:
            if isinstance(value, bytes):
                await ws.send_bytes(value)
            else:
                await ws.send_json(value)

    reply = None
    recognizer = None
    delivery = None
    receive_task = None
    keepalive_task = None
    reader_task = None
    generation = 0
    seen = set()
    turn_lock = asyncio.Lock()
    memory_tasks = set()
    stage = 'setup'

    async def interrupt():
        nonlocal reply, delivery
        if reply is not None:
            await send({'type': 'interrupted', 'generation': generation})
            reply.cancel()
            await asyncio.gather(reply, return_exceptions=True)
            reply = None
            if delivery:
                await delivery.close()
                delivery = None
            await send({'type': 'history'})

    try:
        async with timeout(20):
            raw = await ws.receive_text()
        if len(raw) > 24000:
            raise ValueError('通话配置过长')
        setup = CallSetup.model_validate_json(raw)
        session = resolve_session(setup.character_id, setup.mode, setup.persona_id)
        if setup.session_id != session['session_id']:
            raise ValueError('身份或角色已切换，请重新拨打')
        if setup.asr_provider not in ('bailian', 'soniox', 'local') or setup.asr_region not in ('beijing', 'singapore'):
            raise ValueError('请选择有效的语音识别服务与地域')
        if setup.tts_provider not in ('fish', 'piper', 'cosyvoice', 'kokoro'):
            raise ValueError('请选择有效的语音合成服务')
        if setup.tts_provider == 'fish' and setup.fish_model not in FISH_MODELS:
            raise ValueError('不支持这个 Fish Audio 模型')
        cfg = get_settings()
        asr_key = setup.asr_key or (cfg.dashscope_api_key if setup.asr_provider == 'bailian' else cfg.soniox_api_key)
        fish_key = setup.fish_key or cfg.fish_audio_api_key
        voice_id = setup.voice_id or cfg.voice_fish_id
        if setup.asr_provider == 'local' and (not local_asr_ready() or not _local_asr_installed()):
            raise ValueError('本地识别模型尚未安装')
        if setup.asr_provider != 'local' and not asr_key:
            raise ValueError('请配置语音识别密钥')
        if not setup.input_only and setup.tts_provider == 'fish' and (not fish_key or not voice_id):
            raise ValueError('请配置 Fish Audio 密钥和角色音色 ID')
        if setup.tts_provider == 'piper' and (setup.voice_id not in PIPER_VOICES or not (PIPER_DIR / f'{setup.voice_id}.onnx').is_file()):
            raise ValueError('本地 Piper 音色不可用')
        if setup.tts_provider == 'cosyvoice' and setup.voice_id not in await _cosyvoice_speakers():
            raise ValueError('本机 CosyVoice 服务未启动或音色为空')
        if setup.tts_provider == 'kokoro' and setup.voice_id not in await _kokoro_speakers():
            raise ValueError('本机 Kokoro 服务未启动或音色不可用')
        if setup.tts_provider == 'piper':
            stage = 'piper-load'
            from .voice import _load_piper
            await asyncio.to_thread(_load_piper, setup.voice_id)
        if not setup.input_only and not (setup.model or cfg.model_chat):
            raise ValueError('请先配置聊天模型')
        asr_model = setup.asr_model or (cfg.voice_asr_model if setup.asr_provider == 'bailian' else 'stt-rt-v3')

        async def respond(text, number, speech):
            background = BackgroundTasks()
            async def emit(event):
                if event.get('type') == 'delta':
                    await send({'type': 'delta', 'generation': number, 'text': event['text']})
                    await speech.feed(event['text'])
            try:
                result = await _session_turn(SessionTurn(
                    feature_id=setup.feature_id, character_id=setup.character_id, persona_id=session['persona_id'],
                    session_id=session['session_id'], mode=setup.mode, text=text,
                    request_id='voice-' + uuid.uuid4().hex, base_url=setup.base_url,
                    api_key=setup.api_key, model=setup.model, max_tokens=setup.max_tokens,
                    uncensored=setup.uncensored, auto_memory=setup.auto_memory,
                ), background, emit, voice=speech)
                await send({'type': 'done', 'generation': number, 'assistant': result['assistant']})
                await send({'type': 'history'})
                # Memory extraction must not delay the next spoken turn or be cancelled
                # merely because the user begins speaking again.
                memory_task = asyncio.create_task(background())
                memory_tasks.add(memory_task)
                def memory_done(task):
                    memory_tasks.discard(task)
                    if not task.cancelled():
                        task.exception()
                memory_task.add_done_callback(memory_done)
            except asyncio.CancelledError:
                raise
            except Exception:
                # Never expose upstream exceptions: they may contain keys or request bodies.
                await send({'type': 'interrupted', 'generation': number})
                await send({'type': 'error', 'message': '本轮回复或合成失败，请检查聊天模型、本地音色或语音服务；你的话已保留。'})
                await send({'type': 'history'})
            finally:
                await speech.close()

        async def on_text(text, final, utterance):
            async with turn_lock:
                await take_text(text, final, utterance)

        async def take_text(text, final, utterance):
            nonlocal reply, delivery, generation
            await send({'type': 'transcript', 'text': text, 'final': final})
            if setup.input_only:
                return
            if utterance in seen:
                return
            if reply is not None:
                await interrupt()
            if not final:
                return
            seen.add(utterance)
            if len(seen) > 10000:
                raise ValueError('本次通话过长，请挂断后重新拨打')
            generation += 1
            await send({'type': 'reply-start', 'generation': generation, 'text': text})
            synthesizer = {'piper': PiperSynthesizer, 'cosyvoice': CosyVoiceSynthesizer, 'kokoro': KokoroSynthesizer}.get(setup.tts_provider)
            args = (generation, fish_key, setup.fish_model,
                    setup.voice_id if synthesizer else voice_id, cfg.voice_proxy, send)
            synth = (CosyVoiceSynthesizer(setup.cosyvoice_playback) if setup.tts_provider == 'cosyvoice'
                     else synthesizer() if synthesizer else None)
            delivery = SpeechDelivery(*args, synthesize=synth) if synth else SpeechDelivery(*args)
            reply = asyncio.create_task(respond(text, generation, delivery))

        recognizer = (LocalRecognizer(on_text) if setup.asr_provider == 'local' else
                      Recognizer(setup.asr_provider, asr_key, asr_model, setup.asr_region, cfg.voice_proxy, on_text))
        if setup.asr_provider == 'local' and setup.feature_id == 'desktop_pet':
            recognizer.trailing_silence = 0.9
        stage = 'asr-load'
        await recognizer.open()
        stage = 'audio-stream'
        await send({'type': 'ready'})
        receive_task = asyncio.create_task(recognizer.receive())
        keepalive_task = asyncio.create_task(recognizer.keepalive())

        async def read_browser():
            while True:
                packet = await ws.receive()
                if packet['type'] == 'websocket.disconnect':
                    return
                if packet.get('bytes') is not None:
                    data = packet['bytes']
                    if len(data) > 6400 or len(data) % 2:
                        raise ValueError('音频格式不正确')
                    if await recognizer.audio(data) is False:
                        logger.warning('Voice audio backlog recovered: provider=local')
                        await send({'type': 'transcript', 'text': '', 'final': False})
                        await send({'type': 'error', 'message': '收音出现积压，已恢复；刚才未发送的这句话已清除，请重新说一遍。'})
                elif packet.get('text') is not None:
                    if len(packet['text']) > 18000:
                        raise ValueError('通话消息过长')
                    event = json.loads(packet['text'])
                    if event.get('type') == 'played' and delivery and event.get('generation') == generation:
                        delivery.played(int(event['segment']))
                    elif event.get('type') == 'interrupt':
                        async with turn_lock:
                            await interrupt()
                    elif event.get('type') == 'text' and isinstance(event.get('text'), str):
                        text = event['text'].strip()
                        if text:
                            await on_text(text[:16000], True, uuid.uuid4().hex)
                    elif event.get('type') == 'hangup':
                        return

        reader_task = asyncio.create_task(read_browser())
        done, _ = await asyncio.wait([receive_task, keepalive_task, reader_task],
                                     timeout=3600, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            stage = ('asr-receive' if task is receive_task else
                     'asr-keepalive' if task is keepalive_task else 'browser-audio')
            await task
    except WebSocketDisconnect:
        pass
    except LocalVoiceError as exc:
        logger.warning('Voice call failed: stage=%s code=%s', stage, exc.code)
        with contextlib.suppress(Exception):
            await send({'type': 'fatal', 'message': f'本地识别运行失败（{exc.code}），请重新拨打。'})
    except RuntimeError as exc:
        logger.warning('Voice call failed: stage=%s exception=%s', stage, type(exc).__name__)
        # Provider RuntimeError is reported generically to avoid leaking credentials.
        with contextlib.suppress(Exception):
            await send({'type': 'fatal', 'message': f'语音连接中断（阶段：{stage}），请检查本地模型、CPU 负载或所选云端服务后重新拨打。'})
    except Exception as exc:
        logger.warning('Voice call failed: stage=%s exception=%s', stage, type(exc).__name__)
        with contextlib.suppress(Exception):
            await send({'type': 'fatal', 'message': '通话未能建立，请检查所选本地模型、音色或云端服务配置。'})
    finally:
        alive = False
        for task in (reader_task, receive_task, keepalive_task, reply):
            if task is not None:
                task.cancel()
        await asyncio.gather(*(t for t in (reader_task, receive_task, keepalive_task, reply) if t is not None),
                             return_exceptions=True)
        if delivery:
            await delivery.close()
        if recognizer:
            await recognizer.close()
        with contextlib.suppress(Exception):
            await ws.close()
