"""Mode boundaries, optional installation, startup and stale tool grants."""
import asyncio
from datetime import datetime, timezone
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, Mock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from xiaotangren_tools import ToolContext, ToolDenied

from app import db, expert_mode, launcher_settings, optional_plugins, plugin_worker
from app.routers import expert, settings, tools, system, nest, qq_bridge
from app.services import agent_tools


class ExpertModeTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name)
        for obj, name, value in [(db, 'DATA_DIR', self.root), (db, 'DB_PATH', self.root / 'test.db'),
                                 (launcher_settings, 'SETTINGS_PATH', self.root / 'launcher.json')]:
            target = patch.object(obj, name, value)
            target.start(); self.addCleanup(target.stop)
        db.init_db()
        app = FastAPI()
        for router in (expert.router, settings.router, tools.router, system.router, nest.router, qq_bridge.router):
            app.include_router(router, prefix='/api')
        optional_plugins.mount(app)
        self.client = TestClient(app)
        self.addCleanup(self.client.close)
        self.headers = {'X-Exploration-Dashboard': '1'}

    def mode(self, value=True):
        return self.client.put('/api/expert', json={'enabled': value, 'passphrase': expert_mode.PASSPHRASE}, headers=self.headers)

    def test_unlock_requires_phrase_and_local_dashboard(self):
        self.assertFalse(self.client.get('/api/expert').json()['enabled'])
        self.assertEqual(self.client.put('/api/expert', json={'enabled': True, 'passphrase': expert_mode.PASSPHRASE}).status_code, 403)
        self.assertEqual(self.client.put('/api/expert', json={'enabled': True, 'passphrase': 'wrong'}, headers=self.headers).status_code, 403)
        self.assertEqual(self.client.put('/api/expert', json={'enabled': True, 'passphrase': expert_mode.PASSPHRASE}, headers={**self.headers, 'Origin': 'https://example.com'}).status_code, 403)
        self.assertEqual(self.mode().status_code, 200)
        self.assertTrue(expert_mode.enabled())

    def test_ordinary_mode_blocks_management_and_optional_activity(self):
        for path in ('/api/tools/config', '/api/tools/runs', '/api/system/processes', '/api/system/startup'):
            self.assertEqual(self.client.get(path).status_code, 403, path)
        if expert_mode.plugin_installed():
            for path in ('/api/exploration-projects/conversations?persona=dalaoda',
                         '/api/exploration-projects', '/api/qq-bridge/exploration',
                         '/api/plugins/autonomous_activity/ui/'):
                self.assertEqual(self.client.get(path).status_code, 403, path)
            self.assertEqual(self.client.post('/api/nest/features/autonomous_activity/run', json={'command': 'run'}).status_code, 403)
        ids = [item['id'] for item in self.client.get('/api/nest/features').json()['items']]
        self.assertNotIn('autonomous_activity', ids)

    def test_disabled_sandbox_account_does_not_fall_back_to_regular_chat(self):
        if not expert_mode.plugin_installed():
            self.skipTest('optional plugin absent')
        db.set_feature_settings('autonomous_activity', {'enabled': True, 'qq_account_index': 0})
        response = self.client.get('/api/qq-bridge/context', params={'selected':'dashiyin', 'account':0})
        self.assertEqual(response.status_code, 409)
        self.assertIn('不会改用普通聊天额度', response.json()['detail'])
        response = self.client.get('/api/qq-bridge/context', params={'selected':'dashiyin', 'account':1})
        self.assertEqual(response.status_code, 409)
        self.assertIn('只能使用当前绑定', response.json()['detail'])

    def test_generic_settings_cannot_unlock_or_inject_tool_grants(self):
        for key in (expert_mode.KEY, agent_tools.SETTING_KEY, agent_tools.NETWORK_KEY):
            self.assertEqual(self.client.put('/api/settings', json={key: '{"enabled":true}'}).status_code, 403)
        self.assertFalse(expert_mode.enabled())
        self.assertEqual(self.client.put('/api/settings', json={'tavern_mode': 'true'}).status_code, 200)

    def test_normal_startup_ignores_old_disabled_choices(self):
        launcher_settings.save_startup(launcher_settings.StartupSettings(backend=False, frontend=False, qq_bridge=False, desktop_pet=False))
        actual = launcher_settings.load_startup()
        self.assertTrue(all(getattr(actual, key) for key in ('backend', 'frontend', 'qq_bridge', 'desktop_pet')))
        self.assertFalse(actual.autonomous_activity)
        self.mode()
        self.assertFalse(launcher_settings.load_startup().backend)

    def test_legacy_qq_local_tool_permissions_are_not_forwarded(self):
        db.set_feature_settings('qq_bridge', {'tools.enabled': True, 'tools.allow': ['read']})
        response = self.client.get('/api/nest/features/qq_bridge/settings')
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()['overrides']['tools.enabled'])
        self.assertEqual(response.json()['overrides']['tools.allow'], [])

    def test_ordinary_network_is_installed_only_and_separate_per_channel(self):
        config = agent_tools.ToolSettings(enabled=True, allowed_names=['knowledge_read', 'web_search', 'knowledge_propose'])
        db.set_settings({agent_tools.SETTING_KEY: config.model_dump_json()})
        with patch.object(agent_tools.web_search, 'available', return_value=False):
            self.assertFalse(agent_tools.settings().enabled)
            self.assertFalse(self.client.get('/api/tools/network').json()['installed'])
            self.assertEqual(self.client.put('/api/tools/network/core', json={'enabled': True}, headers=self.headers).status_code, 409)
        with patch.object(agent_tools.web_search, 'available', return_value=True):
            self.assertEqual(agent_tools.settings().allowed_names, ['web_search'])
            response = self.client.put('/api/tools/network/qq_bridge', json={'enabled': False}, headers=self.headers)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()['channels'], dict(core=True, qq_bridge=False, desktop_pet=True))
            self.assertFalse(agent_tools.available('qq_bridge', 'dalaoda', config))
            self.assertTrue(agent_tools.available('core', 'dalaoda', config))

    def test_tool_policy_revokes_stale_local_permission_after_mode_off(self):
        policy = agent_tools.ModeAwarePolicy(enabled=True, allowed_names=frozenset({'knowledge_read', 'web_search'}))
        context = ToolContext(actor_id='dalaoda', owner_id='dalaoda', conversation_id='test')
        self.mode()
        policy.check('knowledge_read', context)
        with patch.object(optional_plugins, 'stop_workers', AsyncMock()) as stop:
            self.assertEqual(self.mode(False).status_code, 200)
            stop.assert_awaited_once()
        with self.assertRaises(ToolDenied):
            policy.check('knowledge_read', context)
        with patch.object(agent_tools.web_search, 'available', return_value=True):
            policy.check('web_search', context)
            agent_tools.db.set_settings({agent_tools.NETWORK_KEY: '{"core":false}'})
            with self.assertRaises(ToolDenied):
                policy.check('web_search', context)

    def test_missing_plugin_does_not_prevent_core_routes(self):
        with patch.object(expert_mode, 'FEATURES_DIR', self.root / 'missing-features'):
            app = FastAPI(); app.include_router(expert.router, prefix='/api')
            optional_plugins.mount(app)
            with TestClient(app) as client:
                self.assertFalse(client.get('/api/expert').json()['autonomy_installed'])
                self.assertEqual(client.get('/api/exploration-projects').status_code, 404)

    def test_plugin_worker_stops_when_mode_is_revoked(self):
        plugin = Mock(); plugin.stop = AsyncMock()
        with patch.object(plugin_worker.db, 'init_db'), \
             patch.object(optional_plugins, 'available', side_effect=[True, False]), \
             patch.object(optional_plugins, 'load', return_value=plugin), \
             patch.object(plugin_worker.signal, 'signal'):
            asyncio.run(plugin_worker.run())
        plugin.start.assert_called_once()
        plugin.stop.assert_awaited_once()

    def test_saved_process_identity_rejects_reused_pid_or_unrelated_command(self):
        from app.features_registry import runner_of
        runner = runner_of('autonomous_activity')
        stamp = datetime.now(timezone.utc).replace(microsecond=0)
        record = {'pid': 123, 'started_at': stamp.isoformat(), 'stopped_at': ''}
        process = Mock(pid=123)
        process.cwd.return_value = str(nest.FEATURES_DIR / runner['folder'])
        process.cmdline.return_value = ['python', '-m', runner['module'], 'run']
        process.create_time.return_value = stamp.timestamp()
        with patch.object(db, 'latest_feature_run', return_value=record), patch('psutil.Process', return_value=process):
            self.assertEqual(nest._running_pid('autonomous_activity'), 123)
            process.create_time.return_value = stamp.timestamp() + 1000
            self.assertEqual(nest._running_pid('autonomous_activity'), 0)
            process.create_time.return_value = stamp.timestamp()
            process.cmdline.return_value = ['python', '-m', 'other_project']
            self.assertEqual(nest._running_pid('autonomous_activity'), 0)

    def test_plugin_assets_and_legacy_data_remain_available_after_unlock(self):
        if not expert_mode.plugin_installed():
            self.skipTest('optional plugin absent')
        self.mode()
        self.assertEqual(self.client.get('/api/plugins/autonomous_activity/ui/').status_code, 200)
        self.assertEqual(self.client.get('/api/exploration-projects/conversations?persona=dalaoda').status_code, 200)
        self.assertEqual(self.client.get('/api/tools/config').status_code, 200)
