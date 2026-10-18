import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import db
from app.routers import session_chat as chat
from app.routers.chat import _to_openai_messages as real_prompt
from app.services import memory


class SessionChatTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        for name, value in [('DATA_DIR', Path(tmp.name)), ('DB_PATH', Path(tmp.name) / 'test.db')]:
            p = patch.object(db, name, value); p.start(); self.addCleanup(p.stop)
        db.init_db()
        self.char = 'dashiyin'
        self.calls = []
        self.fail = False
        async def stream(messages, model, base_url, api_key, **kwargs):
            self.calls.append(messages)
            if self.fail:
                yield {'type': 'error', 'message': 'private upstream detail'}
            else:
                yield {'type': 'text', 'text': '**大诗音**：我在，记得你说过的事。'}
                yield {'type': 'done'}
        def prompt(messages, ids, **kwargs):
            return [{'role': m.role, 'content': m.content} for m in messages]
        self.memory = AsyncMock(return_value={})
        for target, value in [('_effective_config', lambda _: {'base_url': 'http://unused', 'model': 'test', 'api_key': 'SECRET'}),
                              ('_to_openai_messages', prompt), ('_turn_lock', asyncio.Lock())]:
            p = patch.object(chat, target, value); p.start(); self.addCleanup(p.stop)
        for obj, name, value in [(chat.openai, 'stream_chat_retry', stream), (chat.memory_extract, 'extract', self.memory)]:
            p = patch.object(obj, name, value); p.start(); self.addCleanup(p.stop)
        app = FastAPI(); app.include_router(chat.router, prefix='/api')
        self.client = TestClient(app); self.addCleanup(self.client.close)

    def turn(self, **overrides):
        body = {'character_id': self.char, 'mode': 'single', 'session_id': f'single-{self.char}',
                'text': '记住我喜欢草莓', 'request_id': 'request-0001'}
        return self.client.post('/api/chat/session/turn', json={**body, **overrides})

    def test_shared_history_and_memory_and_safe_retry(self):
        sid = f'single-{self.char}'
        db.append_message(sid, 'assistant', '网页上以前的聊天')
        first = self.turn()
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(self.calls[0][0]['content'], '网页上以前的聊天')
        self.assertEqual(len(db.list_messages(sid)), 3)
        again = self.turn()
        self.assertTrue(again.json()['replayed'])
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(len(db.list_messages(sid)), 3)
        self.assertEqual(self.memory.await_args.kwargs['feature_id'], '')
        self.assertEqual(self.memory.await_args.kwargs['session_kind'], 'single')
        state = self.client.get('/api/chat/session', params={'character_id': self.char})
        self.assertNotIn('SECRET', state.text)
        self.assertEqual(state.json()['items'][-1]['id'], first.json()['assistant']['id'])

    def test_failed_turn_retry_keeps_one_user_message(self):
        self.fail = True
        failed = self.turn()
        self.assertEqual(failed.status_code, 502)
        self.assertNotIn('private upstream', failed.text)
        self.assertEqual(len(db.list_messages(f'single-{self.char}')), 1)
        self.fail = False
        self.assertEqual(self.turn().status_code, 200)
        self.assertEqual(len(db.list_messages(f'single-{self.char}')), 2)
        self.assertEqual(self.turn(text='另一句话').status_code, 409)

    def test_changed_identity_wrong_session_and_invalid_input_do_not_write(self):
        self.assertEqual(self.turn(session_id='group').status_code, 409)
        self.assertEqual(self.turn(text='  ').status_code, 422)
        self.assertEqual(self.turn(character_id='unknown').status_code, 404)
        self.assertEqual(self.turn(mode='wrong').status_code, 422)
        self.assertEqual(db.list_messages(f'single-{self.char}'), [])
        profiles = [p for p in db.list_profiles() if p['id'] != 'dalaoda']
        if profiles:
            with patch.object(db, 'get_active_persona_id', return_value=profiles[0]['id']):
                self.assertEqual(self.turn().status_code, 409)
                state = chat.resolve_session(self.char, 'single')
                self.assertEqual(state['session_id'], f"{profiles[0]['id']}@single-{self.char}")

    def test_group_roster_reply_segments_and_shared_memory(self):
        db.set_settings({'group_roster': '["dashiyin"]'})
        r = self.turn(mode='group', session_id='group')
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()['character_ids'], [self.char])
        row = db.list_messages('group')[-1]
        self.assertEqual(row['kind'], 'groups')
        self.assertEqual(row['segments'][0]['speaker'], '大诗音')
        self.assertEqual(self.memory.await_args.kwargs['feature_id'], '')
        self.assertEqual(self.memory.await_args.kwargs['session_kind'], 'group')

    def test_real_prompt_recalls_normal_home_and_private_memories_only(self):
        db.add_memory('home', '家里一起烤过草莓饼干', fingerprint='home')
        db.add_memory('personal', '大诗音私聊说好的草莓牛奶', char_id=self.char, fingerprint='private')
        db.add_memory('personal', '别人的私密测试标记', char_id='xiaobai', fingerprint='other')
        db.add_memory('home', '外设隔离测试标记', game_id='some_game', fingerprint='game')
        with patch.object(chat, '_to_openai_messages', real_prompt), patch.object(memory.emb, 'embed_texts', return_value=[]):
            result = self.turn(auto_memory=False)
        self.assertEqual(result.status_code, 200, result.text)
        prompt = self.calls[0][0]['content']
        self.assertIn('家里一起烤过草莓饼干', prompt)
        self.assertIn('大诗音私聊说好的草莓牛奶', prompt)
        self.assertNotIn('别人的私密测试标记', prompt)
        self.assertNotIn('外设隔离测试标记', prompt)

    def test_stream_deltas_final_retry_and_error(self):
        import json
        body = {'character_id': self.char, 'session_id': f'single-{self.char}', 'text': '你好', 'request_id': 'stream-001', 'auto_memory': False}
        response = self.client.post('/api/chat/session/stream', json=body)
        events = [json.loads(line) for line in response.text.splitlines()]
        self.assertEqual(events[0]['type'], 'delta')
        self.assertEqual(events[-1]['type'], 'done')
        self.assertEqual(events[-1]['result']['assistant']['content'], events[0]['text'])
        again = self.client.post('/api/chat/session/stream', json=body)
        self.assertTrue(json.loads(again.text)['result']['replayed'])
        self.assertEqual(len(self.calls), 1)
        self.fail = True
        failed = self.client.post('/api/chat/session/stream', json={**body, 'request_id': 'stream-002'})
        self.assertEqual(json.loads(failed.text)['type'], 'error')
        self.assertNotIn('private upstream', failed.text)


if __name__ == '__main__':
    unittest.main()
