import unittest
from copy import deepcopy

from app.services.memory_relations import annotate


class MemoryRelationsTests(unittest.TestCase):
    def item(self, identity, **changes):
        return dict(id=identity, persona_id='a', session_id='a@single', feature_id='', scope='personal',
                    character_ids=['role'], review_status='approved' if identity == 'old' else 'pending',
                    text='用户确认周日学习' if identity == 'old' else '另一条提炼',
                    evidence=[{'id': 'source-1'}], **changes)

    def test_shared_evidence_adds_hint_without_mutation(self):
        items = [self.item('old'), self.item('new')]
        snapshot = deepcopy(items)
        result = annotate(items, 'a')
        self.assertEqual(result[1]['related_reviewed'][0]['id'], 'old')
        self.assertEqual(items, snapshot)
        self.assertEqual(result[1]['review_status'], 'pending')

    def test_distinct_events_from_same_message_remain_separate(self):
        items = [self.item('old'), self.item('new')]
        items[1]['text'] = '同一句话中的另一件事：买了牛奶'
        result = annotate(items, 'a')
        self.assertEqual(len(result), 2)
        self.assertEqual(result[1]['text'], items[1]['text'])
        self.assertTrue(result[1]['related_reviewed'])

    def test_new_evidence_is_not_claimed_to_be_conflict(self):
        items = [self.item('old'), self.item('new')]
        items[1]['evidence'] = [{'id': 'new-source'}]
        self.assertEqual(annotate(items, 'a')[1]['related_reviewed'], [])

    def test_no_cross_identity_session_feature_or_role_hints(self):
        for field, value in [('persona_id', 'b'), ('session_id', 'other'), ('feature_id', 'game'),
                             ('scope', 'shared'), ('character_ids', ['other-role'])]:
            with self.subTest(field=field):
                old, new = self.item('old'), self.item('new')
                old[field] = value
                self.assertEqual(annotate([old,new], 'a')[1]['related_reviewed'], [])

    def test_missing_evidence_does_not_link_unrelated_events(self):
        items = [self.item('old'),self.item('new')]
        items[0]['evidence'] = [{}]
        self.assertEqual(annotate(items, 'a')[1]['related_reviewed'], [])


if __name__ == '__main__':
    unittest.main()
