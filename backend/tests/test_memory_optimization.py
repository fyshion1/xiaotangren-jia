import asyncio
import tempfile
import unittest
from datetime import datetime, timezone, timedelta
from pathlib import Path
from unittest.mock import AsyncMock, patch

from app import db
from app.services import memory_workflow as work, memory_integration as integration, memory_batch as batch


class OptimizationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        directory = Path(self.tmp.name)
        for obj, name, value in [(db, 'DB_PATH', directory / 'db.sqlite'), (db, 'DATA_DIR', directory)]:
            p = patch.object(obj, name, value); p.start(); self.addCleanup(p.stop)
        env = patch.dict('os.environ', {'PERSONAL_MEMORY_ROOT': str(directory / 'memory')})
        env.start(); self.addCleanup(env.stop)
        db.init_db()

    def item(self, text='一起学习日语', **kwargs):
        return work.propose(text, 'dalaoda', ['dashiyin'], **kwargs)

    def age(self, item):
        path, m = work.get(item['id'])
        work.write(path, {k:v for k,v in {**m, 'expires_at': (datetime.now(timezone.utc)-timedelta(seconds=1)).isoformat()}.items()
                          if k not in {'text','path','revision'}}, m['text'])
        return work.get(item['id'])[1]

    def approve(self, m):
        return work.review(m['id'], 'dalaoda', 'approve', {}, m['revision'])

    def records(self, items):
        return [{'id':m['id'],'revision':m['revision']} for m in items]

    def draft(self, records, response='{"text":"一起学习日语，解决了语法困惑","details":"先遇到困惑，后来讨论解决。"}'):
        with patch('app.providers.openai.complete_chat', AsyncMock(return_value=response)):
            return asyncio.run(integration.draft('dalaoda', records, base_url='http://unused', api_key='', model='fake'))

    def test_auto_expiry_and_restore_keep_raw(self):
        item = self.item(automatic=True, evidence=[{'content':'原文'}])
        old = self.age(item)
        self.assertEqual(old['review_status'], 'expired')
        self.assertEqual(old['evidence'][0]['content'], '原文')
        with self.assertRaises(ValueError): self.approve(old)
        restored = work.review(old['id'], 'dalaoda', 'restore', {}, old['revision'])
        self.assertEqual(restored['review_status'], 'pending')
        self.assertTrue(restored['keep_pending'])
        self.assertEqual(self.approve(restored)['review_status'], 'approved')

    def test_manual_edited_and_kept_candidates_do_not_expire(self):
        manual = self.item()
        self.assertNotIn('expires_at', manual)
        for text, action in [('编辑过','save'),('保留过','keep')]:
            m = self.item(text, automatic=True)
            m = work.review(m['id'], 'dalaoda', action, {}, m['revision'])
            self.assertEqual(self.age(m)['review_status'], 'pending')

    def test_background_updates_do_not_extend_expiry(self):
        m = self.item(automatic=True)
        again = self.item(automatic=True)
        self.assertEqual(m['expires_at'], again['expires_at'])
        self.assertEqual(m['id'], again['id'])

    def test_integration_preview_then_approval_and_off_keeps_replacements_off(self):
        original = [self.approve(self.item(t)) for t in ['先遇到语法困惑','后来一起解决']]
        draft = self.draft(self.records(original))
        self.assertEqual(draft['review_status'],'pending')
        self.assertFalse(any(m['superseded_by'] for m in work.approved('dalaoda')))
        merged = self.approve(draft)
        rows = work.approved('dalaoda')
        self.assertEqual(sum(bool(m['superseded_by']) for m in rows),2)
        self.assertEqual(len(rows),3)
        merged = work.review(merged['id'],'dalaoda','save',{'inject':False},merged['revision'])
        self.assertFalse(any(work.visible(m,'dalaoda',['dashiyin']) for m in work.approved('dalaoda')))
        self.assertEqual(len(work.get(original[0]['id'])[1]['text']),7)

    def test_integration_rechecks_before_approval(self):
        original = [self.approve(self.item(t)) for t in ['先讨论','后解决']]
        draft = self.draft(self.records(original))
        work.review(original[0]['id'],'dalaoda','save',{'text':'已纠正'},original[0]['revision'])
        with self.assertRaises(RuntimeError): self.approve(draft)
        self.assertEqual(work.get(draft['id'])[1]['review_status'],'pending')

    def test_scope_and_persona_rejected_before_model_call(self):
        first = self.approve(self.item('自己的事'))
        second = self.approve(self.item('共同的事',scope='shared'))
        with patch('app.providers.openai.complete_chat', AsyncMock()) as model:
            with self.assertRaises(ValueError):
                asyncio.run(integration.draft('dalaoda',self.records([first,second]),base_url='x',api_key='',model='x'))
            model.assert_not_called()

    def test_invalid_model_output_keeps_originals(self):
        originals = [self.approve(self.item(t)) for t in ['甲','乙']]
        for response in ['invalid','{"error":"不是同一件事"}','{"text":"", "details":""}']:
            with self.assertRaises(ValueError): self.draft(self.records(originals),response)
        self.assertEqual(len(work.approved('dalaoda')),2)

    def organize(self, groups):
        import json
        with patch('app.providers.openai.complete_chat', AsyncMock(return_value=json.dumps({'groups': groups}))) as model:
            result = asyncio.run(integration.organize_pending('dalaoda', base_url='x', api_key='', model='fake'))
        return result, model

    def test_one_click_pending_groups_then_approve_or_direct_short_sentence(self):
        a, b, unrelated = [self.item(t) for t in ['日语疑惑', '日语解决', '今天吃面']]
        result, model = self.organize([{'ids': [a['id'], b['id']], 'text': '日语讨论完整事件', 'details': '提出疑惑后一起解决'}])
        model.assert_awaited_once()
        draft = result['drafts'][0]
        self.assertEqual(work.get(a['id'])[1]['review_status'], 'pending')
        self.assertEqual(self.approve(unrelated)['review_status'], 'approved')
        self.approve(draft)
        self.assertIn(a['id'], integration.replaced_ids('dalaoda'))
        with self.assertRaises(RuntimeError):
            self.approve(a)
        result, model = self.organize([])
        model.assert_not_called()
        self.assertEqual(result['drafts'], [])

    def test_one_click_scope_and_invalid_groups_do_not_write(self):
        a, b = self.item('个人学习'), self.item('共同经历', scope='shared')
        before = len(work.list_items('dalaoda'))
        with self.assertRaises(ValueError):
            self.organize([{'ids': [a['id'], b['id']], 'text': '错误合并'}])
        self.assertEqual(len(work.list_items('dalaoda')), before)

    def test_one_click_unrelated_stays_and_direct_approval_invalidates_preview(self):
        a, b = self.item('早上学习'), self.item('晚上复习')
        result, _ = self.organize([])
        self.assertEqual(result['drafts'], [])
        result, _ = self.organize([{'ids': [a['id'], b['id']], 'text': '一天学习经过'}])
        self.approve(a)
        with self.assertRaises(RuntimeError):
            self.approve(result['drafts'][0])


