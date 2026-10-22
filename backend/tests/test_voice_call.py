"""No provider keys/network: exercise audio tails, cancellation, and shared history."""
import asyncio
import json
import struct
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import ormsgpack
from fastapi import BackgroundTasks, FastAPI
from fastapi.testclient import TestClient

from app import db
from app.routers import session_chat, voice_call
from app.services.voice_stream import FishSynthesizer, Recognizer, SentenceBuffer, SpeechDelivery


class BufferTests(unittest.TestCase):
    def test_split_across_deltas_and_tail_are_lossless(self):
        parser = SentenceBuffer()
        pieces = []
        text = '你好！今天是3.14。Hello world. 最后没有标点'
        for c in text:
            pieces.extend(parser.feed(c))
        pieces.extend(parser.feed('', final=True))
        self.assertEqual(''.join(s for s, _ in pieces), text)
        self.assertEqual(pieces[-1][1], len(text))
        self.assertIn('今天是3.14。', [s for s, _ in pieces])


class DeliveryTests(unittest.IsolatedAsyncioTestCase):
    async def test_tiny_audio_tail_and_contiguous_playback_confirmation(self):
        events = []
        async def send(event):
            events.append(event)
        async def synth(*_):
            yield b'\1\0' * 600
            yield b'\2\0'  # must not be dropped for being <= 1024 bytes
        delivery = SpeechDelivery(7, '', '', '', '', send, synth)
        self.addAsyncCleanup(delivery.close)
        await delivery.feed('第一句。第二句。尾巴')
        finish = asyncio.create_task(delivery.finish())
        async def until(predicate):
            async with asyncio.timeout(2):
                while not predicate():
                    await asyncio.sleep(0)
        await until(lambda: sum(isinstance(e, dict) and e['type'] == 'audio-end' for e in events) == 2)
        self.assertFalse(finish.done())
        delivery.played(2)
        self.assertEqual(delivery.delivered_text, '')
        delivery.played(1)
        self.assertEqual(delivery.delivered_text, '第一句。第二句。')
        await until(lambda: any(isinstance(e, dict) and e['type'] == 'audio-end' and e['segment'] == 3 for e in events))
        delivery.played(3)
        await asyncio.wait_for(finish, 2)
        self.assertEqual(delivery.delivered_text, '第一句。第二句。尾巴')
        packets = [e for e in events if isinstance(e, bytes)]
        self.assertEqual(sum(len(p) - 8 for p in packets), 1202 * 3)
        self.assertEqual(struct.unpack('<II', packets[-1][:8]), (7, 3))

    async def test_synthesis_error_unblocks_producer(self):
        async def fail(*_):
            raise RuntimeError('fake provider failure')
            yield b''
        async def send(_):
            pass
        delivery = SpeechDelivery(1, '', '', '', '', send, fail)
        self.addAsyncCleanup(delivery.close)
        with self.assertRaises(RuntimeError):
            await asyncio.wait_for(delivery.feed('一句。' * 40), 2)

    async def test_fish_odd_packet_boundaries_preserve_every_sample(self):
        class FakeSocket:
            def __init__(self, packets):
                self.packets = iter(packets)
            def __aiter__(self):
                return self
            async def __anext__(self):
                try:
                    return ormsgpack.packb(next(self.packets))
                except StopIteration:
                    raise StopAsyncIteration
        synth = object.__new__(FishSynthesizer)
        packets = [{'event': 'audio', 'audio': b'\x01'}, {'event': 'audio', 'audio': b'\0\x02\0'},
                   {'event': 'finish', 'reason': 'stop'}]
        chunks = [c async for c in synth._receive(FakeSocket(packets))]
        self.assertEqual(b''.join(chunks), b'\x01\0\x02\0')
        with self.assertRaises(RuntimeError):
            _ = [c async for c in synth._receive(FakeSocket([{'event': 'audio', 'audio': b'\x01'}, {'event': 'finish'}]))]

    async def test_bailian_partials_replace_and_empty_heartbeats_do_not_interrupt(self):
        events = []
        async def heard(*args):
            events.append(args)
        recognizer = Recognizer('bailian', '', '', 'beijing', '', heard)
        class FakeSocket:
            def __aiter__(self):
                self.items = iter([
                    {'heartbeat': True, 'text': 'ignore'}, {'text': ''},
                    {'text': '你'}, {'text': '你好'}, {'text': '你好世界', 'sentence_end': True},
                    {'text': 'English', 'sentence_end': True},
                ])
                return self
            async def __anext__(self):
                try:
                    return json.dumps({'payload': {'output': {'sentence': next(self.items)}}})
                except StopIteration:
                    raise StopAsyncIteration
        recognizer.ws = FakeSocket()
        with self.assertRaises(RuntimeError):
            await recognizer.receive()
        self.assertEqual([(e[0], e[1]) for e in events], [('你', False), ('你好', False), ('你好世界', True), ('English', True)])
        self.assertEqual(events[0][2], events[2][2])
        self.assertNotEqual(events[2][2], events[3][2])


class HistoryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        for name, value in [('DATA_DIR', Path(self.temp.name)), ('DB_PATH', Path(self.temp.name) / 'test.db')]:
            p = patch.object(db, name, value)
            p.start()
            self.addCleanup(p.stop)
        db.init_db()
        db.set_brain_default({'base_url': 'http://brain.test/v1', 'model': 'test', 'api_key': 'test-key'})
        self.saved = []
        p = patch.object(session_chat, '_archive_messages', lambda rows, _: self.saved.extend(rows))
        p.start()
        self.addCleanup(p.stop)
        p = patch.object(session_chat, '_to_openai_messages', lambda messages, *_, **__: [{'role': m.role, 'content': m.content} for m in messages])
        p.start()
        self.addCleanup(p.stop)

    async def test_interruption_saves_only_confirmed_prefix_and_releases_turn(self):
        reached = asyncio.Event()
        speech = SimpleNamespace(delivered_text='已经说完。')
        async def finish():
            reached.set()
            await asyncio.Event().wait()
        speech.finish = finish
        async def stream(*_, **__):
            yield {'type': 'text', 'text': '已经说完。还没有说的秘密。'}
            yield {'type': 'done'}
        body = session_chat.SessionTurn(feature_id='core', character_id='dashiyin', session_id='single-dashiyin',
                                       text='你好', request_id='voice-cancel-001', base_url='https://fake.invalid', model='fake', auto_memory=False)
        with patch.object(session_chat.openai, 'stream_chat_retry', stream):
            task = asyncio.create_task(session_chat._session_turn(body, BackgroundTasks(), voice=speech))
            await asyncio.wait_for(reached.wait(), 2)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        rows = db.list_messages('single-dashiyin')
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[-1]['content'], '已经说完。\n（语音被打断）')
        self.assertNotIn('秘密', rows[-1]['content'])
        with db._tx() as conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM chat_leases').fetchone()[0], 0)
        self.assertEqual(len(self.saved), 2)


