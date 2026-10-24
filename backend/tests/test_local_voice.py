"""Local adapters: no model download, microphone, cloud keys or paid calls."""
import asyncio
import json
import tempfile
from pathlib import Path
import unittest
import httpx
from types import SimpleNamespace
from unittest.mock import patch

from app.services.local_voice import LocalRecognizer, LocalVoiceError, PiperSynthesizer, CosyVoiceSynthesizer, KokoroSynthesizer, meaningful_speech
from app.services.voice_stream import SpeechDelivery
from app.routers import voice_call
from fastapi import FastAPI
from fastapi.testclient import TestClient


class LocalVoiceTests(unittest.IsolatedAsyncioTestCase):
    async def test_kokoro_pcm_and_invalid_packets(self):
        for content in (b'\1\0\2\0', b'\1'):
            client = httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(200, content=content)))
            with patch('app.services.local_voice.httpx.AsyncClient', return_value=client):
                if len(content) % 2:
                    with self.assertRaises(RuntimeError):
                        _ = [c async for c in KokoroSynthesizer()('你好', '', '', 'zf_001', '')]
                else:
                    self.assertEqual(b''.join([c async for c in KokoroSynthesizer()('你好', '', '', 'zf_001', '')]), content)

    async def test_cosyvoice_modes_preserve_pcm_and_wait_for_complete_sentence(self):
        for mode in ('smooth', 'stream'):
            produced = []
            class Stream(httpx.AsyncByteStream):
                async def __aiter__(self):
                    for value in (b'\1', b'\0\2\0'):
                        produced.append(value)
                        yield value
            transport = httpx.MockTransport(lambda _: httpx.Response(200, stream=Stream()))
            client = httpx.AsyncClient(transport=transport)
            with patch('app.services.local_voice.httpx.AsyncClient', return_value=client):
                iterator = CosyVoiceSynthesizer(mode)('你好', '', '', '中文女', '')
                result = [chunk async for chunk in iterator]
            self.assertEqual(b''.join(result), b'\1\0\2\0')
            self.assertEqual(len(produced), 2)
            if mode == 'smooth':
                self.assertEqual(len(result), 1)

    async def test_cosyvoice_smooth_cancel_does_not_deliver_partial_audio(self):
        waiting = asyncio.Event()
        class Stream(httpx.AsyncByteStream):
            async def __aiter__(self):
                yield b'\1\0'
                waiting.set()
                await asyncio.Event().wait()
        client = httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(200, stream=Stream())))
        with patch('app.services.local_voice.httpx.AsyncClient', return_value=client):
            iterator = CosyVoiceSynthesizer('smooth')('你好', '', '', '中文女', '')
            pending = asyncio.create_task(anext(iterator))
            await asyncio.wait_for(waiting.wait(), 2)
            self.assertFalse(pending.done())
            pending.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await pending
            await iterator.aclose()

    async def test_endpoint_final_emitted_even_when_partial_unchanged(self):
        events = []
        async def heard(*event):
            events.append(event)
        recognizer = LocalRecognizer(heard)
        outputs = iter([('你好', False), ('你好', False), ('你好', True), ('世界', True)])
        recognizer._decode = lambda _: next(outputs)
        task = asyncio.create_task(recognizer.receive())
        try:
            for _ in range(4):
                await recognizer.audio(b'\0\0')
            async with asyncio.timeout(2):
                while len(events) < 3:
                    await asyncio.sleep(0)
            self.assertEqual([(e[0], e[1]) for e in events], [('你好', False), ('你好', True), ('世界', True)])
            self.assertEqual(events[0][2], events[1][2])
            self.assertNotEqual(events[1][2], events[2][2])
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def test_audio_backlog_resets_and_continues_without_submitting_stale_speech(self):
        events = []
        async def heard(*event):
            events.append(event)
        recognizer = LocalRecognizer(heard)
        for _ in range(50):
            await recognizer.audio(b'\0\0')
        old_utterance = recognizer.utterance
        self.assertFalse(await recognizer.audio(b'\1\0'))
        self.assertEqual(recognizer.queue.qsize(), 1)
        resets = []
        recognizer._reset = lambda: resets.append(True)
        recognizer._decode = lambda data: ('新的话', True)
        task = asyncio.create_task(recognizer.receive())
        try:
            async with asyncio.timeout(2):
                while not events:
                    await asyncio.sleep(0)
            self.assertEqual(resets, [True])
            self.assertEqual(events[0][:2], ('新的话', True))
            self.assertNotEqual(events[0][2], old_utterance)
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def test_native_runtime_failure_has_safe_specific_code(self):
        recognizer = LocalRecognizer(None)
        def fail(_):
            raise RuntimeError('private native detail')
        recognizer._decode = fail
        await recognizer.audio(b'\0\0')
        with self.assertRaises(LocalVoiceError) as caught:
            await recognizer.receive()
        self.assertEqual(str(caught.exception), 'local-asr-decode')

    def test_hesitations_filtered_but_short_answers_preserved(self):
        for text in ('嗯。', '呃，啊', '...', ''):
            self.assertFalse(meaningful_speech(text))
        for text in ('好', '不', '继续', '嗯，我想问一下', 'OK'):
            self.assertTrue(meaningful_speech(text))

    def test_endpoint_allows_thinking_pause(self):
        with patch.dict('sys.modules', {'sherpa_onnx': SimpleNamespace(OnlineRecognizer=SimpleNamespace(from_paraformer=lambda **kw: kw))}):
            options = LocalRecognizer._load()
        self.assertEqual(options['rule2_min_trailing_silence'], 2.0)
        self.assertGreaterEqual(options['rule1_min_trailing_silence'], 2.0)

    async def test_piper_delivers_chunks_without_materializing_whole_utterance(self):
        produced = []
        def chunks(_):
            for value in [b'\1\0', b'\2\0']:
                produced.append(value)
                yield SimpleNamespace(audio_int16_bytes=value)
        with patch('app.routers.voice._load_piper', return_value=SimpleNamespace(synthesize=chunks)):
            iterator = PiperSynthesizer()('你好', '', '', 'zh_CN-huayan-medium', '')
            self.assertEqual(await anext(iterator), b'\1\0')
            self.assertEqual(produced, [b'\1\0'])
            self.assertEqual(await anext(iterator), b'\2\0')
            await iterator.aclose()

    async def test_delivery_advertises_local_sample_rate(self):
        events = []
        class Synth:
            sample_rate = 22050
            async def __call__(self, *_):
                yield b'\1\0'
        async def send(event):
            events.append(event)
            if isinstance(event, dict) and event['type'] == 'audio-end':
                delivery.played(event['segment'])
        delivery = SpeechDelivery(1, '', '', '', '', send, Synth())
        try:
            await delivery.feed('你好。')
            await delivery.finish()
            self.assertEqual(next(e for e in events if isinstance(e, dict) and e['type'] == 'audio-start')['sample_rate'], 22050)
        finally:
            await delivery.close()


