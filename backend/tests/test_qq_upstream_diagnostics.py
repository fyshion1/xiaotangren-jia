"""失败后的只读检查不调用付费生成接口，也不泄露响应正文。"""
import unittest
from unittest.mock import patch

import httpx

from app.services.qq_conversation import upstream_accessibility


class UpstreamDiagnosticsTests(unittest.IsolatedAsyncioTestCase):
    async def check(self, response):
        requests = []
        def handle(request):
            requests.append(request)
            if isinstance(response, Exception):
                raise response
            return response
        client = httpx.AsyncClient(transport=httpx.MockTransport(handle))
        with patch('app.services.qq_conversation.httpx.AsyncClient', return_value=client):
            result = await upstream_accessibility({'base_url': 'https://upstream.invalid/v1/',
                                                   'api_key': 'PRIVATE', 'model': 'model-new'})
        self.assertEqual(len(requests), 1)
        self.assertEqual(requests[0].method, 'GET')
        self.assertEqual(str(requests[0].url), 'https://upstream.invalid/v1/models')
        self.assertEqual(requests[0].content, b'')
        self.assertNotIn('PRIVATE', result)
        return result

    async def test_listed_model_does_not_claim_generation_is_healthy(self):
        result = await self.check(httpx.Response(200, json={'data': [{'id': 'model-new'}]}))
        self.assertIn('生成通道可能仍异常', result)

    async def test_missing_model_and_http_errors_are_specific(self):
        result = await self.check(httpx.Response(200, json={'data': [{'id': 'old-model'}]}))
        self.assertIn('未列出当前模型', result)
        result = await self.check(httpx.Response(401, text='PRIVATE upstream detail'))
        self.assertIn('HTTP 401', result)

    async def test_connection_error_and_nonstandard_list_do_not_leak_details(self):
        result = await self.check(httpx.ConnectTimeout('PRIVATE'))
        self.assertIn('ConnectTimeout', result)
        result = await self.check(httpx.Response(200, text='PRIVATE web page'))
        self.assertIn('状态未知', result)
