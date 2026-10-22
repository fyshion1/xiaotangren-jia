"""Optional tool installation, provider grouping and retired permissions."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from app import db, tool_feature
from app.routers import tools
from app.services import agent_tools


class ToolFeatureTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        for name, value in [('DB_PATH', self.root / 'test.db'), ('DATA_DIR', self.root)]:
            target = patch.object(db, name, value)
            target.start(); self.addCleanup(target.stop)
        db.init_db()
        db.set_settings({'expert_mode_v1': '{"enabled":true}'})
        app = FastAPI()
        app.include_router(tools.router, prefix='/api')
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def test_legacy_file_grants_are_removed_without_losing_other_settings(self):
        db.set_settings({agent_tools.SETTING_KEY: json.dumps({
            'enabled': True, 'root': 'C:/old-root', 'max_bytes': 8000,
            'allowed_names': ['local_dir', 'local_read', 'local_find', 'local_info', 'reminder_draft'],
            'max_calls': 4,
        })})
        config = agent_tools.saved_settings()
        self.assertTrue(config.enabled)
        self.assertEqual(config.allowed_names, ['reminder_draft'])
        self.assertEqual(config.max_calls, 4)
        self.assertNotIn('root', config.model_dump())
        for name in ('local_dir', 'local_read', 'local_find', 'local_info'):
            result = self.client.put('/api/tools/config', json={**config.model_dump(), 'allowed_names': [name]},
                                     headers={'X-Exploration-Dashboard': '1'})
            self.assertEqual(result.status_code, 422)

    def test_group_catalog_orders_network_first_and_marks_missing_provider(self):
        if not tool_feature.installed():
            self.skipTest('optional tools absent')
        with patch.object(agent_tools, 'provider_installed', side_effect=lambda group: group != 'project_costs'):
            data = self.client.get('/api/tools/config').json()
        self.assertEqual(data['groups'][0]['id'], 'network')
        self.assertEqual({g['id'] for g in data['groups']}, {'network', 'knowledge', 'project_costs', 'reminders'})
        self.assertFalse(next(g for g in data['groups'] if g['id'] == 'project_costs')['installed'])
        self.assertTrue(all(c['group'] in {g['id'] for g in data['groups']} for c in data['capabilities']))
        self.assertFalse(any(c['name'].startswith('local_') for c in data['capabilities']))

    def test_core_imports_without_tool_runtime_and_ignores_stale_installs(self):
        # Fresh interpreter rejects any runtime import, even if installed on this machine.
        code = '''
import builtins, tempfile
from pathlib import Path
original = builtins.__import__
def guarded(name, *args, **kwargs):
    if name.startswith('xiaotangren_tools'):
        raise AssertionError('Core imported an optional tools runtime: ' + name)
    return original(name, *args, **kwargs)
builtins.__import__ = guarded
from app import db, tool_feature
with tempfile.TemporaryDirectory() as tmp:
    db.DATA_DIR = Path(tmp)
    db.DB_PATH = Path(tmp) / 'test.db'
    tool_feature.FEATURES_DIR = Path(tmp) / 'missing-features'
    db.init_db()
    db.set_settings({'expert_mode_v1': '{"enabled":true}', 'agent_tools_v1': '{"enabled":true,"allowed_names":["web_search"]}'})
    from app.main import app
    from fastapi.testclient import TestClient
    from app.services import agent_tools
    with TestClient(app, raise_server_exceptions=True) as client:
        assert client.get('/api/health').status_code == 200
        data = client.get('/api/tools/config').json()
        assert data['installed'] is False and data['groups'] == []
        assert data['config']['enabled'] is False
        assert client.get('/api/tools/network').json()['installed'] is False
        assert not agent_tools.available('core', 'dalaoda')
'''
        result = subprocess.run([sys.executable, '-c', code], cwd=Path(__file__).resolve().parents[1],
                                capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=45)
        self.assertEqual(result.returncode, 0, result.stdout[-1500:] + result.stderr[-3000:])
