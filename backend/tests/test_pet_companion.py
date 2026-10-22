import asyncio
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from app import db
from app.routers import pet_companion as pet
from app.routers.session_chat import resolve_session


class PetCompanionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        for name, value in [('DATA_DIR', Path(self.tmp.name)), ('DB_PATH', Path(self.tmp.name) / 'db.sqlite')]:
            p = patch.object(db, name, value); p.start(); self.addCleanup(p.stop)
        db.init_db()
        self.session = resolve_session('dashiyin', 'single')
        self.body = dict(character_id='dashiyin', mode='single', session_id=self.session['session_id'],
                         persona_id=self.session['persona_id'], permitted=True, available_until=(time.time() + 3600) * 1000)
        self.model = AsyncMock(return_value={'content': '刚想起你来，过来陪你坐会儿。', 'finish_reason': 'stop', 'usage': {'prompt_tokens': 100, 'completion_tokens': 20}})
        for obj, name, value in [(pet, '_lock', asyncio.Lock()), (pet, '_effective_config', lambda _: {'model': 'mock', 'base_url': 'http://unused'}),
                                 (pet.openai, 'complete_chat_full', self.model)]:
            p = patch.object(obj, name, value); p.start(); self.addCleanup(p.stop)
        app = FastAPI(); app.include_router(pet.router)
        self.client = TestClient(app); self.addCleanup(self.client.close)

    def poll(self, **kw):
        return self.client.post('/pet/companion/social', json={**self.body, **kw})

    def due(self):
        with db._tx() as c:
            c.execute('UPDATE pet_social_state SET next_at=0')

    def prepare(self):
        self.assertEqual(self.poll().json()['status'], 'later')
        self.due()
        self.assertEqual(self.poll().json()['status'], 'prepared')
        return self.poll().json()['item']

    def test_no_permission_or_buffer_no_paid_calls(self):
        self.assertEqual(self.poll(permitted=False).json()['status'], 'resting')
        self.due()
        self.assertEqual(self.poll(buffer_until=(time.time() + 1200) * 1000).json()['status'], 'resting')
        self.model.assert_not_awaited()
        self.assertEqual(self.poll(persona_id='someone-else').status_code, 409)

    def test_queue_commit_is_idempotent_no_fake_user_and_waits_for_reply(self):
        item = self.prepare()
        self.assertEqual(db.list_messages(self.body['session_id']), [])
        self.assertEqual(self.poll(ack=item['id']).json()['status'], 'delivered')
        self.assertEqual(self.poll(ack=item['id']).json()['status'], 'delivered')
        rows = db.list_messages(self.body['session_id'])
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['role'], 'assistant')
        self.due()
        self.assertEqual(self.poll().json()['status'], 'later')
        self.assertEqual(self.model.await_count, 1)

    def test_presence_revoked_or_new_message_prevents_stale_delivery(self):
        item = self.prepare()
        self.assertEqual(self.poll(permitted=False, ack=item['id']).json()['status'], 'resting')
        db.append_message(self.body['session_id'], 'user', '我现在有事情要问')
        self.assertNotEqual(self.poll(ack=item['id']).json()['status'], 'delivered')
        self.assertEqual(len(db.list_messages(self.body['session_id'])), 1)

    def test_can_leave_another_greeting_without_user_reply_after_cooldown(self):
        item = self.prepare()
        self.poll(ack=item['id'])
        self.assertEqual(self.poll().json()['status'], 'later')
        with db._tx() as c:
            c.execute('UPDATE pet_social_state SET next_at=0')
            c.execute('UPDATE pet_social_queue SET created=created-2500')
        self.assertEqual(self.poll().json()['status'], 'prepared')
        self.assertEqual(self.model.await_count, 2)

    def test_qq_outbox_only_receives_committed_greeting_once(self):
        from app.services.qq_web_sync import schema
        with db._tx() as c:
            schema(c)
        item = self.prepare()
        with db._tx() as c:
            self.assertEqual(c.execute('SELECT COUNT(*) FROM qq_web_outbox').fetchone()[0], 0)
        self.assertEqual(self.poll(permitted=False, ack=item['id']).json()['status'], 'resting')
        with db._tx() as c:
            self.assertEqual(c.execute('SELECT COUNT(*) FROM qq_web_outbox').fetchone()[0], 0)
        for _ in range(2):
            self.assertEqual(self.poll(ack=item['id']).json()['status'], 'delivered')
        message_id = db.list_messages(self.body['session_id'])[0]['id']
        with db._tx() as c:
            rows = c.execute('SELECT * FROM qq_web_outbox').fetchall()
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]['session_id'], self.body['session_id'])
            self.assertEqual(rows[0]['message_id'], message_id)

    def test_failure_has_no_retry_and_spends_daily_slot(self):
        self.poll(); self.due(); self.model.side_effect = RuntimeError('secret details')
        result = self.poll()
        self.assertEqual(result.status_code, 502)
        self.assertNotIn('secret', result.text)
        self.assertEqual(self.poll().json()['status'], 'later')
        self.assertEqual(self.model.await_count, 1)

    def test_wake_rejects_cross_origin_without_loading_model(self):
        with patch('app.services.pet_wake.Spotter') as model:
            with self.assertRaises(Exception):
                with self.client.websocket_connect('/pet/companion/wake/ws', headers={'origin': 'https://bad.invalid'}): pass
            model.assert_not_called()
