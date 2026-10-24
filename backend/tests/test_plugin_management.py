import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import db, plugin_state, theme_feature, tool_feature
from app.routers import nest, plugins


class PluginManagementTests(unittest.TestCase):
    def test_docs_only_feature_is_not_installed_or_listed(self):
        self.client.app.include_router(nest.router,prefix='/api')
        folder=self.features/'dont-starve-together'
        folder.mkdir(parents=True)
        (folder/'README.md').write_text('Documentation only',encoding='utf-8')
        response=self.client.get('/api/plugins',headers={'X-Exploration-Dashboard':'1'})
        self.assertEqual(response.status_code,200)
        self.assertNotIn('dont_starve_together',[row['id'] for row in response.json()['items']])
        self.assertNotIn('dont_starve_together',[row['id'] for row in self.client.get('/api/nest/features').json()['items']])

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.features = self.root / 'features'
        theme = self.features / 'xiaotangren-theme'
        (theme / 'xiaotangren_theme').mkdir(parents=True)
        (theme / 'xiaotangren_theme/__init__.py').touch()
        (self.features / 'tools/src/xiaotangren_tools').mkdir(parents=True)
        (self.features / 'tools/src/xiaotangren_tools/__init__.py').touch()
        for obj, key, value in (
            (db, 'DATA_DIR', self.root / 'data'),
            (db, 'DB_PATH', self.root / 'data/test.db'),
            (db, 'SEED_CHARACTERS', []),
            (db, 'SEED_PROFILES', []),
            (plugin_state, 'STATE_PATH', self.root / 'state.json'),
            (plugins, 'FEATURES_DIR', self.features),
            (plugins, 'ARCHIVE_DIR', self.root / 'uninstalled'),
            (nest, 'FEATURES_DIR', self.features),
            (theme_feature, 'FEATURE_DIR', theme),
            (tool_feature, 'FEATURES_DIR', self.features),
        ):
            patcher = patch.object(obj, key, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        patcher = patch.object(nest, '_running_pid', return_value=0)
        patcher.start()
        self.addCleanup(patcher.stop)
        db.init_db()
        app = FastAPI()
        app.include_router(plugins.router, prefix='/api')
        app.add_middleware(plugin_state.PluginGuard)
        @app.get('/api/project-costs/health')
        def health():
            return {'ok': True}
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def action(self, action, identifier='xiaotangren_theme'):
        return self.client.post('/api/plugins/' + identifier + '/manage', json={'action': action},
                                headers={'X-Exploration-Dashboard': '1'})

    def apply_changes(self, changes):
        return self.client.post('/api/plugins/apply',json={'changes':changes},headers={'X-Exploration-Dashboard':'1'})

    def test_batch_applies_multiple_plugins_in_one_state_write(self):
        changes=[dict(id=identifier,enabled=False,hidden=True,expected_enabled=True,expected_hidden=False)
                 for identifier in ['xiaotangren_theme','tools']]
        with patch.object(plugin_state,'update_many',wraps=plugin_state.update_many) as write:
            response=self.apply_changes(changes)
        self.assertEqual(response.status_code,200,response.text)
        self.assertEqual(write.call_count,1)
        for identifier in ['xiaotangren_theme','tools']:
            self.assertFalse(plugin_state.enabled(identifier))
            self.assertFalse(plugin_state.visible(identifier))

    def test_batch_rejects_conflict_or_invalid_member_before_side_effects(self):
        change=dict(id='tools',enabled=False,hidden=False,expected_enabled=True,expected_hidden=False)
        for invalid in [dict(change,id='unknown'),dict(change,expected_enabled=False),change]:
            with self.subTest(invalid=invalid),patch.object(plugins,'preserve_and_stop') as stop:
                response=self.apply_changes([change,invalid])
                self.assertIn(response.status_code,[404,409,422])
                stop.assert_not_called()
                self.assertTrue(plugin_state.enabled('tools'))

    def test_failed_stop_does_not_save_batch(self):
        from fastapi import HTTPException
        change=dict(id='tools',enabled=False,hidden=False,expected_enabled=True,expected_hidden=False)
        with patch.object(plugins,'preserve_and_stop',side_effect=HTTPException(409,'停止失败')):
            self.assertEqual(self.apply_changes([change]).status_code,409)
        self.assertTrue(plugin_state.enabled('tools'))

    def test_hide_does_not_disable_and_disable_can_be_reversed(self):
        self.assertTrue(theme_feature.installed())
        self.assertEqual(self.action('hide').status_code, 200)
        self.assertFalse(plugin_state.visible('xiaotangren_theme'))
        self.assertTrue(theme_feature.installed())
        self.assertEqual(self.action('disable').status_code, 200)
        self.assertFalse(theme_feature.installed())
        self.assertEqual(self.action('enable').status_code, 200)
        self.assertTrue(theme_feature.installed())
        self.assertEqual(self.action('show').status_code, 200)
        self.assertTrue(plugin_state.visible('xiaotangren_theme'))

    def test_uninstall_is_reversible_and_keeps_files(self):
        marker = self.features / 'xiaotangren-theme/user-config.txt'
        marker.write_text('preserve me', encoding='utf-8')
        self.assertEqual(self.action('uninstall').status_code, 200)
        self.assertFalse(marker.exists())
        self.assertFalse(theme_feature.installed())
        rows = self.client.get('/api/plugins', headers={'X-Exploration-Dashboard': '1'}).json()['items']
        self.assertTrue(next(row for row in rows if row['id'] == 'xiaotangren_theme')['archived'])
        self.assertEqual(self.action('restore').status_code, 200)
        self.assertEqual(marker.read_text(encoding='utf-8'), 'preserve me')
        self.assertFalse(theme_feature.installed())
        self.assertEqual(self.action('enable').status_code, 200)
        self.assertTrue(theme_feature.installed())

    def test_requires_local_dashboard_and_rejects_unknown_actions(self):
        self.assertEqual(self.client.post('/api/plugins/tools/manage', json={'action':'disable'}).status_code, 403)
        self.assertEqual(self.action('disable', '../oops').status_code, 404)
        self.assertEqual(self.action('delete').status_code, 422)
        self.assertEqual(self.action('disable', 'unknown').status_code, 404)

    def test_disabled_plugin_blocks_already_mounted_routes_and_tools_loader(self):
        self.assertEqual(self.client.get('/api/project-costs/health').status_code, 200)
        plugin_state.update('project_costs', disabled=True)
        self.assertEqual(self.client.get('/api/project-costs/health').status_code, 409)
        self.assertEqual(self.action('disable', 'tools').status_code, 200)
        self.assertFalse(tool_feature.installed())
        self.assertEqual(self.action('enable', 'tools').status_code, 200)
        self.assertTrue(tool_feature.installed())

    def test_uninstall_does_not_overwrite_existing_backup(self):
        (plugins.ARCHIVE_DIR / 'xiaotangren-theme').mkdir(parents=True)
        self.assertEqual(self.action('uninstall').status_code, 409)
        self.assertTrue(theme_feature.installed())

    def test_failed_stop_keeps_plugin_enabled_and_in_place(self):
        from unittest.mock import AsyncMock
        with patch.object(nest, '_running_pid', return_value=123), \
                patch.object(nest, 'stop_feature', AsyncMock(return_value={'stopped':False})):
            self.assertEqual(self.action('uninstall').status_code, 409)
        self.assertTrue(theme_feature.installed())
        self.assertTrue((self.features / 'xiaotangren-theme').is_dir())

    def test_disabled_costs_cannot_be_called_through_internal_adapter(self):
        import asyncio
        from fastapi import HTTPException
        from app.services import project_costs
        plugin_state.update('project_costs', disabled=True)
        with self.assertRaises(HTTPException) as error:
            asyncio.run(project_costs.request('GET', 'health', 'dalaoda'))
        self.assertEqual(error.exception.status_code, 409)

    def test_uninstall_preserves_existing_role_art_in_core(self):
        import io
        from PIL import Image
        from app.routers import assets
        image = io.BytesIO()
        Image.new('RGB', (4, 4), 'blue').save(image, 'PNG')
        folder = self.features / 'xiaotangren-theme/public/characters'
        folder.mkdir(parents=True)
        (folder / 'avatar.png').write_bytes(image.getvalue())
        db.upsert_character('test-role', {'id':'test-role','about':'我的人设','avatar':'/characters/avatar.png'})
        self.client.app.include_router(assets.router, prefix='/api')
        response = self.action('uninstall')
        self.assertEqual(response.status_code, 200, response.text)
        role = db.get_character('test-role')
        self.assertEqual(role['about'], '我的人设')
        self.assertTrue(role['avatar'].startswith('/api/assets/'))
        self.assertEqual(self.client.get(role['avatar']).content, image.getvalue())

    def test_missing_role_art_blocks_theme_removal_without_losing_reference(self):
        db.upsert_character('test-role', {'id':'test-role','avatar':'/characters/missing.png'})
        self.assertEqual(self.action('uninstall').status_code, 409)
        self.assertTrue(theme_feature.installed())
        self.assertTrue((self.features / 'xiaotangren-theme').is_dir())
        self.assertEqual(db.get_character('test-role')['avatar'], '/characters/missing.png')
