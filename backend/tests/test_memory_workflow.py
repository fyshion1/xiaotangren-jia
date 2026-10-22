import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import db
from app.routers import memory_workflow as routes, personal_db
from app.services import memory, memory_extract, memory_workflow as work, persona_memory as pm, self_profile as sp
from app.services.prompt.assembler import build_system_prompt


class MemoryWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        for obj, key, value in ((db, 'DB_PATH', self.root / 'test.db'),
                                (db, 'DATA_DIR', self.root / 'data'),
                                (work, 'ROOT', self.root / 'memory'),
                                (personal_db, '_ROOT', self.root / 'database'),
                                (personal_db, '_VERSION_DIR', self.root / 'database' / '.versions'),
                                (sp, '_SELF_PROFILE_ROOT', self.root / 'profiles')):
            mock = patch.object(obj, key, value); mock.start(); self.addCleanup(mock.stop)
        env = patch.dict('os.environ', {'PERSONAL_DATABASE_ROOT': str(self.root / 'database'),
                                       'PERSONAL_MEMORY_ROOT': str(self.root / 'memory')})
        env.start(); self.addCleanup(env.stop)
        db.init_db()
        db.upsert_profile('other', {'name': '另一个身份'})
        off = patch.object(memory.emb, 'embed_texts', side_effect=memory.emb.EmbeddingError('offline'))
        off.start(); self.addCleanup(off.stop)
        from app.routers import messages as message_routes
        app = FastAPI(); app.include_router(routes.router); app.include_router(personal_db.router); app.include_router(message_routes.router)
        self.client = TestClient(app); self.addCleanup(self.client.close)

    def candidate(self, **kwargs):
        return work.propose('我们约好一起学习日语', 'dalaoda', ['dashiyin'], category='promise', **kwargs)

    def approve(self, item, **changes):
        return work.review(item['id'], 'dalaoda', 'approve', changes, item['revision'])

    def test_pending_cannot_inject_and_approval_is_canonical_file(self):
        item = self.candidate()
        self.assertEqual(pm.overview('dalaoda')['memories'], [])
        self.assertEqual(pm.injectable('dalaoda', ['dashiyin'], query='学习日语')[0], [])
        formal = self.approve(item)
        self.assertTrue((work.root() / formal['path']).is_file())
        self.assertFalse((work.root() / item['path']).exists())
        memories, _ = pm.injectable('dalaoda', ['dashiyin'], query='学习日语')
        self.assertEqual(len(memories), 1)
        self.assertIn(item['text'], memories[0]['text'])
        self.assertEqual(memories[0]['injection_reason'], 'keyword')
        self.assertEqual(db.count_memories(), 0)

    def test_persona_role_and_namespace_checked_before_retrieval(self):
        formal = self.approve(self.candidate())
        with patch('app.services.memory_retrieval.rank') as rank:
            self.assertEqual(pm.injectable('other', ['dashiyin'], query='学习日语')[0], [])
            self.assertEqual(pm.injectable('dalaoda', ['xiaobai'], query='学习日语')[0], [])
            rank.assert_not_called()
        special = self.candidate(feature_id='game')
        self.approve(special)
        self.assertFalse(work.visible(special, 'dalaoda', ['dashiyin']))
        self.assertEqual(pm.overview('other')['memories'], [])
        self.assertEqual(formal['reviewed_by'], 'dalaoda')

    def test_related_only_and_core_memory_budget(self):
        item = self.approve(self.candidate())
        self.assertEqual(pm.injectable('dalaoda', ['dashiyin'], query='天气温度')[0], [])
        work.review(item['id'], 'dalaoda', 'save', {'core': True}, item['revision'])
        self.assertEqual(len(pm.injectable('dalaoda', ['dashiyin'], query='天气温度')[0]), 1)

    def test_edit_revision_and_state_changes(self):
        original = self.candidate()
        edited = work.review(original['id'], 'dalaoda', 'save', {'text': '约好周末一起练习日语'}, original['revision'])
        with self.assertRaises(RuntimeError):
            self.approve(original)
        approved = self.approve(edited)
        paused = work.review(approved['id'], 'dalaoda', 'save', {'state': 'paused'}, approved['revision'])
        self.assertEqual(paused['state'], 'paused')
        self.assertEqual(pm.injectable('dalaoda', ['dashiyin'], query='练习日语')[0], [])
        self.assertTrue(list((work.root() / '.versions' / original['id']).glob('*.md')))

    def test_rejection_archive_and_permission(self):
        item = self.candidate()
        with self.assertRaises(PermissionError):
            work.review(item['id'], 'other', 'approve', {}, item['revision'])
        rejected = work.review(item['id'], 'dalaoda', 'reject', {}, item['revision'])
        self.assertEqual(rejected['review_status'], 'rejected')
        self.assertEqual(work.approved('dalaoda'), [])
        with self.assertRaises(ValueError):
            self.approve(rejected)
        formal = self.approve(work.propose('另一条羁绊', 'dalaoda', ['dashiyin']))
        work.review(formal['id'], 'dalaoda', 'archive', {}, formal['revision'])
        self.assertEqual(work.approved('dalaoda'), [])

    def test_dedup_does_not_cross_persona(self):
        one = self.candidate()
        self.assertEqual(self.candidate()['id'], one['id'])
        other = work.propose(one['text'], 'other', ['dashiyin'])
        self.assertNotEqual(other['id'], one['id'])

    def test_auto_extract_generates_candidates_and_routes_facts(self):
        response = '{"memories":[{"text":"用户正在学习日语","kind":"fact"},{"text":"约好每天一起练习日语","kind":"memory"}]}'
        with patch.object(memory_extract.openai, 'complete_chat', return_value=response):
            result = asyncio.run(memory_extract.extract(
                [{'role': 'user', 'content': '记得陪我学日语'}], ['dashiyin'], session_kind='single',
                persona_id='dalaoda', session_id='single-dashiyin', force=True, base_url='http://unused', model='test'))
        self.assertEqual(result['saved'], [])
        self.assertEqual(len(result['candidates']), 1)
        self.assertEqual(len(result['fact_candidates']), 1)
        self.assertEqual(db.count_memories(), 0)
        self.assertEqual(len(work.fact_candidates('dalaoda')), 1)
        self.assertEqual(work.fact_candidates('other'), [])

    def test_source_archive_is_idempotent_and_does_not_copy_image_bytes(self):
        messages = [{'id': 'one', 'role': 'user', 'content': '原话', 'image': 'data:image/png;base64,secretbytes'}]
        source = work.archive_source(messages, 'dalaoda', 'group', ['dashiyin'])
        self.assertEqual(source, work.archive_source(messages, 'dalaoda', 'group', ['dashiyin']))
        text = (work.root() / source).read_text(encoding='utf-8')
        self.assertIn('原话', text)
        self.assertNotIn('secretbytes', text)

    def test_legacy_stays_preserved_but_is_not_formal_or_injected(self):
        legacy = db.add_memory('home', '未经审核的旧记忆', fingerprint='legacy')
        db.set_persona_pick('dalaoda', 'memory', legacy['id'], True)
        overview = pm.overview('dalaoda')
        self.assertEqual(overview['memories'], [])
        self.assertEqual(overview['legacy'][0]['text'], legacy['text'])
        self.assertEqual(pm.injectable('dalaoda', ['dashiyin'], query='旧记忆')[0], [])
        r = self.client.post('/memory-workflow/candidates', json={
            'persona_id': 'dalaoda', 'text': legacy['text'], 'legacy_id': legacy['id'], 'scope': 'shared'})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIsNotNone(db.get_memory(legacy['id']))

    def test_external_facts_cannot_bypass_persona_pick(self):
        target = sp.external_ai_layer_root() / 'fact.md'
        work.write(target, {'title': '事实', 'review_status': 'approved', 'inject': True, 'visible_to': 'all'}, '独特的现实事实')
        self.assertEqual(sp.get_injectable_texts('dalaoda', ['dashiyin']), [])
        prompt = build_system_prompt(['dashiyin'], [{'role': 'user', 'content': '现实事实'}], persona=db.get_profile('dalaoda'))
        self.assertNotIn('独特的现实事实', prompt)
        pm.set_pick('dalaoda', 'db', 'fact.md', True)
        prompt = build_system_prompt(['dashiyin'], [{'role': 'user', 'content': '现实事实'}], persona=db.get_profile('dalaoda'))
        self.assertEqual(prompt.count('独特的现实事实'), 1)

    def test_approval_handles_missing_frontmatter_and_prevents_overwrite(self):
        source = personal_db._ROOT / '02_AI工作层' / 'plain.md'
        source.parent.mkdir(parents=True); source.write_text('手动核对的真实信息', encoding='utf-8')
        payload = {'source': '02_AI工作层/plain.md', 'destination': '03_AI注入层/fact.md', 'persona_id': 'dalaoda'}
        response = self.client.post('/personal-db/layer/approve', json=payload)
        self.assertEqual(response.status_code, 200, response.text)
        block = sp.read_external_block(sp.external_ai_layer_root() / 'fact.md')
        self.assertEqual(block['review_status'], 'approved')
        self.assertTrue(block['inject'])
        self.assertEqual(self.client.post('/personal-db/layer/approve', json=payload).status_code, 409)
        self.assertEqual(work.fact_candidates('dalaoda'), [])

    def test_cannot_approve_from_01_or_write_back_to_source(self):
        source = personal_db._ROOT / '01_源资料' / 'source.md'
        source.parent.mkdir(parents=True); source.write_text('原始资料', encoding='utf-8')
        for destination in ('03_AI注入层/out.md', '01_源资料/out.md'):
            response = self.client.post('/personal-db/layer/approve', json={
                'source': '01_源资料/source.md', 'destination': destination, 'persona_id': 'dalaoda'})
            self.assertEqual(response.status_code, 422)
        self.assertEqual(source.read_text(encoding='utf-8'), '原始资料')

    def test_database_ai_summary_is_draft_and_source_unchanged(self):
        source = personal_db._ROOT / '01_源资料' / 'source.txt'
        source.parent.mkdir(parents=True); source.write_text('我正在学日语', encoding='utf-8')
        with patch('app.providers.openai.complete_chat', return_value='事实：用户正在学日语。'):
            response = self.client.post('/personal-db/layer/summarize', json={
                'source': '01_源资料/source.txt', 'persona_id': 'dalaoda'})
        self.assertEqual(response.status_code, 200, response.text)
        meta, _ = work.document((personal_db._ROOT / response.json()['path']).read_text(encoding='utf-8'))
        self.assertEqual(meta['review_status'], 'pending')
        self.assertFalse(meta['inject'])
        self.assertEqual(source.read_text(encoding='utf-8'), '我正在学日语')



    def test_merge_keeps_evidence_and_rejects_different_scope(self):
        a = self.candidate(evidence=[{'role': 'user', 'content': '一起学日语'}])
        b = work.propose('每周六一起复习', 'dalaoda', ['dashiyin'], evidence=[{'role': 'user', 'content': '周六复习'}])
        merged = work.merge('dalaoda', [{'id': m['id'], 'revision': m['revision']} for m in [a, b]])
        self.assertEqual(len(merged['evidence']), 2)
        self.assertEqual(merged['review_status'], 'pending')
        self.assertEqual(work.get(a['id'])[1]['review_status'], 'archived')
        other = work.propose('共同愿景', 'dalaoda', [], scope='shared')
        with self.assertRaises(ValueError):
            work.merge('dalaoda', [{'id': m['id'], 'revision': m['revision']} for m in [merged, other]])

    def test_archive_history_is_identity_isolated_and_idempotent(self):
        db.append_message(session_id='group', role='user', content='我的原文')
        db.append_message(session_id='other@group', role='user', content='另一个身份')
        db.append_message(session_id='gemini-test', role='user', content='测试不归档')
        self.assertEqual(work.archive_history('dalaoda'), 1)
        files = list((work.root() / work.SOURCE).rglob('*.md'))
        self.assertEqual(len(files), 1)
        self.assertNotIn('另一个身份', files[0].read_text(encoding='utf-8'))
        work.archive_history('dalaoda')
        self.assertEqual(len(list((work.root() / work.SOURCE).rglob('*.md'))), 1)

    def test_vector_health_counts_canonical_changes_only(self):
        from app.services import memory_retrieval as retrieval
        item = {'id': 'formal', 'text': '正式文本'}
        self.assertEqual(retrieval.stale_count([item], 'engine'), 1)
        import hashlib
        with db._tx() as conn:
            conn.execute('INSERT INTO memory_document_vectors VALUES (?,?,?,?,?)',
                         ('formal', hashlib.sha256(item['text'].encode()).hexdigest(), 'engine', b'', 0))
        self.assertEqual(retrieval.stale_count([item], 'engine'), 0)
        self.assertEqual(retrieval.stale_count([{**item, 'text': '已修改'}], 'engine'), 1)
        self.assertEqual(retrieval.stale_count([item], 'different-engine'), 1)


    def test_daily_sources_use_readable_dates_sort_seconds_and_keep_media(self):
        from app.services import memory_sources as sources
        rows = [
            {'id':'later','role':'assistant','content':'稍后回复','created_at':'2026-10-18 16:00:09'},
            {'id':'earlier','role':'user','content':'当天第一句','created_at':'2026-10-18 16:00:01','image':'/api/files/group/orig/screenshot.png'},
            {'id':'previous','role':'user','content':'昨天的视频','created_at':'2026-10-18 15:59:59','image':'/api/files/group/orig/movie.mp4','image_source':'video','frames':['/api/media-files/video-x/frame.jpg']},
        ]
        work.archive_source(rows,'dalaoda','group',[])
        paths = list((work.root()/work.SOURCE).rglob('*.md'))
        self.assertEqual({p.name for p in paths},{'2026-10-18.md','2026-10-19.md'})
        text=(work.root()/sources.relative('dalaoda','group','2026-10-19')).read_text(encoding='utf-8')
        self.assertLess(text.index('00:00:01'),text.index('00:00:09'))
        self.assertIn('screenshot.png',text)
        self.assertNotIn('```json',text)
        work.archive_source(rows,'dalaoda','group',[])
        self.assertEqual(len(sources.read_day('dalaoda','group','2026-10-19')),2)
        sources.remove(['earlier'])
        self.assertNotIn('当天第一句',(work.root()/sources.relative('dalaoda','group','2026-10-19')).read_text(encoding='utf-8'))

    def test_cleaning_preserves_job_story_but_removes_ui_roleplay_and_image_test(self):
        from app.services import memory_cleaning as clean
        rows=[{'role':'user','content':'今天向高先生投递AI产品经理，没有回复，哭哭了。','created_at':'2026-10-19T01:43:00+08:00'},
              {'role':'assistant','content':'（轻轻抱住你）「可能周末休息。」&#x20;🔈 朗读🧠 收入候选'},
              {'role':'user','content':'你们看到刚刚大老大给你们的图图了吗，上面说了什么呀'},
              {'role':'user','content':'原来今天是周日，我现在积极准备简历。'}]
        result=clean.formatted(clean.clean(rows,{},'大老大'))
        for value in ['高先生','AI产品经理','积极准备简历','可能周末休息']:
            self.assertIn(value,result)
        for value in ['轻轻抱住','朗读','收入候选','上面说了什么']:
            self.assertNotIn(value,result)

    def test_daily_event_without_trigger_and_user_edits_override_regeneration(self):
        from app.services import memory_daily
        response=json.dumps({'memories':[{'text':'大老大求职受挫，后得知周日休假，转为积极准备。',
            'details':'向高先生投递AI产品经理，暂未收到回复。','event_key':'求职_高先生','category':'experience',
            'aliases':{'高先生':'高先生'}}]},ensure_ascii=False)
        messages=[{'role':'user','content':'今天求职没人理，我去准备明天的简历。'}]
        args=dict(messages=messages,character_ids=['dashiyin'],persona_id='dalaoda',session_id='group',base_url='http://unused',model='test')
        with patch.object(memory_extract.openai,'complete_chat',return_value=response) as model:
            first=asyncio.run(memory_extract.extract(**args))
            self.assertEqual(len(first['candidates']),1)
            item=first['candidates'][0]
            self.assertTrue(item['path'].startswith(work.LONG+'/待审核/'))
            edited=work.review(item['id'],'dalaoda','save',{'text':'我核对后的求职经历','details':'用户修正：不是面试，是首次联系。'},item['revision'])
            again=asyncio.run(memory_extract.extract(**args,force=True))
            self.assertEqual(again['candidates'],[])
            kept=work.get(item['id'])[1]
            self.assertEqual(kept['text'],edited['text'])
            self.assertEqual(kept['details'],'用户修正：不是面试，是首次联系。')
            self.assertEqual(model.await_count,2)
        self.assertEqual(memory_daily.runs('dalaoda')[0]['status'],'completed')

    def test_blocked_model_does_not_lose_source_or_repeat_same_request(self):
        from app.services import memory_daily
        args=dict(messages=[{'role':'user','content':'今天求职受挫'}],character_ids=['dashiyin'],
                  persona_id='dalaoda',session_id='group',base_url='http://unused',model='gemini')
        with patch.object(memory_extract.openai,'complete_chat',side_effect=RuntimeError('上游400 PROHIBITED_CONTENT')) as model:
            result=asyncio.run(memory_extract.extract(**args))
            self.assertEqual(result['status'],'blocked')
            self.assertNotIn('Error:',result['detail'])
            self.assertIn('本地',result['detail'])
            again=asyncio.run(memory_extract.extract(**args))
            self.assertEqual(again['status'],'blocked')
            self.assertEqual(model.await_count,1)
        self.assertTrue(list((work.root()/work.SOURCE).rglob('*.md')))
        self.assertEqual(memory_daily.runs('dalaoda')[0]['status'],'blocked')
        self.assertFalse(work.approved('dalaoda'))

    def test_whole_day_chunks_do_not_drop_early_events(self):
        from app.services import memory_cleaning as clean
        messages=[{'role':'user','id':str(i),'content':('最早求职' if i==0 else '事件')+'甲'*2000} for i in range(90)]
        groups=clean.chunks(clean.clean(messages,{}))
        self.assertGreater(len(groups),10)
        self.assertEqual(sum(len(g) for g in groups),90)
        self.assertIn('最早求职',clean.formatted(groups[0]))
        self.assertEqual(groups[-1][-1]['id'],'89')
        photos=clean.chunks(clean.clean([{'role':'user','content':'记录今天','image':f'/image/{i}.png'} for i in range(25)],{}))
        self.assertEqual(sum(len(g) for g in photos),25)
        self.assertTrue(all(sum(bool(m.get('image')) for m in g)<=8 for g in photos))

    def test_redaction_is_opt_in_and_edits_control_injected_details(self):
        item=work.propose('大老大联系高明求职','dalaoda',['dashiyin'],details='投递AI产品经理，决定准备简历。',
                          aliases={'高明':'高先生'},occurred_at='2026-10-19T01:43:22+08:00')
        formal=self.approve(item,core=True,details='用户核对后：投递AI产品经理，等待工作日回复。')
        before=work.approved('dalaoda')[0]
        self.assertIn('高明',before['text'])
        self.assertIn('01时',before['text'])
        self.assertIn('用户核对后',before['text'])
        work.review(formal['id'],'dalaoda','save',{'redact':True},formal['revision'])
        after=work.approved('dalaoda')[0]
        self.assertIn('高先生',after['text'])
        self.assertNotIn('高明',after['text'])
        self.assertIn('高明',work.get(formal['id'])[1]['text'])

    def test_approval_can_keep_injection_off(self):
        formal=self.approve(self.candidate(),inject=False)
        self.assertFalse(formal['inject'])
        self.assertEqual(pm.injectable('dalaoda',['dashiyin'],query='学习日语')[0],[])


    def test_video_frames_persist_in_managed_storage_and_delete_with_message(self):
        from app.services import attachments
        with patch.object(attachments,'ATTACHMENTS_DIR',self.root/'attachments'), patch('app.routers.media._load_frame',return_value=(b'frame-bytes','image/jpeg')):
            response=self.client.post('/messages',json={'session_id':'group','role':'user','content':'今天的视频',
                'image':'/api/files/group/orig/video.mp4','image_source':'video','frames':['/api/media-files/video-task/frames/frame_001.jpg']})
            self.assertEqual(response.status_code,200,response.text)
            saved=response.json()
            self.assertTrue(saved['frames'][0].startswith('/api/files/group/orig/'))
            self.assertEqual(db.get_message(saved['id'])['frames'],saved['frames'])
            frame=attachments._resolve_local(saved['frames'][0])
            self.assertTrue(frame.is_file())
            self.assertIn(saved['id'],db.list_messages_by_image(saved['frames'][0]))
            sessions=self.client.get('/storage/sessions').json()['items']
            self.assertEqual(sessions[0]['count'],1)
            removed=self.client.post('/messages/delete',json={'ids':[saved['id']]})
            self.assertEqual(removed.status_code,200)
            self.assertFalse(frame.exists())
            self.assertFalse(list((work.root()/work.SOURCE).rglob('*.md')))

    def test_incremental_distillation_only_sends_new_messages_with_day_summary(self):
        response=json.dumps({'memories':[{'text':'用户正在准备求职','event_key':'求职','details':'准备简历。'}]},ensure_ascii=False)
        first=db.append_message('group','user','早上准备简历。')
        args=dict(messages=[],character_ids=['dashiyin'],persona_id='dalaoda',session_id='group',base_url='http://unused',model='test')
        with patch.object(memory_extract.openai,'complete_chat',return_value=response) as model:
            asyncio.run(memory_extract.extract(**args))
            db.append_message('group','user','下午又联系了招聘方。')
            asyncio.run(memory_extract.extract(**args))
            sent=model.call_args.args[0][1]['content']
            self.assertIsInstance(sent,str)
            self.assertIn('下午又联系了招聘方',sent)
            self.assertNotIn('早上准备简历。',sent)
            self.assertIn('用户正在准备求职',sent)
            self.assertEqual(len(work.list_items('dalaoda')),1)

    def test_source_read_blocks_other_identity_and_path_escape(self):
        source=work.archive_source([{'role':'user','content':'私密原文'}],'other','other@group',[])
        self.assertEqual(self.client.get('/memory-workflow/source',params={'persona_id':'dalaoda','path':source}).status_code,403)
        self.assertEqual(self.client.get('/memory-workflow/source',params={'persona_id':'dalaoda','path':'../outside.md'}).status_code,403)


    def test_same_event_text_on_different_days_is_not_deduplicated(self):
        one=work.propose('今天继续准备简历','dalaoda',['dashiyin'],event_key='2026-10-18:job')
        two=work.propose('今天继续准备简历','dalaoda',['dashiyin'],event_key='2026-10-19:job')
        self.assertNotEqual(one['id'],two['id'])

    def test_new_turn_during_distillation_is_queued_and_processed(self):
        from app.services import memory_daily
        args=dict(messages=[],character_ids=['dashiyin'],persona_id='dalaoda',session_id='group',base_url='http://unused',model='test')
        async def scenario():
            entered=asyncio.Event(); release=asyncio.Event(); calls=[]
            async def model(messages,**kwargs):
                calls.append(messages)
                if len(calls)==1:
                    entered.set();await release.wait()
                return '{"memories":[{"text":"今天准备求职","event_key":"求职"}]}'
            db.append_message('group','user','上午准备简历。')
            with patch.object(memory_extract.openai,'complete_chat',side_effect=model):
                first=asyncio.create_task(memory_extract.extract(**args))
                await entered.wait()
                db.append_message('group','user','下午收到招聘方回复。')
                queued=await memory_extract.extract(**args)
                self.assertEqual(queued['status'],'processing')
                release.set();await first
                if memory_daily._tasks:
                    await asyncio.gather(*list(memory_daily._tasks))
            self.assertEqual(len(calls),2)
            self.assertIn('下午收到招聘方回复',calls[1][1]['content'])
            self.assertEqual(len(work.list_items('dalaoda')),1)
        asyncio.run(scenario())

if __name__ == '__main__':
    unittest.main()
