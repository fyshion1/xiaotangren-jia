"""Streaming speech adapters and ordered, acknowledged delivery for voice calls.

Audio on the browser link is PCM16 mono: microphone 16 kHz, speaker 24 kHz.
Provider credentials live only in the connection, never in the conversation database.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import re
import struct
import time
import uuid
from collections.abc import Awaitable, Callable

from websockets.asyncio.client import connect
from async_timeout import timeout


FISH_MODELS = {'s2.1-pro-free', 's2.1-pro', 'drama-3', 's2-pro', 's1'}


def spoken_text(text: str) -> str:
    text = re.sub(r'```[\s\S]*?```', '', text)
    text = re.sub(r'<[^>]*>', '', text)
    text = re.sub(r'\[([^\]]+)\]\([^)]*\)', r'\1', text)
    text = re.sub(r'^\s*\*\*[^*\n]+\*\*\s*[：:]\s*', '', text)
    return re.sub(r'[*_`#]', '', text).strip()


class SentenceBuffer:
    """Preserve source offsets; only split at safe punctuation, flush the final tail."""

    def __init__(self):
        self.text = ''
        self.offset = 0

    def feed(self, delta: str, final: bool = False) -> list[tuple[str, int]]:
        self.text += delta
        out = []
        # Don't treat decimal points/English abbreviations as sentence boundaries.
        for match in re.finditer(r'[。！？!?；;\n]+|\.(?=\s)', self.text[self.offset:]):
            end = self.offset + match.end()
            out.append((self.text[(out[-1][1] if out else self.offset):end], end))
        if out:
            self.offset = out[-1][1]
        if final and self.offset < len(self.text):
            out.append((self.text[self.offset:], len(self.text)))
            self.offset = len(self.text)
        return out


class SpeechDelivery:
    """Bounded TTS queue. Only contiguous browser-confirmed segments enter history."""

    def __init__(self, generation: int, key: str, model: str, voice: str, proxy: str,
                 send: Callable[[dict | bytes], Awaitable[None]], synthesize=None):
        self.generation = generation
        self.key, self.model, self.voice, self.proxy = key, model, voice, proxy
        self.send = send
        self.buffer = SentenceBuffer()
        self.queue = asyncio.Queue(maxsize=8)
        self.segments: dict[int, tuple[int, asyncio.Event]] = {}
        self.acknowledged: set[int] = set()
        self.delivered_end = 0
        self.last_segment = 0
        self.synthesize = synthesize or FishSynthesizer(key, model, voice, proxy)
        self.worker = asyncio.create_task(self._speak())

    @property
    def delivered_text(self):
        return self.buffer.text[:self.delivered_end]

    async def feed(self, text: str):
        for item in self.buffer.feed(text):
            await self._put(item)

    async def _put(self, item):
        put = asyncio.create_task(self.queue.put(item))
        try:
            done, _ = await asyncio.wait([put, self.worker], return_when=asyncio.FIRST_COMPLETED)
            if self.worker in done:
                await self.worker  # propagate a synthesis error instead of blocking on a full queue
        finally:
            if not put.done():
                put.cancel()
            await asyncio.gather(put, return_exceptions=True)

    def played(self, segment: int):
        if segment not in self.segments:
            return
        self.acknowledged.add(segment)
        self.segments[segment][1].set()
        for number in sorted(self.segments):
            if number not in self.acknowledged:
                break
            self.delivered_end = self.segments[number][0]

    async def _speak(self):
        while (item := await self.queue.get()) is not None:
            raw, end = item
            text = spoken_text(raw)
            self.last_segment += 1
            number = self.last_segment
            played = asyncio.Event()
            self.segments[number] = (end, played)
            # Allow the next segment to synthesize while the browser plays this one,
            # but never build an unbounded backlog of speech.
            if number > 2:
                await asyncio.wait_for(self.segments[number - 2][1].wait(), timeout=180)
            if not text:
                self.played(number)
                continue
            await self.send({'type': 'synthesizing', 'generation': self.generation, 'segment': number})
            count = 0
            async for audio in self.synthesize(text, self.key, self.model, self.voice, self.proxy):
                if not audio:
                    continue
                if not count:
                    await self.send({'type': 'audio-start', 'generation': self.generation,
                                     'segment': number, 'sample_rate': getattr(self.synthesize, 'sample_rate', 24000)})
                count += len(audio)
                await self.send(struct.pack('<II', self.generation, number) + audio)
            if not count:
                raise RuntimeError('语音合成没有返回音频')
            await self.send({'type': 'audio-end', 'generation': self.generation, 'segment': number})
            # Backpressure includes actual playback, so long replies don't build up minutes of audio.
        for _, played in self.segments.values():
            await asyncio.wait_for(played.wait(), timeout=180)

    async def finish(self):
        for item in self.buffer.feed('', final=True):
            await self._put(item)
        await self._put(None)
        await self.worker

    async def close(self):
        self.worker.cancel()
        await asyncio.gather(self.worker, return_exceptions=True)
        if isinstance(self.synthesize, FishSynthesizer):
            await self.synthesize.close()


class FishSynthesizer:
    """Pre-open the next Fish session while this one streams, including LLM think time."""

    def __init__(self, key, model, voice, proxy):
        self.key, self.model, self.voice, self.proxy = key, model, voice, proxy
        self.spare = asyncio.create_task(self._open())

    async def _open(self):
        import ormsgpack
        ws = await connect('wss://api.fish.audio/v1/tts/live',
                           additional_headers={'Authorization': f'Bearer {self.key}', 'model': self.model},
                           proxy=self.proxy or None, open_timeout=15, close_timeout=1, max_size=4 * 1024 * 1024)
        request = {'text': '', 'reference_id': self.voice, 'format': 'pcm', 'sample_rate': 24000,
                   'latency': 'balanced', 'normalize': True}
        try:
            await ws.send(ormsgpack.packb({'event': 'start', 'request': request}))
            return ws
        except BaseException:
            await ws.close()
            raise

    async def __call__(self, text, _key, _model, _voice, _proxy):
        import ormsgpack
        spare = self.spare
        ws = await asyncio.shield(spare)
        self.spare = asyncio.create_task(self._open())
        try:
            for event in ({'event': 'text', 'text': text}, {'event': 'flush'}, {'event': 'stop'}):
                await ws.send(ormsgpack.packb(event))
            async for audio in self._receive(ws):
                yield audio
        except asyncio.CancelledError:
            ws.transport.abort()
            raise
        finally:
            await ws.close()

    async def _receive(self, ws):
        import ormsgpack
        # Never discard small tail chunks; provider packets need not align to PCM samples.
        tail = b''
        async with timeout(60):
            async for packet in ws:
                if not isinstance(packet, bytes):
                    continue
                event = ormsgpack.unpackb(packet)
                if event.get('event') == 'audio':
                    data = tail + (event.get('audio') or b'')
                    size = len(data) // 2 * 2
                    if size:
                        yield data[:size]
                    tail = data[size:]
                elif event.get('event') == 'finish':
                    if event.get('reason') == 'error' or tail:
                        raise RuntimeError('语音合成未完整结束')
                    return
        raise RuntimeError('语音合成连接提前结束')

    async def close(self):
        spare = self.spare
        if not spare.done():
            spare.cancel()
        result = (await asyncio.gather(spare, return_exceptions=True))[0]
        if not isinstance(result, BaseException):
            await result.close()


class Recognizer:
    def __init__(self, provider: str, key: str, model: str, region: str, proxy: str,
                 on_text: Callable[[str, bool, str], Awaitable[None]]):
        self.provider, self.key, self.model, self.region, self.proxy = provider, key, model, region, proxy
        self.on_text = on_text
        self.ws = None
        self.send_lock = asyncio.Lock()
        self.sequence = 0
        self.heard = ''
        self.utterance = uuid.uuid4().hex
        self.task_id = uuid.uuid4().hex
        self.last_audio = time.monotonic()

    async def open(self):
        if self.provider == 'bailian':
            host = 'dashscope-intl.aliyuncs.com' if self.region == 'singapore' else 'dashscope.aliyuncs.com'
            self.ws = await connect(f'wss://{host}/api-ws/v1/inference',
                                    additional_headers={'Authorization': f'Bearer {self.key}'},
                                    proxy=self.proxy or None, open_timeout=15, close_timeout=1)
            await self.ws.send(json.dumps({'header': {'action': 'run-task', 'task_id': self.task_id,
                                                      'streaming': 'duplex'}, 'payload': {
                'task_group': 'audio', 'task': 'asr', 'function': 'recognition', 'model': self.model,
                'parameters': {'format': 'pcm', 'sample_rate': 16000, 'heartbeat': True,
                               'vad_model': 'near_meeting_16k', 'language_hints': ['zh', 'ja', 'en']},
                'input': {}}}))
            async with timeout(15):
                async for raw in self.ws:
                    event = json.loads(raw)
                    if event.get('header', {}).get('event') == 'task-started':
                        return
                    if event.get('header', {}).get('event') == 'task-failed':
                        raise RuntimeError('百炼识别任务启动失败，请检查地域、模型和额度')
            raise RuntimeError('识别服务在启动前断开')
        else:
            self.ws = await connect('wss://stt-rt.soniox.com/transcribe-websocket',
                                    proxy=self.proxy or None, open_timeout=15, close_timeout=1)
            await self.ws.send(json.dumps({'api_key': self.key, 'model': self.model,
                                          'audio_format': 'pcm_s16le', 'sample_rate': 16000,
                                          'num_channels': 1, 'enable_endpoint_detection': True,
                                          'language_hints': ['zh', 'ja', 'en']}))

    async def audio(self, data: bytes):
        async with self.send_lock:
            if self.ws is not None:
                await self.ws.send(data)
                self.last_audio = time.monotonic()

    async def keepalive(self):
        while True:
            await asyncio.sleep(1)
            if time.monotonic() - self.last_audio < 0.9:
                continue
            if self.provider == 'bailian':
                await self.audio(b'\0' * 3200)
            else:
                async with self.send_lock:
                    await self.ws.send(json.dumps({'type': 'keepalive'}))

    async def receive(self):
        async for raw in self.ws:
            event = json.loads(raw)
            if self.provider == 'bailian':
                kind = event.get('header', {}).get('event')
                if kind == 'task-failed':
                    raise RuntimeError('百炼识别中断，请检查密钥、模型及额度')
                if kind == 'task-finished':
                    raise RuntimeError('百炼识别任务已结束')
                sentence = event.get('payload', {}).get('output', {}).get('sentence', {})
                if sentence.get('heartbeat'):
                    continue
                text, final = sentence.get('text', '').strip(), bool(sentence.get('sentence_end'))
                if text and any(c.isalnum() for c in text):
                    await self.on_text(text, final, self.utterance)
                if final:
                    self.utterance = uuid.uuid4().hex
            else:
                if event.get('error_code') or event.get('error_message'):
                    raise RuntimeError('Soniox 识别失败，请检查密钥、模型及额度')
                partial = ''
                ended = False
                for token in event.get('tokens', []):
                    text = token.get('text', '')
                    if text in ('<end>', '<fin>'):
                        ended = True
                    elif token.get('is_final'):
                        self.heard += text
                    else:
                        partial += text
                text = (self.heard + partial).strip()
                if text and any(c.isalnum() for c in text):
                    await self.on_text(text, ended, self.utterance)
                if ended:
                    self.heard = ''
                    self.utterance = uuid.uuid4().hex
        raise RuntimeError('语音识别连接提前结束')

    async def close(self):
        if self.ws is not None:
            with contextlib.suppress(Exception):
                await self.ws.close()
