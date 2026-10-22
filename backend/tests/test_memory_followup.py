"""Synthetic isolated integration checks; reuse established temporary-storage setup."""
import asyncio
import json
import unittest
from unittest.mock import patch

import test_memory_workflow as existing_workflow_tests
from app.services import memory_daily as daily, memory_extract, memory_workflow as work
from app.services import persona_memory as pm


class MemoryFollowupTests(unittest.TestCase):
    setUp = existing_workflow_tests.MemoryWorkflowTests.setUp

    def propose(self, text, **kwargs):
        return work.propose(text, 'dalaoda', ['dashiyin'], session_id='single-dashiyin', **kwargs)

    def approve(self, item):
        return work.review(item['id'], 'dalaoda', 'approve', {}, item['revision'])

    def test_overview_links_shared_evidence_without_mutating_files(self):
        old = self.approve(self.propose('周日练习日语', evidence=[{'id':'source-1'}]))
        candidate = self.propose('周一练习日语', evidence=[{'id':'source-1'}])
        response = self.client.get('/memory-workflow', params={'persona_id':'dalaoda'})
        self.assertEqual(response.status_code, 200)
        row = next(m for m in response.json()['candidates'] if m['id'] == candidate['id'])
        self.assertEqual(row['related_reviewed'][0]['id'], old['id'])
        self.assertEqual(work.get(candidate['id'])[1]['revision'], candidate['revision'])
        self.assertEqual(self.client.get('/memory-workflow', params={'persona_id':'other'}).json()['candidates'], [])

    def test_two_events_from_one_message_both_survive_and_can_be_approved(self):
        first = self.approve(self.propose('周末练日语', evidence=[{'id':'same'}]))
        second = self.propose('今天买了牛奶', evidence=[{'id':'same'}])
        data = self.client.get('/memory-workflow', params={'persona_id':'dalaoda'}).json()
        self.assertEqual(next(m for m in data['candidates'] if m['id']==second['id'])['related_reviewed'][0]['id'],first['id'])
        self.approve(second)
        self.assertEqual(len(work.approved('dalaoda')),2)

    def process(self, text, day, topic):
        message = {'id':'message-'+day,'role':'user','content':text,'created_at':day+'T09:00:00+08:00'}
        raw=json.dumps({'memories':[{'text':text,'kind':'memory','category':'promise',
                                    'event_key':topic,'source_ids':[message['id']]}]},ensure_ascii=False)
        with patch.object(memory_extract.openai,'complete_chat',return_value=raw):
            return asyncio.run(daily.process(messages=[message],character_ids=['dashiyin'],session_kind='single',name_of={},
                base_url='https://unused.invalid',api_key='',model='controlled',force=True,save=True,
                feature_id='',persona_id='dalaoda',session_id='single-dashiyin',requested_day=day))

    def test_cross_day_same_topic_preserves_distinct_events(self):
        a=self.process('今天一起练了日语','2026-10-18','日语练习')['candidates'][0]
        b=self.process('今天又一起练了日语','2026-10-19','日语练习')['candidates'][0]
        self.assertNotEqual(a['id'],b['id'])

    def test_cross_day_correction_is_pending_and_old_memory_needs_explicit_retirement(self):
        old=self.approve(self.process('周六练习日语','2026-10-18','学习约定')['candidates'][0])
        new=self.process('改为周日练习日语，不是周六','2026-10-19','学习约定')['candidates'][0]
        self.assertEqual(new['review_status'],'pending')
        self.assertEqual(work.get(old['id'])[1]['review_status'],'approved')
        self.assertEqual(len(pm.injectable('dalaoda',['dashiyin'],'练习日语')[0]),1)
        # Current supported workflow: explicitly pause the old version before approving the replacement.
        work.review(old['id'],'dalaoda','save',{'state':'paused'},old['revision'])
        self.approve(new)
        selected=pm.injectable('dalaoda',['dashiyin'],'练习日语')[0]
        self.assertEqual(len(selected),1)
        self.assertIn('周日',selected[0]['text'])
