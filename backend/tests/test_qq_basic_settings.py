import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from app import db, expert_mode, optional_plugins
from app.routers import expert, nest, qq_bridge
from app.services import qq_basic_settings as basic


class BasicQQTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup)
        for key, value in [('DATA_DIR', Path(temp.name)), ('DB_PATH', Path(temp.name) / 'test.db')]:
            p = patch.object(db, key, value); p.start(); self.addCleanup(p.stop)
        db.init_db()
        app = FastAPI()
        for router in (nest.router, expert.router, qq_bridge.router): app.include_router(router, prefix='/api')
        self.client = TestClient(app); self.addCleanup(self.client.close)
        self.url = '/api/nest/features/qq_bridge/settings'
        self.headers = {'X-Exploration-Dashboard': '1'}
        self.rows = [{'self_id': '11111', 'name': 'first', 'persona': 'one', 'ws_url': 'ws://127.0.0.1:3100/',
                      'groups': ['12345'], 'private': [], 'enabled': True},
                     {'self_id': '22222', 'name': 'second', 'persona': 'two', 'ws_url': 'ws://127.0.0.1:3101/',
                      'access_token': 'test-secret', 'groups': [], 'private': ['54321'], 'enabled': True}]

    def save(self, values):
        return self.client.put(self.url, json={'values': values})

    def test_runtime_single_account_and_advanced_grants_revoked_without_data_loss(self):
        stored = {'accounts': self.rows, 'proactive.enabled': True, 'onebot.mode': 'server',
                  'asr.engine': 'openai', 'asr.fallback': 'openai', 'voice.auto': 'always',
                  'tools.enabled': True, 'tools.allow': ['execute']}
        db.set_feature_settings('qq_bridge', stored)
        data = self.client.get(self.url).json()
        self.assertTrue(data['overrides']['bridge.selection_required'])
        basic.choose('22222')
        data = self.client.get(self.url).json()
        values = data['overrides']
        self.assertEqual([r['self_id'] for r in values['accounts']], ['22222'])
        self.assertFalse(values['bridge.selection_required'])
        self.assertEqual(values['onebot.mode'], 'client')
        self.assertFalse(values['proactive.enabled'])
        self.assertFalse(values['tools.enabled'])
        self.assertEqual(values['asr.engine'], 'qq')
        self.assertEqual(values['asr.fallback'], 'local')
        self.assertFalse(values['owner.admin_commands'])
        self.assertEqual(nest._setting('qq_bridge', 'onebot.self_id'), '22222')
        self.assertEqual(nest._gateway_spec('qq_bridge')['port'], 3101)
        self.assertTrue(all(f['key'] in basic.BASIC_KEYS for f in data['schema']))
        self.assertEqual(basic.saved(), stored)

    def test_save_single_preserves_other_accounts_and_hidden_expert_values(self):
        db.set_feature_settings('qq_bridge', {'accounts': self.rows, 'reply.max_bubbles': 7, 'proactive.enabled': True})
        basic.choose('22222')
        updated = {**self.rows[1], 'persona': 'group', 'groups': ['34567']}
        self.assertEqual(self.save({'accounts': [updated], 'owner.qq': '99999'}).status_code, 200)
        stored = basic.saved()
        self.assertEqual(stored['accounts'][0], self.rows[0])
        self.assertEqual(stored['accounts'][1]['persona'], 'group')
        self.assertTrue(stored['proactive.enabled'])
        self.assertEqual(stored['reply.max_bubbles'], 7)
        # Bridge writeback of a sticker library must not erase accounts.
        self.assertEqual(self.save({'sticker.library': []}).status_code, 200)
        self.assertEqual(len(basic.saved()['accounts']), 2)

    def test_backend_rejects_multiple_accounts_and_expert_fields(self):
        self.assertEqual(self.save({'accounts': self.rows}).status_code, 400)
        for key, value in [('proactive.enabled', True), ('onebot.mode', 'server'),
                           ('owner.admin_commands', True), ('reply.max_bubbles', 20)]:
            self.assertEqual(self.save({key: value}).status_code, 403, key)
        self.assertEqual(self.save({'asr.engine': 'openai'}).status_code, 403)
        self.assertEqual(self.save({'voice.auto': 'always'}).status_code, 403)
        self.assertEqual(self.save({'onebot.ws_url': 'ws://example.com:3001/'}).status_code, 400)
        self.assertEqual(self.save({'accounts': [{**self.rows[0], 'ws_url': 'ws://example.com:3001/'}]}).status_code, 400)

    def test_expert_exit_stops_bridge_without_requiring_account_selection(self):
        db.set_settings({expert_mode.KEY: '{"enabled":true}'})
        db.set_feature_settings('qq_bridge', {'accounts': self.rows})
        with patch.object(nest, 'stop_feature', AsyncMock()) as stop, \
             patch.object(optional_plugins, 'stop_workers', AsyncMock()):
            response = self.client.put('/api/expert', headers=self.headers, json={'enabled': False})
            self.assertEqual(response.status_code, 200)
            stop.assert_awaited_once_with('qq_bridge')
        self.assertEqual(basic.saved()['accounts'], self.rows)
        self.assertEqual(basic.selected_id(), '')
        self.assertFalse(expert_mode.enabled())
        with self.assertRaises(Exception):
            basic.require_ready()
        basic.choose('22222')
        basic.require_ready()

    def test_expert_mode_retains_full_configuration(self):
        db.set_settings({expert_mode.KEY: '{"enabled":true}'})
        self.assertEqual(self.save({'accounts': self.rows, 'proactive.enabled': True}).status_code, 200)
        actual = self.client.get(self.url).json()['overrides']
        self.assertEqual(len(actual['accounts']), 2)
        self.assertTrue(actual['proactive.enabled'])
        self.assertNotIn('bridge.basic_mode', actual)

    def test_local_selection_and_startup_require_valid_choice(self):
        db.set_feature_settings('qq_bridge', {'accounts': self.rows})
        with self.assertRaises(Exception): basic.require_ready()
        url = '/api/qq-bridge/setup/select-basic-account'
        self.assertEqual(self.client.post(url, json={'self_id': '11111'}).status_code, 403)
        with patch.object(nest, 'stop_feature', AsyncMock()):
            self.assertEqual(self.client.post(url, headers=self.headers, json={'self_id': '99999'}).status_code, 400)
            self.assertEqual(self.client.post(url, headers=self.headers, json={'self_id': '11111'}).status_code, 200)
        basic.require_ready()