class SocketTests(unittest.TestCase):
    def test_dictation_needs_no_tts_key_or_chat_and_preserves_group_target(self):
        class FakeRecognizer:
            def __init__(self, callback): self.callback = callback
            async def open(self): pass
            async def receive(self): await asyncio.Event().wait()
            async def keepalive(self): await asyncio.Event().wait()
            async def audio(self, data): await self.callback('录音转文字', True, 'one')
            async def close(self): pass
        config = SimpleNamespace(dashscope_api_key='', soniox_api_key='', fish_audio_api_key='', voice_fish_id='',
                                 model_chat='', voice_asr_model='', voice_proxy='')
        with patch.object(voice_call, 'LocalRecognizer', FakeRecognizer), \
             patch.object(voice_call, 'local_asr_ready', return_value=True), \
             patch.object(voice_call, '_local_asr_installed', return_value=True), \
             patch.object(voice_call, 'get_settings', return_value=config), \
             patch.object(voice_call, '_session_turn') as turn, \
             patch.object(voice_call, 'resolve_session', return_value={'session_id': 'group', 'persona_id': 'me'}) as resolve:
            with self.client.websocket_connect('/api/voice/call/ws', headers={'origin': 'http://testserver'}) as ws:
                ws.send_json({'character_id': 'a', 'session_id': 'group', 'mode': 'group', 'feature_id': 'desktop_pet',
                              'asr_provider': 'local', 'input_only': True})
                self.assertEqual(ws.receive_json()['type'], 'ready')
                ws.send_bytes(b'\0' * 3200)
                self.assertEqual(ws.receive_json(), {'type': 'transcript', 'text': '录音转文字', 'final': True})
                ws.send_json({'type': 'hangup'})
            turn.assert_not_called()
            resolve.assert_called_once_with('a', 'group', '')

    def setUp(self):
        app = FastAPI()
        app.include_router(voice_call.router, prefix='/api')
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def test_capabilities_never_return_keys(self):
        settings = SimpleNamespace(voice_asr_provider='bailian', voice_asr_model='fake', voice_asr_region='beijing',
                                   dashscope_api_key='DO-NOT-RETURN', soniox_api_key='', fish_audio_api_key='ALSO-SECRET',
                                   fish_audio_model='s2.1-pro-free', voice_fish_id='voice')
        with patch.object(voice_call, 'get_settings', return_value=settings):
            response = self.client.get('/api/voice/call/config')
        self.assertTrue(response.json()['fish_configured'])
        self.assertNotIn('SECRET', response.text)
        self.assertNotIn('DO-NOT-RETURN', response.text)

    def test_cross_site_rejected(self):
        from starlette.websockets import WebSocketDisconnect
        with self.assertRaises(WebSocketDisconnect):
            with self.client.websocket_connect('/api/voice/call/ws', headers={'origin': 'https://foreign.invalid'}):
                self.fail('must reject before accepting')

    def test_invalid_config_does_not_echo_secrets(self):
        with self.client.websocket_connect('/api/voice/call/ws', headers={'origin': 'http://testserver'}) as ws:
            ws.send_json({'api_key': 'SECRET', 'character_id': ''})
            event = ws.receive_json()
            self.assertEqual(event['type'], 'fatal')
            self.assertNotIn('SECRET', json.dumps(event))

    def test_full_socket_pcm_reply_ack_interrupt_and_next_turn(self):
        closed = []
        class FakeRecognizer:
            def __init__(self, *args):
                self.on_text = args[-1]
            async def open(self):
                pass
            async def receive(self):
                await asyncio.Event().wait()
            async def keepalive(self):
                await asyncio.Event().wait()
            async def audio(self, _data):
                await self.on_text('语音输入', True, 'utterance-one')
            async def close(self):
                closed.append(True)
        async def synth(*_):
            yield b'\1\0' * 100
        def make_speech(generation, key, model, voice, proxy, send):
            return SpeechDelivery(generation, key, model, voice, proxy, send, synth)
        async def turn(body, background, emit, voice):
            await emit({'type': 'delta', 'text': '回答。尾句'})
            await voice.finish()
            return {'assistant': {'id': 'answer', 'content': '回答。尾句'}}
        config = SimpleNamespace(dashscope_api_key='ASR-SECRET', fish_audio_api_key='FISH-SECRET',
                                 voice_fish_id='voice', model_chat='chat', voice_asr_model='asr', voice_proxy='')
        with patch.object(voice_call, 'Recognizer', FakeRecognizer), \
             patch.object(voice_call, 'SpeechDelivery', make_speech), \
             patch.object(voice_call, '_session_turn', turn), \
             patch.object(voice_call, 'get_settings', return_value=config), \
             patch.object(voice_call, 'resolve_session', return_value={'session_id': 'single-a', 'persona_id': 'me'}):
            with self.client.websocket_connect('/api/voice/call/ws', headers={'origin': 'http://testserver'}) as ws:
                ws.send_json({'character_id': 'a', 'session_id': 'single-a'})
                self.assertEqual(ws.receive_json()['type'], 'ready')
                ws.send_bytes(b'\0' * 3200)
                self.assertEqual(ws.receive_json()['text'], '语音输入')
                first = ws.receive_json()
                self.assertEqual(first['type'], 'reply-start')
                ended = 0
                while ended < 2:
                    packet = ws.receive()
                    if packet.get('bytes'):
                        self.assertEqual(struct.unpack('<I', packet['bytes'][:4])[0], first['generation'])
                    else:
                        event = json.loads(packet['text'])
                        if event['type'] == 'audio-end':
                            ended += 1
                            ws.send_json({'type': 'played', 'generation': first['generation'], 'segment': event['segment']})
                while ws.receive_json()['type'] != 'done':
                    pass
                self.assertEqual(ws.receive_json()['type'], 'history')
                # Duplicate ASR finals don't create another reply; explicit text does.
                ws.send_json({'type': 'text', 'text': '第二轮'})
                while True:
                    event = ws.receive_json()
                    if event['type'] == 'reply-start':
                        break
                self.assertEqual(event['generation'], first['generation'] + 1)
                ws.send_json({'type': 'interrupt'})
                while True:
                    packet = ws.receive()
                    if packet.get('text') and json.loads(packet['text'])['type'] == 'interrupted':
                        break
                ws.send_json({'type': 'hangup'})
        self.assertEqual(closed, [True])


if __name__ == '__main__':
    unittest.main()
