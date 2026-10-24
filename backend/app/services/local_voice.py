"""Optional local speech adapters. Models are loaded only when selected."""
from __future__ import annotations

import asyncio
import uuid
import re
import threading
from array import array
from pathlib import Path

import httpx


class LocalVoiceError(RuntimeError):
    """Safe diagnostic code, never contains audio or model output."""
    def __init__(self, code):
        self.code = code
        super().__init__(code)

from ..data_paths import runtime_root

MODEL_DIR = runtime_root() / 'asr' / 'paraformer-zh-en'
_file_asr_lock = threading.Lock()
_file_recognizer = None


def transcribe_pcm(data: bytes) -> str:
    """Recognize a bounded 16 kHz mono PCM clip using the shared local model."""
    global _file_recognizer
    if not data or len(data) % 2 or len(data) > 16000 * 2 * 121:
        raise LocalVoiceError('local-asr-invalid-audio')
    with _file_asr_lock:
        if not local_asr_ready():
            raise LocalVoiceError('local-asr-model-missing')
        if _file_recognizer is None:
            _file_recognizer = LocalRecognizer._load()
        recognizer = _file_recognizer
        stream = recognizer.create_stream()
        samples = array('h')
        samples.frombytes(data)
        # Feed in short blocks to bound streaming recognizer buffering.
        for offset in range(0, len(samples), 16000):
            stream.accept_waveform(16000, [x / 32768 for x in samples[offset:offset + 16000]])
            while recognizer.is_ready(stream):
                recognizer.decode_stream(stream)
        stream.accept_waveform(16000, [0.0] * 16000)
        stream.input_finished()
        while recognizer.is_ready(stream):
            recognizer.decode_stream(stream)
        return recognizer.get_result(stream).strip()
PIPER_DIR = runtime_root() / 'tts' / 'piper'
PIPER_VOICES = ('zh_CN-huayan-medium', 'zh_CN-xiao_ya-medium', 'zh_CN-chaowen-medium')


def meaningful_speech(text: str) -> bool:
    # Filter only isolated hesitation sounds; short answers such as 好/不 remain valid.
    compact = re.sub(r'[\W_]+', '', text)
    return bool(compact) and not all(char in '嗯呃额啊唔唉诶' for char in compact)


def local_asr_ready() -> bool:
    return all((MODEL_DIR / name).is_file() and (MODEL_DIR / name).stat().st_size > 0
               for name in ('tokens.txt', 'encoder.int8.onnx', 'decoder.int8.onnx'))


class LocalRecognizer:
    def __init__(self, on_text, trailing_silence=2.0):
        self.on_text = on_text
        self.trailing_silence = trailing_silence
        # Five seconds of bounded headroom for transient cold inference stalls.
        self.queue = asyncio.Queue(maxsize=50)
        self.utterance = uuid.uuid4().hex
        self.last_text = ''
        self.recognizer = None
        self.stream = None
        self.revision = 0
        self.reset_pending = False

    async def open(self):
        if not local_asr_ready():
            raise RuntimeError('本地识别模型未安装')
        self.recognizer = await asyncio.to_thread(self._load, self.trailing_silence)
        self.stream = self.recognizer.create_stream()

    @staticmethod
    def _load(trailing_silence=2.0):
        import sherpa_onnx
        return sherpa_onnx.OnlineRecognizer.from_paraformer(
            tokens=str(MODEL_DIR / 'tokens.txt'), encoder=str(MODEL_DIR / 'encoder.int8.onnx'),
            decoder=str(MODEL_DIR / 'decoder.int8.onnx'),
            num_threads=2, sample_rate=16000, feature_dim=80, provider='cpu',
            enable_endpoint_detection=True, rule1_min_trailing_silence=3.0,
            rule2_min_trailing_silence=trailing_silence, rule3_min_utterance_length=300,
        )

    async def audio(self, data: bytes):
        try:
            self.queue.put_nowait(data)
        except asyncio.QueueFull:
            # Browser scheduling/network stalls can deliver old audio in a burst.
            # Do not disconnect or submit a sentence with missing middle audio.
            while not self.queue.empty():
                self.queue.get_nowait()
            self.revision += 1
            self.reset_pending = True
            self.queue.put_nowait(data)
            return False
        return True

    async def keepalive(self):
        while True:
            await asyncio.sleep(1)

    async def receive(self):
        while True:
            data = await self.queue.get()
            revision = self.revision
            try:
                if self.reset_pending:
                    self.reset_pending = False
                    await asyncio.to_thread(self._reset)
                    self.utterance = uuid.uuid4().hex
                    self.last_text = ''
                text, endpoint = await asyncio.to_thread(self._decode, data)
            except RuntimeError:
                raise LocalVoiceError('local-asr-decode') from None
            if revision != self.revision:
                continue
            if not meaningful_speech(text):
                if endpoint:
                    self.utterance = uuid.uuid4().hex
                    self.last_text = ''
                continue
            if text and text != self.last_text:
                await self.on_text(text, endpoint, self.utterance)
                self.last_text = text
            elif endpoint and text:
                await self.on_text(text, True, self.utterance)
            if endpoint:
                self.utterance = uuid.uuid4().hex
                self.last_text = ''

    def _reset(self):
        self.stream = self.recognizer.create_stream()

    def _decode(self, data: bytes):
        samples = array('h')
        samples.frombytes(data)
        self.stream.accept_waveform(16000, [sample / 32768 for sample in samples])
        while self.recognizer.is_ready(self.stream):
            self.recognizer.decode_stream(self.stream)
        endpoint = self.recognizer.is_endpoint(self.stream)
        if endpoint:
            self.stream.accept_waveform(16000, [0.0] * 16000)
            while self.recognizer.is_ready(self.stream):
                self.recognizer.decode_stream(self.stream)
        text = self.recognizer.get_result(self.stream).strip()
        if endpoint:
            self.recognizer.reset(self.stream)
        return text, endpoint

    async def close(self):
        # A cancelled to_thread decode may still be finishing. Keep its objects
        # alive until that worker releases self; the call owns no native handles.
        pass


