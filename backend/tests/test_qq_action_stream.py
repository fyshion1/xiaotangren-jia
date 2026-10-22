import json
import unittest
from app.services.qq_action_stream import ActionStream


class ActionStreamTests(unittest.TestCase):
    def test_every_chunk_boundary_and_nested_braces_are_safe(self):
        actions = [{'type': 'text', 'speaker': 'a', 'text': '引号"和括号}，还有\\换行\n'},
                   {'type': 'sticker', 'sticker_id': 'one', 'speaker': 'a'}]
        raw = json.dumps({'actions': actions, 'image_summaries': [{'summary': '{"actions":[{"text":"bad"}]}'}]}, ensure_ascii=False)
        for size in range(1, len(raw)):
            parser = ActionStream()
            emitted = []
            for i in range(0, len(raw), size):
                emitted += parser.feed(raw[i:i+size])
            self.assertEqual(emitted, actions)

    def test_partial_object_and_nested_actions_never_emit(self):
        parser = ActionStream()
        self.assertEqual(parser.feed('{"actions":[{"type":"text","text":"half'), [])
        parser = ActionStream()
        with self.assertRaises(ValueError):
            parser.feed('{"other":{"actions":[{"text":"bad"}]}}' + ' ' * 200)
