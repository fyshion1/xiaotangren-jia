"""Optional installation, data retention and host prompt boundaries."""
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from app import db, tavern_feature, plugin_state
from app.routers import chat, settings
from app.services.prompt import build_system_prompt


class TavernFeatureTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        for name, value in [('DATA_DIR', self.root), ('DB_PATH', self.root / 'test.db')]:
            target = patch.object(db, name, value)
            target.start(); self.addCleanup(target.stop)
        target = patch.dict(os.environ, {'PERSONAL_MEMORY_ROOT': str(self.root / 'memory')})
        target.start(); self.addCleanup(target.stop)
        db.init_db()

    def test_missing_feature_reports_effective_off_without_erasing_saved_choice(self):
        db.set_settings({'tavern_mode': 'true'})
        app = FastAPI(); app.include_router(settings.router)
        with patch.object(tavern_feature, 'FEATURES_DIR', self.root / 'missing'), TestClient(app) as client:
            state = client.get('/settings').json()
            self.assertEqual(state['tavern_installed'], 'false')
            self.assertEqual(state['tavern_mode'], 'false')
            self.assertEqual(client.put('/settings', json={'tavern_mode': 'true'}).status_code, 409)
            self.assertEqual(client.put('/settings', json={'tavern_installed': 'true'}).status_code, 403)
            with self.assertRaises(Exception): tavern_feature.load('card_import')
        self.assertEqual(db.get_settings()['tavern_mode'], 'true')

    def test_prompt_extensions_only_run_when_installed_and_enabled(self):
        if not tavern_feature.installed(): self.skipTest('optional tavern not installed')
        entry = db.create_worldbook(dict(title='迁移词条', keywords='星空', content='独有世界设定', enabled=True, priority=2))
        db.set_settings({'jailbreak': '自定义规则内容'})
        messages = [{'role': 'user', 'content': '看星空'}]
        self.assertNotIn('独有世界设定', build_system_prompt(['dashiyin'], messages))
        db.set_settings({'tavern_mode': 'true'})
        prompt = build_system_prompt(['dashiyin'], messages)
        self.assertIn('独有世界设定', prompt)
        self.assertIn('自定义规则内容', prompt)
        with patch.object(tavern_feature, 'FEATURES_DIR', self.root / 'missing'):
            self.assertNotIn('独有世界设定', build_system_prompt(['dashiyin'], messages))
        db.set_settings({'tavern_mode': 'false'})
        self.assertEqual(db.get_worldbook(entry['id'])['content'], '独有世界设定')
        db.init_db()
        self.assertEqual(db.get_worldbook(entry['id'])['content'], '独有世界设定')

    def test_card_display_extension_is_inert_when_mode_is_off(self):
        db.upsert_character('card-test', {'name': '测试卡', 'imported': True})
        messages = [{'role': 'system', 'content': '原始提示'}]
        chat.apply_card_display_mode(messages, ['card-test'], 'html')
        self.assertEqual(messages[0]['content'], '原始提示')
        if tavern_feature.installed():
            db.set_settings({'tavern_mode': 'true'})
            chat.apply_card_display_mode(messages, ['card-test'], 'html')
            self.assertIn('HTML 渲染模式', messages[0]['content'])

    def test_worldbook_routes_keep_existing_api_and_records(self):
        if not tavern_feature.installed(): self.skipTest('optional tavern not installed')
        from app.features_registry import get_feature
        feature = get_feature('tavern')
        self.assertEqual(feature['status'], 'available')
        self.assertEqual(feature['folder'], 'tavern')
        self.assertIsNone(feature['runner'])
        app = FastAPI(); app.include_router(tavern_feature.load('worldbook').router, prefix='/api')
        with TestClient(app) as client:
            value = dict(title='已有世界', keywords='世界', content='保持原样', owner='dashiyin', enabled=True, priority=3)
            response = client.post('/api/worldbook', json=value)
            self.assertEqual(response.status_code, 200)
            entry = response.json()
            self.assertEqual(client.get('/api/worldbook?owner=dashiyin').json(), [entry])
            self.assertEqual(client.put('/api/worldbook/' + entry['id'], json={**value, 'content': '更新内容'}).status_code, 200)
            self.assertEqual(db.get_worldbook(entry['id'])['content'], '更新内容')

    def test_fresh_core_starts_and_chats_without_importing_feature(self):
        code = r'''
import importlib.abc, os, sys, tempfile
from pathlib import Path
class Block(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname == 'tavern_feature' or fullname.startswith('tavern_feature.'):
            raise AssertionError('Core imported missing tavern implementation: ' + fullname)
sys.meta_path.insert(0, Block())
from app import db, tavern_feature, plugin_state
with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp)
    os.environ['PERSONAL_MEMORY_ROOT'] = str(root / 'memory')
    db.DATA_DIR = root
    db.DB_PATH = root / 'test.db'
    plugin_state.STATE_PATH = root / 'plugin-state.json'
    tavern_feature.FEATURES_DIR = root / 'absent'
    db.init_db()
    db.set_settings({'tavern_mode': 'true'})
    from app.main import app
    from app.providers import openai
    from unittest.mock import patch
    from fastapi.testclient import TestClient
    async def stream(*args, **kwargs):
        yield {'type': 'text', 'text': '普通聊天正常'}
        yield {'type': 'done'}
    db.set_brain_default({'base_url': 'http://unused.invalid', 'model': 'test'})
    with TestClient(app) as client, patch.object(openai, 'stream_chat_retry', stream):
        assert client.get('/api/health').status_code == 200
        state = client.get('/api/settings').json()
        assert state['tavern_installed'] == 'false' and state['tavern_mode'] == 'false'
        assert client.get('/api/worldbook').status_code == 404
        assert client.post('/api/imports/tavern-card/commit', json={}).status_code == 404
        assert client.post('/api/imports/google-takeout', files={'file': ('bad.txt', b'x')}).status_code == 400
        reply = client.post('/api/chat', json={'messages': [{'role': 'user', 'content': '你好'}]})
        assert reply.status_code == 200 and '普通聊天正常' in reply.text
'''
        result = subprocess.run([sys.executable, '-X', 'utf8', '-c', code], cwd=Path(__file__).resolve().parents[1],
                                capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=45)
        self.assertEqual(result.returncode, 0, result.stdout[-1000:] + result.stderr[-4000:])