class LocalSocketTests(unittest.TestCase):
    def test_local_call_without_any_speech_credentials(self):
        class Recognizer:
            def __init__(self, _callback):
                pass
            async def open(self):
                pass
            async def receive(self):
                await asyncio.Event().wait()
            keepalive = receive
            async def close(self):
                pass
        config = SimpleNamespace(dashscope_api_key='', soniox_api_key='', fish_audio_api_key='',
                                 voice_fish_id='', model_chat='fake', voice_asr_model='', voice_proxy='')
        async def turn(_body, _background, emit, voice):
            await emit({'type': 'delta', 'text': '你好。'})
            await voice.finish()
            return {'assistant': {'content': '你好。'}}
        model = SimpleNamespace(synthesize=lambda _: iter([SimpleNamespace(audio_int16_bytes=b'\1\0' * 20)]))
        model_folder=tempfile.TemporaryDirectory()
        self.addCleanup(model_folder.cleanup)
        (Path(model_folder.name)/'zh_CN-huayan-medium.onnx').write_bytes(b'fixture')
        app = FastAPI()
        app.include_router(voice_call.router, prefix='/api')
        with patch.object(voice_call, 'LocalRecognizer', Recognizer), \
             patch.object(voice_call, 'get_settings', return_value=config), \
             patch.object(voice_call, 'resolve_session', return_value={'session_id': 'single-a', 'persona_id': 'me'}), \
             patch.object(voice_call, '_session_turn', turn), \
             patch.object(voice_call, 'local_asr_ready', return_value=True), \
             patch.object(voice_call, '_local_asr_installed', return_value=True), \
             patch.object(voice_call, 'PIPER_DIR', Path(model_folder.name)), \
             patch('app.routers.voice._load_piper', return_value=model), \
             TestClient(app) as client:
            with client.websocket_connect('/api/voice/call/ws', headers={'origin': 'http://testserver'}) as ws:
                ws.send_json({'character_id': 'a', 'session_id': 'single-a', 'asr_provider': 'local',
                              'tts_provider': 'piper', 'voice_id': 'zh_CN-huayan-medium'})
                self.assertEqual(ws.receive_json()['type'], 'ready')
                ws.send_json({'type': 'text', 'text': '你好'})
                got_audio = False
                while True:
                    packet = ws.receive()
                    if packet.get('bytes'):
                        got_audio = True
                        continue
                    event = json.loads(packet['text'])
                    self.assertNotIn(event['type'], ('fatal', 'error'))
                    if event['type'] == 'audio-start':
                        self.assertEqual(event['sample_rate'], 22050)
                    if event['type'] == 'audio-end':
                        ws.send_json({'type': 'played', 'generation': event['generation'], 'segment': event['segment']})
                    if event['type'] == 'done':
                        break
                self.assertTrue(got_audio)
                ws.send_json({'type': 'hangup'})
