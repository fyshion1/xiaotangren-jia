import json
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import db, personal_space, plugin_state
from app.routers import personal_space as routes, personal_db, knowledge, harvest as patrol, self as profile_routes, plugins
from app.services import self_profile as sp, persona_memory as pm, memory_workflow as workflow, harvest


class PersonalSpacePluginTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root=Path(temp.name)
        for obj,key,value in [(db,'DATA_DIR',self.root/'data'),(db,'DB_PATH',self.root/'data/test.db'),
                              (db,'SEED_CHARACTERS',[]),(db,'SEED_PROFILES',[]),
                              (personal_space,'FEATURES_DIR',self.root/'features'),
                              (plugins,'FEATURES_DIR',self.root/'features'),(plugins,'ARCHIVE_DIR',self.root/'uninstalled'),
                              (plugin_state,'STATE_PATH',self.root/'plugin-state.json'),
                              (sp,'_SELF_PROFILE_ROOT',self.root/'profiles')]:
            p=patch.object(obj,key,value);p.start();self.addCleanup(p.stop)
        db.init_db()
        app=FastAPI()
        for router in [routes.router,personal_db.router,knowledge.router,patrol.router,profile_routes.router,plugins.router]:
            app.include_router(router,prefix='/api')
        self.client=TestClient(app);self.addCleanup(self.client.close)

    def install(self,identifier,version=1):
        folder=personal_space.FEATURES_DIR/personal_space.PANELS[identifier][0]
        folder.mkdir(parents=True,exist_ok=True)
        (folder/'plugin.json').write_text(json.dumps(dict(id=identifier,kind='personal-space-panel',host_api=version)))

    def test_missing_or_incompatible_plugins_do_not_read_private_data(self):
        for identifier in personal_space.PANELS:
            self.assertFalse(personal_space.panel(identifier)['enabled'])
        with patch.object(sp,'external_ai_layer_root',side_effect=AssertionError('read private root')):
            self.assertEqual(pm.db_pool(),[])
        with patch.object(harvest,'get_watch_dirs',side_effect=AssertionError('scan private root')):
            self.assertEqual(harvest.scan(),0)
        for path in ['/api/personal-db/tree','/api/knowledge','/api/patrol/events','/api/self/status?persona_id=user']:
            self.assertEqual(self.client.get(path).status_code,409,path)
        self.install('personal_database',version=2)
        self.assertTrue(personal_space.panel('personal_database')['installed'])
        self.assertFalse(personal_space.panel('personal_database')['enabled'])
        self.assertNotIn('content',self.client.get('/api/personal-space/panels').text)

    def test_profile_disable_suspends_injection_preserving_files_and_visibility(self):
        self.install('personal_profile')
        block=sp.create_block('user','测试资料')
        sp.write_block('user',block['filename'],dict(title='测试资料',inject=True,visible_to=['guide']),'用户保存的内容')
        original=(sp._SELF_PROFILE_ROOT/'user'/block['filename']).read_bytes()
        plugin_state.update('personal_profile',disabled=True)
        self.assertFalse(personal_space.panel('personal_profile')['enabled'])
        self.assertEqual(sp.get_injectable_texts('user',['guide']),[])
        self.assertEqual(sp.get_injectable_texts('another-user',['guide']),[])
        self.assertEqual(sp.get_injectable_texts('user',['other-guide']),[])
        self.assertEqual((sp._SELF_PROFILE_ROOT/'user'/block['filename']).read_bytes(),original)
        plugin_state.update('personal_profile',disabled=False,hidden=True)
        self.assertEqual(sp.get_injectable_texts('user',['guide'])[0]['content'].strip(),'用户保存的内容')
        self.assertEqual(sp.get_injectable_texts('another-user',['guide']),[])
        self.assertEqual(sp.get_injectable_texts('user',['other-guide']),[])
        self.assertTrue(personal_space.panel('personal_profile')['enabled'])
        self.assertTrue(personal_space.panel('personal_profile')['hidden'])

    def test_database_stops_source_reads_while_native_memory_remains(self):
        self.install('personal_database')
        plugin_state.update('personal_database',disabled=True)
        db.upsert_profile('user',dict(id='user',name='Test user'))
        with workflow.isolated_store(self.root/'memory'):
            proposal=workflow.propose('已确认的测试记忆','user',['guide'],scope='shared')
            approved=workflow.review(proposal['id'],'user','approve',{'core':True},proposal['revision'])
            db.set_persona_pick('user','memory','file:'+approved['id'],True)
            db.set_persona_pick('user','db','private.md',True)
            with patch.object(sp,'read_external_block',side_effect=AssertionError('private source read')):
                items,_=pm.injectable('user',['guide'],allow_embeddings=False)
            self.assertTrue(any('已确认的测试记忆' in item.get('text','') for item in items))
            self.assertTrue(any(p['kind']=='db' for p in db.list_persona_picks('user')))

    def test_repeated_start_has_one_worker_and_disable_can_stop_it(self):
        self.install('personal_database')
        with patch.object(harvest,'_worker',None),patch.object(harvest,'_stop',threading.Event()),\
                patch.object(harvest,'get_settings',return_value=SimpleNamespace(harvest_enabled=True,harvest_interval=60)),\
                patch.object(harvest,'scan',return_value=0):
            try:
                harvest.start();worker=harvest._worker
                self.assertIsNotNone(worker)
                harvest.start();self.assertIs(worker,harvest._worker)
                self.assertTrue(harvest.stop())
                self.assertFalse(worker.is_alive())
            finally:
                harvest.stop()

    def test_profile_uninstall_and_restore_keep_document_bytes(self):
        self.install('personal_profile')
        block=sp.create_block('user','保留资料')
        sp.write_block('user',block['filename'],dict(title='保留资料',inject=False,visible_to='all'),'原始资料')
        path=sp._SELF_PROFILE_ROOT/'user'/block['filename']
        before=path.read_bytes()
        def action(value):
            return self.client.post('/api/plugins/personal_profile/manage',json={'action':value},headers={'X-Exploration-Dashboard':'1'})
        self.assertEqual(action('uninstall').status_code,200)
        self.assertFalse(personal_space.panel('personal_profile')['installed'])
        self.assertEqual(path.read_bytes(),before)
        self.assertEqual(action('restore').status_code,200)
        self.assertTrue(personal_space.panel('personal_profile')['installed'])
        self.assertFalse(personal_space.panel('personal_profile')['enabled'])
        self.assertEqual(path.read_bytes(),before)


if __name__=='__main__':
    unittest.main()
