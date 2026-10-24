"""Neutral startup, optional authored defaults, and retained user data."""
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app import db, theme_feature


class ThemeFeatureTests(unittest.TestCase):
    def test_installed_theme_preserves_authored_defaults_and_user_edits(self):
        if not theme_feature.installed():
            self.skipTest('optional theme not installed')
        with tempfile.TemporaryDirectory() as tmp:
            with patch.object(db, 'DATA_DIR', Path(tmp)), patch.object(db, 'DB_PATH', Path(tmp) / 'test.db'):
                db.init_db()
                profile = db.get_character('dashiyin')
                self.assertEqual(profile['name'], '大诗音')
                profile['about'] = '用户自己重写的设定'
                profile['portrait'] = ''
                db.upsert_character('dashiyin', profile)
                db.init_db()
                self.assertEqual(db.get_character('dashiyin'), profile)

    def run_isolated(self, code):
        result = subprocess.run([sys.executable, '-X', 'utf8', '-c', code],
                                cwd=Path(__file__).resolve().parents[1], capture_output=True,
                                text=True, encoding='utf-8', errors='replace', timeout=60)
        self.assertEqual(result.returncode, 0, result.stdout[-1000:] + result.stderr[-4000:])

    def test_fresh_core_can_chat_and_keep_memory_without_theme_or_tavern(self):
        self.run_isolated(r'''
import os, sys, tempfile
from pathlib import Path
from unittest.mock import patch
from app import theme_feature
with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp)
    theme_feature.FEATURE_DIR = root / 'missing-theme'
    from app import tavern_feature
    tavern_feature.FEATURES_DIR = root / 'missing-features'
    os.environ['PERSONAL_MEMORY_ROOT'] = str(root / 'memory')
    from app import db
    db.DATA_DIR = root
    db.DB_PATH = root / 'test.db'
    db.init_db()
    assert [p['id'] for p in db.list_characters()] == ['assistant']
    assert db.get_profile('dalaoda')['name'] == '用户'
    from app.services.prompt import assembler
    assert '小糖人' not in assembler.DEFAULT_PERSONA
    assert '250～400' not in assembler.DEFAULT_REPLY_STYLE
    from app.main import app
    from app.providers import openai
    from fastapi.testclient import TestClient
    async def stream(*args, **kwargs):
        yield {'type':'text', 'text':'基础聊天正常'}
        yield {'type':'done'}
    db.set_brain_default({'base_url':'http://unused.invalid', 'model':'test'})
    with TestClient(app) as client, patch.object(openai, 'stream_chat_retry', stream):
        assert client.get('/api/health').status_code == 200
        assert client.get('/api/characters').json()[0]['name'] == '助手'
        assert client.get('/api/memories').status_code == 200
        reply = client.post('/api/chat', json={'messages':[{'role':'user','content':'你好'}], 'character_ids':['assistant']})
        assert reply.status_code == 200 and '基础聊天正常' in reply.text
    assert not any(k == 'xiaotangren_theme' or k.startswith('xiaotangren_theme.') for k in sys.modules)
''')

    def test_removing_theme_keeps_existing_records_without_reseeding(self):
        if not theme_feature.installed():
            self.skipTest('optional theme not installed')
        self.run_isolated(r'''
import importlib, tempfile
from pathlib import Path
from app import db, theme_feature, seed_profiles, seed_characters
with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp)
    db.DATA_DIR = root
    db.DB_PATH = root / 'test.db'
    db.init_db()
    old = db.get_character('dashiyin')
    old['about'] = '自定义设定'
    db.upsert_character('dashiyin', old)
    db.append_message('single-dashiyin', 'user', '已有聊天')
    profiles = db.list_profiles()
    theme_feature.FEATURE_DIR = root / 'missing'
    importlib.reload(seed_profiles)
    importlib.reload(seed_characters)
    db.SEED_CHARACTERS = seed_characters.SEED_CHARACTERS
    db.SEED_PROFILES = seed_profiles.SEED_PROFILES
    db.init_db()
    assert db.get_character('dashiyin') == old
    assert db.get_character('assistant') is None
    assert db.list_profiles() == profiles
    assert db.list_messages('single-dashiyin')[0]['content'] == '已有聊天'
    db.delete_character('xiaoshiyin')
    db.init_db()
    assert db.get_character('xiaoshiyin') is None
''')