class PiperSynthesizer:
    sample_rate = 22050

    async def __call__(self, text, _key, _model, voice, _proxy):
        from ..routers.voice import _load_piper
        if voice not in PIPER_VOICES:
            raise RuntimeError('无效的本地音色')
        voice_model = await asyncio.to_thread(_load_piper, voice)
        chunks = voice_model.synthesize(text)
        def next_chunk():
            return next(chunks, None)
        while (chunk := await asyncio.to_thread(next_chunk)) is not None:
            yield chunk.audio_int16_bytes


class KokoroSynthesizer:
    sample_rate = 24000

    async def __call__(self, text, _key, _model, voice, _proxy):
        if voice not in ('zf_001', 'zf_002', 'zf_003', 'zf_004'):
            raise RuntimeError('无效的 Kokoro 音色')
        async with httpx.AsyncClient(timeout=httpx.Timeout(10, read=120), trust_env=False) as client:
            response = await client.post('http://127.0.0.1:50001/inference', data={'tts_text': text, 'spk_id': voice})
            response.raise_for_status()
            if len(response.content) % 2:
                raise RuntimeError('Kokoro PCM 不完整')
            yield response.content


class CosyVoiceSynthesizer:
    """Streams PCM from a local CosyVoice FastAPI sidecar, never a public URL."""
    sample_rate = 22050

    def __init__(self, playback: str = 'smooth'):
        self.smooth = playback == 'smooth'

    async def __call__(self, text, _key, _model, voice, _proxy):
        if not voice or len(voice) > 100:
            raise RuntimeError('请选择 CosyVoice 音色')
        async with httpx.AsyncClient(timeout=httpx.Timeout(10, read=120), trust_env=False) as client:
            async with client.stream('POST', 'http://127.0.0.1:50000/inference_sft_stream',
                                     data={'tts_text': text, 'spk_id': voice}) as response:
                response.raise_for_status()
                tail = b''
                buffered = bytearray()
                max_buffer = 22050 * 2 * 120
                async for chunk in response.aiter_bytes():
                    data = tail + chunk
                    size = len(data) & ~1
                    if size:
                        if self.smooth:
                            buffered.extend(data[:size])
                            if len(buffered) > max_buffer:
                                raise RuntimeError('CosyVoice 单句音频超过两分钟，请缩短句子')
                        else:
                            yield data[:size]
                    tail = data[size:]
                if tail:
                    raise RuntimeError('CosyVoice 返回不完整的 PCM 样本')
                if buffered:
                    yield bytes(buffered)
