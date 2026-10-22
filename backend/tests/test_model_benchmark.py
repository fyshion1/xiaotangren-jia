import json
import unittest

import httpx

from app.services.model_benchmark import probe


class BenchmarkTests(unittest.IsolatedAsyncioTestCase):
    async def test_stream_measures_visible_text_and_usage_without_logging_content(self):
        calls = []
        def handle(request):
            calls.append(request)
            chunks = [{'choices': [{'delta': {'reasoning_content': 'private reasoning'}}]},
                      {'choices': [{'delta': {'content': 'private response'}}]},
                      {'choices': [{'delta': {}, 'finish_reason': 'stop'}]},
                      {'choices': [], 'usage': {'completion_tokens': 8, 'completion_tokens_details': {'reasoning_tokens': 2}}}]
            return httpx.Response(200, text=''.join('data: ' + json.dumps(c) + '\n\n' for c in chunks) + 'data: [DONE]\n\n')
        result = await probe('https://test.invalid/v1', 'SECRET', 'fake', transport=httpx.MockTransport(handle))
        self.assertTrue(result['ok'])
        self.assertIsNotNone(result['first_text_seconds'])
        self.assertEqual(result['usage']['reasoning_tokens'], 2)
        self.assertNotIn('private', json.dumps(result))
        self.assertNotIn('SECRET', json.dumps(result))
        self.assertEqual(len(calls), 1)

    async def test_http_error_never_retries_or_exposes_body(self):
        calls = []
        def handle(request):
            calls.append(request)
            return httpx.Response(429, text='SECRET server body')
        result = await probe('https://test.invalid', '', 'fake', transport=httpx.MockTransport(handle))
        self.assertFalse(result['ok'])
        self.assertEqual(result['error'], 'http_429')
        self.assertEqual(len(calls), 1)
        self.assertNotIn('SECRET', json.dumps(result))

    async def test_complete_cannot_claim_first_token_measurement(self):
        response = {'choices': [{'message': {'content': 'hello'}, 'finish_reason': 'stop'}]}
        result = await probe('https://test.invalid', '', 'fake', stream=False,
                             transport=httpx.MockTransport(lambda r: httpx.Response(200, json=response)))
        self.assertTrue(result['ok'])
        self.assertIsNone(result['first_text_seconds'])

    async def test_truncated_or_unterminated_stream_is_not_success(self):
        for end in ('', 'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n'):
            result = await probe('https://test.invalid', '', 'fake', transport=httpx.MockTransport(
                lambda r: httpx.Response(200, text='data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'+end)))
            self.assertFalse(result['ok'])
