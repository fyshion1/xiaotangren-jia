import asyncio
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import db
from app.routers import activity_memory as api
from app.services import activity_memory as activity, memory_workflow as workflow
from app.services.turn_coordinator import turn


class ActivityTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        for name, value in [('DATA_DIR', Path(tmp.name)), ('DB_PATH', Path(tmp.name) / 'test.db')]:
            p = patch.object(db, name, value); p.start(); self.addCleanup(p.stop)
        p = patch.dict('os.environ', {'PERSONAL_MEMORY_ROOT': str(Path(tmp.name) / 'memory')})
        p.start(); self.addCleanup(p.stop)
        db.init_db()
        app = FastAPI(); app.include_router(api.router)
        self.client = TestClient(app); self.addCleanup(self.client.close)
        self.base = dict(persona_id='dalaoda', source_feature_id='japanese_lab', event_id='q1',
                         occurred_at='2026-10-19T12:00:01+08:00', text='は和が怎么区分？',
                         character_ids=['dashiyin'], scope='personal', role='user', topic='日语')

    def post(self, **kwargs):
        return self.client.post('/memory/events', json={**self.base, **kwargs})

    def test_time_normalization_and_late_arrival(self):
        self.post(event_id='late', occurred_at='2026-10-19T12:01:01+08:00')
        self.post(event_id='early', occurred_at='2026-10-18T16:00:00Z')
        rows = activity.records('dalaoda', '2026-10-19')['items']
        self.assertEqual([r['event_id'] for r in rows], ['early', 'late'])
        self.assertEqual(rows[0]['occurred_at'], '2026-10-19T00:00:00+08:00')

    def test_same_second_concurrency_and_retry(self):
        def send(i):
            event = {k:v for k,v in self.base.items() if k not in {'persona_id', 'source_feature_id'}}
            return activity.append('dalaoda', 'japanese_lab', {**event, 'event_id': str(i)})
        with ThreadPoolExecutor(max_workers=6) as pool:
            list(pool.map(send, range(12)))
        rows = activity.records('dalaoda')['items']
        self.assertEqual(len(rows), 12)
        self.assertEqual([r['seq'] for r in rows], sorted(r['seq'] for r in rows))
        self.assertTrue(send(1)['replayed'])
        self.assertEqual(activity.records('dalaoda')['total'], 12)

    def test_conflicting_retries_rejected_and_revisions_preserved(self):
        self.assertEqual(self.post().status_code, 200)
        self.assertEqual(self.post(text='不同内容').status_code, 409)
        self.assertEqual(self.post(revision=2, text='后来补充的追问').status_code, 200)
        self.assertEqual(activity.records('dalaoda')['items'][0]['text'], '后来补充的追问')
        self.assertEqual(self.post(revision=1, text='倒退覆盖').status_code, 409)
        with db._tx() as c:
            self.assertEqual(c.execute('SELECT COUNT(*) FROM activity_events').fetchone()[0], 2)

    def test_policy_receive_organize_recall_are_independent(self):
        self.post()
        activity.set_policy('dalaoda', 'japanese_lab', {'receive':False})
        self.assertEqual(self.post(event_id='q2').status_code, 409)
        self.assertTrue(self.post().json()['replayed'])
        self.assertIn('は和が', activity.prompt('dalaoda', ['dashiyin'], '2026-10-19 学了什么'))
        activity.set_policy('dalaoda', 'japanese_lab', {'organize':False})
        self.assertEqual(activity.daily('dalaoda', '2026-10-19')['sections'], [])
        self.assertIn('は和が', activity.prompt('dalaoda', ['dashiyin'], '2026-10-19'))
        activity.set_policy('dalaoda', 'japanese_lab', {'recall':False})
        self.assertEqual(activity.prompt('dalaoda', ['dashiyin'], '2026-10-19'), '')
        self.assertEqual(activity.records('dalaoda')['total'], 1)

    def test_private_identity_and_fiction_filters(self):
        self.post()
        self.post(event_id='fiction', text='虚构剧情', context='fiction', scope='shared')
        self.assertEqual(activity.prompt('dalaoda', ['xiaobai'], '2026-10-19'), '')
        self.assertNotIn('虚构剧情', activity.prompt('dalaoda', ['dashiyin'], '2026-10-19'))
        self.assertEqual(activity.records('other')['total'], 0)
        self.assertEqual(self.post(persona_id='missing').status_code, 404)
        self.assertEqual(self.post(session_id='another@group').status_code, 403)
        self.assertEqual(self.post(occurred_at='2026-10-19T12:00:01').status_code, 422)

    def test_revision_moved_day_has_no_ghost_summary(self):
        self.post()
        old = activity.daily('dalaoda', '2026-10-19')['version']
        self.post(revision=2, occurred_at='2026-10-20T12:00:01+08:00')
        self.assertEqual(activity.daily('dalaoda', '2026-10-19')['total'], 0)
        self.assertNotEqual(activity.daily('dalaoda', '2026-10-19')['version'], old)
        self.assertEqual(activity.daily('dalaoda', '2026-10-20')['total'], 1)

    def test_archive_without_plugin_keeps_history_and_blocks_recall(self):
        self.post()
        activity.set_policy('dalaoda', 'japanese_lab', {'archived':True})
        with patch.object(activity, 'get_feature', return_value=None):
            source = next(s for s in activity.sources('dalaoda') if s['source']=='japanese_lab')
            self.assertFalse(source['installed'])
            self.assertEqual(source['count'], 1)
        self.assertEqual(activity.prompt('dalaoda', ['dashiyin'], '2026-10-19'), '')

    def test_message_source_kept_on_rearchive_and_delete(self):
        row = db.append_message('single-dashiyin', 'user', '网页问题')
        activity.from_messages([row], 'dalaoda', 'single-dashiyin', ['dashiyin'], 'desktop_pet')
        workflow.archive_source([row], 'dalaoda', 'single-dashiyin', ['dashiyin'])
        self.assertEqual(activity.records('dalaoda')['total'], 1)
        self.assertEqual(activity.records('dalaoda')['items'][0]['source_feature_id'], 'desktop_pet')
        candidate=workflow.propose('桌面上聊过的事','dalaoda',['dashiyin'],evidence=[row])
        approved=workflow.review(candidate['id'],'dalaoda','approve',{},candidate['revision'])
        self.assertEqual(approved['source_feature_ids'],['desktop_pet'])
        from app.services import cleanup
        cleanup.delete_messages([row['id']])
        self.assertEqual(activity.records('dalaoda')['total'], 0)
        self.assertEqual(activity.daily('dalaoda', row['created_at'][:10])['sections'], [])
        activity.set_policy('dalaoda','desktop_pet',{'recall':False})
        self.assertFalse(workflow.visible(approved,'dalaoda',['dashiyin']))

    def test_source_switch_controls_approved_memory(self):
        item = workflow.propose('共同学习', 'dalaoda', ['dashiyin'])
        saved = workflow.review(item['id'], 'dalaoda', 'approve', {}, item['revision'])
        self.assertTrue(workflow.visible(saved, 'dalaoda', ['dashiyin']))
        activity.set_policy('dalaoda', 'core', {'recall':False})
        self.assertFalse(workflow.visible(saved, 'dalaoda', ['dashiyin']))

    def test_disabled_plugin_is_not_reimported_as_core(self):
        from app.routers.session_chat import _archive_messages
        activity.set_policy('dalaoda', 'qq_bridge', {'receive':False})
        row=db.append_message('single-dashiyin','user','QQ 来源关闭后仍正常聊')
        _archive_messages([row], {'persona_id':'dalaoda','session_id':'single-dashiyin','character_ids':['dashiyin'],'source_feature_id':'qq_bridge'})
        workflow.archive_source([row], 'dalaoda', 'single-dashiyin', ['dashiyin'])
        self.assertEqual(activity.records('dalaoda')['total'],0)
        self.assertIsNotNone(db.get_message(row['id']))
        activity.set_policy('dalaoda','qq_bridge',{'receive':True})
        workflow.archive_source([row], 'dalaoda', 'single-dashiyin', ['dashiyin'])
        self.assertEqual(activity.records('dalaoda')['items'][0]['source_feature_id'],'qq_bridge')

    def test_coordinator_serializes_overlap_allows_unrelated_and_releases_failure(self):
        async def run():
            log=[]
            async def work(name, chars, fail=False):
                try:
                    async with turn('dalaoda', chars):
                        log.append(name+' start')
                        await asyncio.sleep(.03)
                        if fail: raise RuntimeError('test')
                        log.append(name+' end')
                except RuntimeError: pass
            await asyncio.gather(work('a',['dashiyin']),work('b',['dashiyin']),work('c',['xiaobai']))
            self.assertLess(log.index('a end'), log.index('b start'))
            self.assertLess(log.index('c start'), log.index('a end'))
            await work('failed',['dashiyin'],True)
            await work('after',['dashiyin'])
            with db._tx() as c:
                self.assertEqual(c.execute('SELECT COUNT(*) FROM chat_leases').fetchone()[0],0)
        asyncio.run(run())

    def test_delete_erases_revisions_and_cannot_be_resurrected(self):
        seq = self.post().json()['seq']
        self.post(revision=2, text='修改后的原文')
        preview = self.client.get(f'/memory/events/{seq}/delete-preview?persona_id=dalaoda')
        self.assertEqual(preview.status_code, 200)
        self.assertEqual(self.client.delete(f'/memory/events/{seq}?persona_id=dalaoda').status_code, 200)
        self.assertEqual(activity.records('dalaoda')['total'], 0)
        self.assertEqual(self.post(revision=3).status_code, 409)
        with db._tx() as c:
            self.assertTrue(all('修改后的原文' not in r[0] and 'は和が' not in r[0] for r in c.execute('SELECT payload FROM activity_events')))

    def test_candidate_keeps_source_and_requires_review(self):
        seq = self.post().json()['seq']
        r = self.client.post(f'/memory/events/{seq}/candidate', json={'persona_id':'dalaoda','text':'一起复习日语'})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()['source_feature_ids'], ['japanese_lab'])
        self.assertEqual(r.json()['review_status'], 'pending')
        self.assertFalse(workflow.visible(r.json(), 'dalaoda', ['dashiyin']))

    def test_shared_turn_history_and_retry_between_web_and_desktop(self):
        from app.routers import session_chat
        from fastapi import BackgroundTasks
        started = asyncio.Event()
        calls = []
        async def provider(messages, *args, **kwargs):
            calls.append(messages)
            if len(calls)==1:
                started.set()
                await asyncio.sleep(.07)
            yield {'type':'text','text':f'答复{len(calls)}'}
            yield {'type':'done'}
        async def run():
            body = session_chat.SessionTurn(character_id='dashiyin', session_id='single-dashiyin',text='桌宠问题',request_id='desktop-001',auto_memory=False)
            first = asyncio.create_task(session_chat._session_turn(body, BackgroundTasks()))
            await started.wait()
            user = db.append_message('single-dashiyin', 'user', '网页问题')
            web = session_chat.SessionTurn(feature_id='core',character_id='dashiyin',session_id='single-dashiyin',text='网页问题',saved_user_id=user['id'],
                                          request_id='web-0001',auto_memory=False,base_url='http://unused',model='test')
            second = asyncio.create_task(session_chat._session_turn(web, BackgroundTasks()))
            await asyncio.gather(first, second)
            self.assertIn('答复1', [m['content'] for m in calls[1]])
            self.assertEqual(len(db.list_messages('single-dashiyin')),4)
            replay = await session_chat._session_turn(web, BackgroundTasks())
            self.assertTrue(replay['replayed'])
            self.assertEqual(len(calls),2)
        with patch.object(session_chat, '_feature',return_value={'base_url':'http://unused','model':'test'}), \
             patch.object(session_chat, '_to_openai_messages',side_effect=lambda rows,*a,**kw:[{'role':m.role,'content':m.content} for m in rows]), \
             patch.object(session_chat.openai,'stream_chat_retry', provider):
            asyncio.run(run())

    def test_qq_holds_lease_until_delivery_finish_and_rejects_expired_plan(self):
        from app.routers import qq_bridge
        from app.services import qq_conversation
        from unittest.mock import AsyncMock
        app=FastAPI();app.include_router(qq_bridge.router)
        client=TestClient(app);self.addCleanup(client.close)
        session=qq_conversation.context('dashiyin')
        with patch.object(qq_conversation,'reply',AsyncMock(return_value={'actions':[]})):
            plan=client.post('/qq-bridge/reply',json={'session':session,'message_ids':['test'],'hold_for_delivery':True}).json()
            token=plan['coordination_id']
            leased={**session,'coordination_id':token}
            self.assertEqual(client.post('/qq-bridge/lease',json=leased).status_code,200)
            with db._tx() as c:
                c.execute('UPDATE chat_leases SET expires=0 WHERE owner=?',(token,))
            self.assertEqual(client.post('/qq-bridge/lease',json=leased).status_code,409)
            self.assertEqual(client.post('/qq-bridge/finish',json={'session':leased,'auto_memory':False}).status_code,200)
            legacy=client.post('/qq-bridge/reply',json={'session':session,'message_ids':['legacy']}).json()
            self.assertNotIn('coordination_id',legacy)
            with db._tx() as c:
                self.assertEqual(c.execute('SELECT COUNT(*) FROM chat_leases').fetchone()[0],0)


if __name__=='__main__': unittest.main()
