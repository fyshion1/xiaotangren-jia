"""Offline isolation, provenance, self-review, history and working docs."""
import asyncio
import json
import os
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app import db
from app.services import exploration_memory as personal, exploration_budget as budget
from app.services import exploration_autonomy as life, exploration_conversations as chats
from app.services import memory_workflow as workflow, qq_proactive
from app.routers import exploration_projects as api
from tests import test_exploration_budget as fixture


class PersonalMemoryTests(unittest.IsolatedAsyncioTestCase):
    # Use the budget fixture, without inheriting its tests for another module.
    setUp = fixture.BudgetTests.setUp
    async def test_private_review_versions_and_recall_never_change_main_store(self):
        self.prepare()
        main = workflow.propose('主库原始记忆', 'dalaoda', ['dashiyin'])
        original = (workflow.root()/main['path']).read_bytes()
        picks = db.list_persona_picks('dalaoda')
        candidate = personal.memory('run', {'operation': 'propose', 'body': '我喜欢蓝色大鱼'})
        self.assertEqual(candidate['review_status'], 'pending')
        self.assertEqual(candidate['perspective'], 'reflection')
        self.assertFalse(personal.recall('dalaoda','dashiyin','蓝色')['items'])
        approved = personal.memory('run', {'operation':'review', 'memory_id':candidate['id'],
            'revision':candidate['revision'], 'decision':'approve', 'changes':{'inject':True,'core':True}})
        self.assertEqual(approved['reviewer'], 'sandbox-role:dashiyin')
        self.assertEqual(personal.recall('dalaoda','dashiyin','蓝色')['items'][0]['id'], candidate['id'])
        self.assertEqual((workflow.root()/main['path']).read_bytes(), original)
        self.assertEqual(db.list_persona_picks('dalaoda'), picks)
        self.assertEqual(len(workflow.list_items('dalaoda',workflow.LONG)), 1)
        with self.assertRaises(RuntimeError):
            personal.memory('run', {'operation':'review','memory_id':candidate['id'],
                'revision':candidate['revision'],'decision':'archive'})
        personal.memory('run', {'operation':'review','memory_id':candidate['id'],
                'revision':approved['revision'],'decision':'archive'})
        self.assertFalse(personal.recall('dalaoda','dashiyin','蓝色')['items'])
        self.assertTrue(list((personal.space('dalaoda','dashiyin')/'memory'/'.versions'/candidate['id']).glob('*.md')))

    def prepare(self):
        tmp = TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        p=patch.dict(os.environ, {'PERSONAL_MEMORY_ROOT': str(Path(tmp.name)/'main')});p.start();self.addCleanup(p.stop)
        life.configure({'enabled':True,'continuous':True,'run_tokens':50000,'day_tokens':200000})
        budget.artifact('run', -1, 'identity', {'speaker':'dashiyin','autonomous':True,'channels':['private']})

    async def test_other_roles_are_observations_and_private_stores_do_not_mix(self):
        self.prepare()
        message=db.append_message('single-xiaoshiyin','assistant','我的旅行经历')
        candidate=personal.memory('run', {'operation':'propose','body':'我看到小诗音谈过旅行',
            'evidence_refs':['message:'+message['id']]})
        self.assertEqual(candidate['perspective'],'observed')
        self.assertFalse(personal.overview('dalaoda','xiaoshiyin')['items'])
        with self.assertRaises(LookupError):
            personal.memory('run', {'operation':'read','memory_id': 'mw-missing'})
        other=db.append_message('other@single-dashiyin','user','其他身份秘密')
        with self.assertRaises(ValueError):
            personal.memory('run', {'operation':'propose','body':'不能读取',
                'evidence_refs':['message:'+other['id']]})
        before=personal.overview('dalaoda','dashiyin')['items']
        with self.assertRaises(ValueError):
            personal.memory('run', {'operation':'review','memory_id':candidate['id'],
                'revision':candidate['revision'],'decision':'approve','changes':{'character_ids':['xiaoshiyin']}})
        self.assertEqual(before, personal.overview('dalaoda','dashiyin')['items'])

    async def test_history_can_page_past_300_and_read_full_messages(self):
        self.prepare()
        first=db.append_message('group','user','旧消息'+('长'*2000)+'末尾证据')
        for n in range(305):
            db.append_message('single-xiaoshiyin','assistant',str(n))
        db.append_message('other@single-xiaoshiyin','user','其他身份秘密')
        before=None;found=[]
        for _ in range(60):
            result=personal.observe('run',{'collection':'chats',**({'before':before} if before else {})})
            found+=result['messages'];before=result['next_before']
            if not before:break
        self.assertEqual(len(found),306)
        self.assertNotIn('其他身份秘密',json.dumps(found,ensure_ascii=False))
        self.assertIn(first['id'],{m['message_id'] for m in found})
        page=personal.observe('run',{'collection':'chats','message_id':first['id'],'offset':1600})
        self.assertIn('末尾证据',page['messages'][0]['text'])
        other=db.append_message('other@group','user','禁止读取')
        self.assertFalse(personal.observe('run',{'collection':'chats','message_id':other['id']})['messages'])

    async def test_scaffold_persists_and_pause_blocks_personal_writes(self):
        self.prepare()
        listing=personal.docs('run',{'operation':'list'})['paths']
        self.assertIn('docs/interfaces.md',listing)
        personal.docs('run',{'operation':'write','path':'docs/task-log.md','body':'真实任务，尚未完成'})
        personal.ensure('dalaoda','dashiyin')
        self.assertEqual(personal.docs('run',{'path':'docs/task-log.md'})['content'],'真实任务，尚未完成')
        self.assertEqual(personal.bundle('dalaoda','dashiyin')['docs/task-log.md'],'真实任务，尚未完成')
        for path in ('../main.md','docs/../secret.md','/etc/passwd','docs/nested/x.md'):
            with self.assertRaises((ValueError,HTTPException)):
                personal.docs('run',{'operation':'write','path':path,'body':'escape'})
        budget.stop()
        with self.assertRaises(HTTPException):
            personal.docs('run',{'operation':'write','path':'docs/task-log.md','body':'禁止'})
        with self.assertRaises(HTTPException):
            personal.memory('run',{'operation':'propose','body':'禁止'})
        self.assertEqual((personal.space('dalaoda','dashiyin')/'docs/task-log.md').read_text(encoding='utf-8'),'真实任务，尚未完成')

    async def test_doc_receipt_distinguishes_read_write_missing_and_invalid_body(self):
        self.prepare()
        payload = {'path': 'docs/result.md', 'body': '真实观察'}
        with self.assertRaisesRegex(ValueError, 'operation=write'):
            personal.docs('run', payload)
        self.assertFalse(personal.docs('run', {'path': payload['path']})['exists'])
        receipt = personal.docs('run', {**payload, 'operation': 'write'})
        self.assertTrue(receipt['written'])
        self.assertEqual(receipt['bytes'], len(payload['body'].encode()))
        read = personal.docs('run', {'path': payload['path']})
        self.assertFalse(read['written'])
        self.assertEqual(read['sha256'], receipt['sha256'])
        with self.assertRaisesRegex(ValueError, '不能为空'):
            personal.docs('run', {'operation': 'write', 'path': payload['path'], 'body': ''})
        self.assertEqual(personal.docs('run', {'path': payload['path']})['content'], payload['body'])

    async def test_observe_main_store_readonly_and_raw_sources_are_separate(self):
        self.prepare()
        main=workflow.propose('主库原始记忆','dalaoda',['xiaoshiyin'])
        observed=personal.observe('run',{'collection':'memories','memory_id':main['id']})
        self.assertEqual(observed['item']['text'].strip(),'主库原始记忆')
        main_root=workflow.root()
        c=personal.memory('run',{'operation':'propose','body':'观察主库', 'evidence_refs':['memory:'+main['id']]})
        self.assertEqual(c['perspective'],'observed')
        self.assertEqual(workflow.root(),main_root)
        with self.assertRaises(LookupError):
            personal.memory('run',{'operation':'review','memory_id':main['id'],'revision':main['revision'],'decision':'approve'})
        _,unchanged=workflow.get(main['id'])
        self.assertEqual(unchanged['review_status'],'pending')
        budget.artifact('run',0,'document',{'title':'真实产物','body':'尚未执行'})
        ref='activity:run:0:document'
        self.assertIn('真实产物',personal.memory('run',{'operation':'source','reference':ref})['text'])
        p=personal.memory('run',{'operation':'propose','body':'写了草稿', 'evidence_refs':[ref]})
        self.assertEqual(p['perspective'],'self')

    async def test_context_local_roots_across_worker_threads(self):
        self.prepare()
        original=workflow.root()
        async def get_root(role):
            base=personal.ensure('dalaoda',role)
            with workflow.isolated_store(base/'memory'):
                result=await asyncio.to_thread(workflow.root)
            return result
        left,right=await asyncio.gather(get_root('dashiyin'),get_root('xiaoshiyin'))
        self.assertNotEqual(left,right)
        self.assertEqual(workflow.root(),original)

    async def test_real_planner_can_propose_review_and_recall_its_own_memory(self):
        self.prepare()
        # A life wallet is required by the independent conversation, not by
        # the isolated file workflow itself.
        from app.services import exploration_wallet as wallet
        wallet.save('dalaoda','dashiyin','https://wallet.invalid','own','test-key',100000,True)
        session=chats.context('dashiyin','dalaoda')
        self.provider.return_value={'content':json.dumps({'intent':'personal_memory','operation':'propose',
            'body':'我想研究蓝色大鱼','reflection':'','next_interest':'审核自己的候选'}),
            'finish_reason':'stop','usage':{'prompt_tokens':100,'completion_tokens':20}}
        with patch('app.routers.nest._effective_config',return_value={}),patch.object(budget,'sync_pending'),patch.object(budget,'sync_activity'):
            # begin() in the fixture uses a minimal binding: use a fresh real one.
            result=await qq_proactive.plan(session,run_id='memory-plan',step=0,autonomous=True)
        self.assertEqual(result['intent'],'continue')
        candidate=personal.overview('dalaoda','dashiyin')['items'][0]
        self.provider.return_value['content']=json.dumps({'intent':'personal_memory','operation':'review',
            'memory_id':candidate['id'],'revision':candidate['revision'],'decision':'approve'})
        with patch('app.routers.nest._effective_config',return_value={}),patch.object(budget,'sync_pending'),patch.object(budget,'sync_activity'):
            await qq_proactive.plan(session,run_id='memory-plan',step=1,autonomous=True)
        self.assertTrue(personal.recall('dalaoda','dashiyin','蓝色')['items'])
        self.assertEqual(self.provider.await_count,2)

    async def test_dashboard_readonly_surface_requires_local_header(self):
        self.prepare()
        app=FastAPI();app.include_router(api.router);client=TestClient(app)
        url='/exploration-projects/personal-space?persona=dalaoda&speaker=dashiyin'
        self.assertEqual(client.get(url).status_code,403)
        self.assertEqual(client.get(url,headers={'X-Exploration-Dashboard':'1'}).status_code,200)
        response=client.get('/exploration-projects/personal-space/document?persona=dalaoda&speaker=dashiyin&path=docs/README.md',headers={'X-Exploration-Dashboard':'1'})
        self.assertEqual(response.status_code,200)
        self.assertIn('工作手册',response.json()['content'])
