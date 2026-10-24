import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from app import db,gemini_sync_feature,plugin_state


class GeminiHostTests(unittest.TestCase):
    def test_missing_or_incompatible_plugin_has_no_routes_or_token(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            with patch.object(gemini_sync_feature,'FEATURES_DIR',root/'features'),patch.object(db,'DATA_DIR',root/'data'):
                app=FastAPI();gemini_sync_feature.mount(app)
                with TestClient(app) as client:
                    self.assertEqual(client.get('/api/gemini-sync/pairing').status_code,404)
                    self.assertEqual(client.post('/api/gemini-sync/messages',json={}).status_code,404)
                self.assertFalse((root/'data/gemini-sync.token').exists())
                folder=root/'features/gemini-sync';folder.mkdir(parents=True)
                (folder/'plugin.json').write_text('{"id":"gemini_sync","kind":"integration","host_api":true}',encoding='utf-8')
                self.assertFalse(gemini_sync_feature.installed())

    @unittest.skipUnless(gemini_sync_feature.installed(),'optional Gemini sync plugin not installed')
    def test_runtime_disable_reenable_and_removal_preserve_host_records(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            with patch.object(db,'DATA_DIR',root),patch.object(db,'DB_PATH',root/'test.db'),patch.object(plugin_state,'STATE_PATH',root/'state.json'):
                db.init_db()
                app=FastAPI();gemini_sync_feature.mount(app)
                with TestClient(app) as client:
                    plugin_state.update('gemini_sync',disabled=True)
                    self.assertEqual(client.get('/api/gemini-sync/pairing').status_code,409)
                    self.assertFalse((root/'gemini-sync.token').exists())
                    plugin_state.update('gemini_sync',disabled=False,hidden=True)
                    token=client.get('/api/gemini-sync/pairing').json()['token']
                    headers={'Authorization':'Bearer '+token}
                    body={'conversation_id':'sample','messages':[{'id':'one','role':'user','content':'synthetic test'}]}
                    self.assertEqual(client.post('/api/gemini-sync/messages',json=body,headers=headers).status_code,200)
                    plugin_state.update('gemini_sync',disabled=True)
                    self.assertEqual(client.post('/api/gemini-sync/messages',json=body,headers=headers).status_code,409)
                    self.assertEqual(db.count_messages('gemini-test'),1)
                    plugin_state.update('gemini_sync',disabled=False)
                    self.assertEqual(client.get('/api/gemini-sync/pairing').json()['token'],token)
                    with patch.object(gemini_sync_feature,'FEATURES_DIR',root/'missing'):
                        self.assertEqual(client.get('/api/gemini-sync/pairing').status_code,404)
                    self.assertEqual(db.count_messages('gemini-test'),1)
                    self.assertEqual(db.list_memories(),[])