class BatchTests(unittest.IsolatedAsyncioTestCase):
    async def test_quiet_period_coalesces_and_keeps_latest_args(self):
        callback = AsyncMock()
        with patch.object(batch,'QUIET_SECONDS',0.02), patch.object(batch,'MAX_SECONDS',0.1):
            batch.enqueue(('p','s'),callback,'first')
            await asyncio.sleep(0.01)
            batch.enqueue(('p','s'),callback,'latest')
            await asyncio.sleep(0.05)
        callback.assert_awaited_once_with('latest')

    async def test_continuous_activity_cannot_postpone_forever(self):
        callback = AsyncMock()
        with patch.object(batch,'QUIET_SECONDS',0.04), patch.object(batch,'MAX_SECONDS',0.06):
            for i in range(6):
                batch.enqueue(('p','continuous'),callback,i)
                await asyncio.sleep(0.012)
            self.assertGreaterEqual(callback.await_count,1)
            await asyncio.gather(*list(batch._tasks))

    async def test_sources_share_session_batch_other_persona_separate(self):
        callback = AsyncMock()
        with patch.object(batch,'QUIET_SECONDS',0), patch.object(batch,'MAX_SECONDS',0):
            batch.enqueue(('a','s'),callback,'web')
            batch.enqueue(('a','s'),callback,'qq')
            batch.enqueue(('b','s'),callback,'other')
            await asyncio.gather(*list(batch._tasks))
        self.assertEqual(callback.await_count,2)

    async def test_failure_and_cancel_release_queue(self):
        with patch.object(batch,'QUIET_SECONDS',0), patch.object(batch,'MAX_SECONDS',0):
            with self.assertLogs('app.services.memory_batch',level='ERROR'):
                batch.enqueue(('fail','s'),AsyncMock(side_effect=ValueError('offline')))
                await asyncio.gather(*list(batch._tasks))
        self.assertNotIn(('fail','s'),batch._pending)
