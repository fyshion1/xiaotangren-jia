import asyncio
import json
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch

from app import db
from app.routers import reminders as router
from app.services import agent_tools, reminders
from fastapi import FastAPI
from fastapi.testclient import TestClient
from xiaotangren_tools import ToolContext, ToolExecutor, ToolPolicy, ToolRegistry


def future(seconds=3600):
    return datetime.fromtimestamp(time.time() + seconds, timezone(timedelta(hours=8))).replace(microsecond=0).isoformat()


class ReminderTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        for key, value in [('DB_PATH', root / 'test.db'), ('DATA_DIR', root)]:
            p = patch.object(db, key, value)
            p.start()
            self.addCleanup(p.stop)
        db.init_db()
        self.owner = db.get_active_persona_id() or 'dalaoda'
        self.context = ToolContext(self.owner, self.owner, 'single-dashiyin')
        app = FastAPI()
        app.include_router(router.router, prefix='/api')
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def draft(self, title='交材料', due=None):
        return json.loads(reminders.draft(reminders.ReminderInput(title=title, due_at=due or future()), self.context))

    def rows(self):
        return self.client.get('/api/reminders').json()['items']

    def action(self, rid, action, revision=1, **kwargs):
        return self.client.post(f'/api/reminders/{rid}', json={'action': action, 'revision': revision, **kwargs})

    def test_proposal_deduplicates_and_requires_explicit_confirmation(self):
        when = future()
        first = self.draft(due=when)
        again = self.draft(due=when)
        self.assertEqual(first['id'], again['id'])
        self.assertEqual(len(self.rows()), 1)
        self.assertEqual(self.rows()[0]['status'], 'draft')
        self.assertEqual(self.client.get('/api/reminders/due').json()['items'], [])
        result = self.action(first['id'], 'confirm')
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json()['status'], 'scheduled')
        replay = self.action(first['id'], 'confirm')
        self.assertEqual(replay.json()['revision'], result.json()['revision'])

    def test_no_model_schedule_tool_and_proposal_policy_fails_closed(self):
        async def check():
            registry = ToolRegistry()
            registry.register(reminders.tool())
            policy = ToolPolicy(enabled=True, allowed_names={'reminder_draft'})
            executor = ToolExecutor(registry, policy)
            self.assertEqual(executor.schemas(self.context), [])
            result = await executor.execute('reminder_draft', {'title': '交材料', 'due_at': future()}, self.context)
            self.assertEqual(result.code, 'denied')
            self.assertEqual(self.rows(), [])
            executor = ToolExecutor(registry, ToolPolicy(enabled=True, allowed_names={'reminder_draft'}, allow_proposals=True))
            self.assertEqual([s['function']['name'] for s in executor.schemas(self.context)], ['reminder_draft'])
            result = await executor.execute('reminder_draft', {'title': '交材料', 'due_at': future()}, self.context)
            self.assertTrue(result.ok)
            self.assertEqual(self.rows()[0]['status'], 'draft')
            outsider = ToolContext('other', self.owner, 'chat')
            result = await executor.execute('reminder_draft', {'title': '越权', 'due_at': future()}, outsider)
            self.assertEqual(result.code, 'denied')
        asyncio.run(check())

    def test_time_and_content_validation(self):
        for title, when in [(' ', future()), ('换\n行', future()), ('x', '明天下午'),
                            ('x', '2026-10-20T15:00:00'), ('x', future(-10)),
                            ('x', future(400 * 86400)), ('x', '2027-01-01T10:00:00+00:00')]:
            with self.subTest(when=when), self.assertRaises(ValueError):
                reminders.validate(title, when)

    def test_restart_and_missed_time_recover_persistent_inbox(self):
        draft = self.draft()
        scheduled = self.action(draft['id'], 'confirm').json()
        reminders.initialize()  # Simulate rebuilding service state after restart.
        reminders.tick(scheduled['due_at'] + 300)
        due = self.client.get('/api/reminders/due').json()['items']
        self.assertEqual([row['id'] for row in due], [draft['id']])
        reminders.tick(scheduled['due_at'] + 900)
        self.assertEqual(self.rows()[0]['revision'], due[0]['revision'])
        self.assertEqual(self.action(draft['id'], 'dismiss', due[0]['revision']).status_code, 200)
        self.assertEqual(self.client.get('/api/reminders/due').json()['items'], [])

    def test_cancel_and_edit_require_revision_and_reconfirmation(self):
        draft = self.draft()
        scheduled = self.action(draft['id'], 'confirm').json()
        stale = self.action(draft['id'], 'edit', title='过时修改', due_at=future(7200))
        self.assertEqual(stale.status_code, 409)
        edited = self.action(draft['id'], 'edit', scheduled['revision'], title='交新材料', due_at=future(7200)).json()
        self.assertEqual(edited['status'], 'draft')
        cancelled = self.action(draft['id'], 'cancel', edited['revision']).json()
        self.assertEqual(cancelled['status'], 'cancelled')
        reminders.tick(cancelled['due_at'] + 1)
        self.assertEqual(self.client.get('/api/reminders/due').json()['items'], [])
        self.assertEqual(self.action(draft['id'], 'confirm', cancelled['revision']).status_code, 409)

    def test_expired_draft_and_other_persona_cannot_activate(self):
        draft = self.draft()
        with patch.object(router, 'owner', return_value='someone-else'):
            self.assertEqual(self.rows(), [])
            self.assertEqual(self.action(draft['id'], 'confirm').status_code, 404)
        row = self.rows()[0]
        reminders.tick(row['expires_at'] + 1)
        self.assertEqual(self.rows()[0]['status'], 'expired')
        self.assertEqual(self.action(draft['id'], 'confirm').status_code, 409)

    def test_concurrent_confirmation_is_idempotent(self):
        draft = self.draft()
        def confirm(_):
            return reminders.change(draft['id'], self.owner, 'confirm', 1)
        with ThreadPoolExecutor(max_workers=2) as pool:
            rows = list(pool.map(confirm, range(2)))
        self.assertEqual([r['revision'] for r in rows], [2, 2])
        self.assertEqual(len(self.rows()), 1)

    def test_draft_after_edit_keeps_correct_content_and_time(self):
        when = future()
        first = self.draft(due=when)
        edited = reminders.change(first['id'], self.owner, 'edit', 1, title='新的事项', due_at=future(7200))
        self.assertEqual(edited['title'], '新的事项')
        second = self.draft(due=when)
        self.assertNotEqual(first['id'], second['id'])
        self.assertEqual(second['title'], '交材料')
        self.assertEqual(second['due_at'], when)

    def test_agent_generates_draft_and_never_activates_it(self):
        model = AsyncMock(side_effect=[{'tool_calls': [{'function': {'name': 'reminder_draft',
            'arguments': json.dumps({'title': '交材料', 'due_at': future()})}}]},
            {'content': '已整理为草稿，请到工具中心确认。'}])
        config = agent_tools.ToolSettings(enabled=True, owner_persona_id=self.owner,
                                         allowed_names=['reminder_draft'])
        with patch.object(agent_tools.openai, 'complete_chat_full', model):
            result = asyncio.run(agent_tools.generate([{'role': 'user', 'content': '提醒我交材料'}],
                {'model': 'fixture', 'base_url': 'http://unused'}, config,
                persona_id=self.owner, session_id='single-dashiyin', feature_id='core',
                request_id='reminder-test-0001', max_tokens=200))
        self.assertEqual(result.status, 'completed')
        self.assertEqual(self.rows()[0]['status'], 'draft')
        self.assertIn('当前北京时间', str(model.await_args_list[0].args[0]))


class ReminderSchedulerTests(unittest.IsolatedAsyncioTestCase):
    async def test_scheduler_scans_and_shuts_down_cleanly(self):
        scanned = threading.Event()
        with patch.object(reminders, 'tick', side_effect=scanned.set):
            try:
                reminders.start()
                first = reminders._task
                reminders.start()
                self.assertIs(reminders._task, first)
                self.assertTrue(await asyncio.wait_for(asyncio.to_thread(scanned.wait, 2), 3))
            finally:
                await reminders.stop()
            self.assertIsNone(reminders._task)
            self.assertTrue(first.cancelled())


if __name__ == '__main__':
    unittest.main()
