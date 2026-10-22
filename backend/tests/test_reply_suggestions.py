import json
import unittest

from app.services.reply_suggestions import SuggestionStream, START, END
from app.services.media_context import SummaryStream, START as MEDIA_START, END as MEDIA_END


class ReplySuggestionStreamTests(unittest.TestCase):
    def test_arbitrary_token_boundaries_and_surrounding_text(self):
        raw = '你好！' + START + '["好呀", "那明天呢", "好呀", null, "第三条", "第四条"]' + END + '再见'
        for size in range(1, len(START) + 3):
            parser = SuggestionStream(True)
            visible = ''.join(parser.feed(raw[i:i + size]) for i in range(0, len(raw), size)) + parser.finish()
            self.assertEqual(visible, '你好！再见')
            self.assertEqual(parser.candidates, ['好呀', '那明天呢', '第三条'])

    def test_malformed_truncated_or_oversized_metadata_never_leaks(self):
        for suffix in [START + 'bad json' + END, START + '["半条', START[:8], START + 'x' * 10000 + END]:
            parser = SuggestionStream(True)
            visible = ''.join(parser.feed(c) for c in '你好' + suffix) + parser.finish()
            self.assertEqual(visible, '你好')
            self.assertEqual(parser.candidates, [])
            self.assertLessEqual(len(parser.metadata), 8192)

    def test_media_summaries_work_in_either_order(self):
        metadata = MEDIA_START + json.dumps({'image_summaries': [{'image_id': 'img-test', 'summary': '白猫'}]}) + MEDIA_END
        choices = START + '["猫猫真可爱"]' + END
        for suffix in [metadata + choices, choices + metadata]:
            suggestions, media = SuggestionStream(True), SummaryStream(True)
            visible = ''.join(media.feed(suggestions.feed(c)) for c in '看见猫了' + suffix)
            visible += media.feed(suggestions.finish()) + media.finish()
            self.assertEqual(visible, '看见猫了')
            self.assertEqual(suggestions.candidates, ['猫猫真可爱'])
            self.assertEqual(media.summaries()[0]['summary'], '白猫')

    def test_missing_fields_leave_normal_answer_untouched(self):
        parser = SuggestionStream(True)
        self.assertEqual(parser.feed('正常回复，不带候选') + parser.finish(), '正常回复，不带候选')
        self.assertEqual(parser.candidates, [])
