import io
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch
from fastapi import FastAPI
from fastapi.testclient import TestClient
from app.services import qq_gateway_setup as setup
from app.services.snowluma import SnowLumaError
from app.routers.qq_bridge import router


class GatewaySetupTests(unittest.TestCase):
    def test_missing_and_old_are_distinct_from_unknown(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(setup, 'folder', return_value=Path(temp)), \
             patch.object(setup, 'qq_versions', return_value=['9.9.30']), \
             patch('app.routers.nest._port_listening', return_value=False):
            result = setup.diagnostics()
            self.assertFalse(result['installed'])
            self.assertTrue(result['old_qq'])
            with patch.object(setup, 'qq_versions', return_value=[]):
                self.assertFalse(setup.diagnostics()['old_qq'])

    def test_only_official_full_release_selected(self):
        def asset(name):
            return {'name': name, 'size': 10, 'browser_download_url': setup.RELEASES + '/download/v1/' + name}
        with patch.object(setup, 'fetch_json', return_value={'tag_name': 'v1', 'assets': [
            asset('SnowLuma-v1-win-x64.zip'), asset('SnowLuma-v1-win-x64-lite.zip')]}):
            self.assertEqual(setup.release()['name'], 'SnowLuma-v1-win-x64.zip')
        with patch.object(setup, 'fetch_json', return_value={'assets': []}):
            with self.assertRaises(SnowLumaError): setup.release()

    def test_zip_traversal_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            archive = Path(temp) / 'test.zip'
            with zipfile.ZipFile(archive, 'w') as z: z.writestr('../outside', 'bad')
            with self.assertRaises(SnowLumaError): setup.unpack(archive, Path(temp) / 'out')
            self.assertFalse((Path(temp) / 'outside').exists())

    def test_install_requires_local_dashboard_and_explicit_consent(self):
        app = FastAPI(); app.include_router(router, prefix='/api')
        with TestClient(app) as client, patch.object(setup, 'install') as install:
            url = '/api/qq-bridge/setup/install'
            self.assertEqual(client.post(url, json={'version': 'v1', 'consent': True}).status_code, 403)
            headers = {'X-Exploration-Dashboard': '1'}
            self.assertEqual(client.post(url, headers=headers, json={'version': 'v1'}).status_code, 400)
            install.assert_not_called()
            install.return_value = {'installed': True}
            self.assertEqual(client.post(url, headers=headers, json={'version': 'v1', 'consent': True}).status_code, 200)
            install.assert_called_once_with('v1')

    def test_password_not_part_of_diagnostics_and_private_reveal(self):
        with patch('app.routers.nest._tail', return_value='token=not-for-display\ninitial password: sample-test-only\n'):
            result = setup.initial_password_notice()
            self.assertIn('sample-test-only', result['notice'])
            self.assertNotIn('token=', result['notice'])

    def test_install_pins_previewed_version(self):
        with patch.object(setup, 'release', return_value={'version': 'new-version'}):
            with self.assertRaisesRegex(SnowLumaError, '版本已变更'):
                setup.install('old-version')

    def test_complete_install_preserves_settings_and_does_not_execute(self):
        content = io.BytesIO()
        with zipfile.ZipFile(content, 'w') as z:
            z.writestr('SnowLuma/node.exe', 'test fixture')
            z.writestr('SnowLuma/index.mjs', 'test fixture')
        raw = content.getvalue()
        with tempfile.TemporaryDirectory() as temp, \
             patch('app.db.DATA_DIR', Path(temp)), \
             patch('app.db.get_feature_settings', return_value={'data': {'keep': True}}), \
             patch('app.db.set_feature_settings') as save, \
             patch.object(setup, 'release', return_value={'version': 'v1', 'size': len(raw), 'url': setup.RELEASES + '/download/v1/a.zip'}), \
             patch.object(setup.urllib.request, 'urlopen', return_value=io.BytesIO(raw)):
            result = setup.install('v1')
            self.assertTrue((Path(result['folder']) / 'node.exe').is_file())
            self.assertTrue(save.call_args.args[1]['keep'])
            with self.assertRaisesRegex(SnowLumaError, '已存在'):
                setup.install('v1')
