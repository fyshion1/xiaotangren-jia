"""结构化回复选项必须透传，普通调用保持原请求格式。"""
import json
import unittest
from unittest.mock import patch

import httpx

from app.providers import openai


class ProviderJsonFormatTests(unittest.IsolatedAsyncioTestCase):
    async def test_collected_stream_keeps_final_usage_and_tool_deltas(self):
        requests = []
        frames = [
            {'choices': [{'delta': {'content': 'hello '}, 'finish_reason': None}]},
            {'choices': [{'delta': {'content': 'world', 'tool_calls': [{'index': 0, 'id': 'call-1', 'function': {'name': 'read', 'arguments': '{"p":'}}]}, 'finish_reason': None}]},
            {'choices': [{'delta': {'tool_calls': [{'index': 0, 'function': {'arguments': '"a"}'}}]}, 'finish_reason': 'tool_calls'}]},
            {'choices': [], 'usage': {'prompt_tokens': 100, 'completion_tokens': 20, 'total_tokens': 120}}]
        def respond(request):
            requests.append(json.loads(request.content))
            body = ''.join('data: '+json.dumps(frame)+'\n\n' for frame in frames)+'data: [DONE]\n\n'
            return httpx.Response(200, text=body, headers={'content-type': 'text/event-stream'})
        client_type = httpx.AsyncClient
        with patch.object(openai.httpx, 'AsyncClient', side_effect=lambda **kw: client_type(**kw, transport=httpx.MockTransport(respond))):
            result = await openai.complete_chat_full([], 'fake', 'https://offline.invalid/v1', stream=True,
                response_format={'type': 'json_object'}, tools=[{'type': 'function'}])
        self.assertEqual(len(requests), 1)
        self.assertTrue(requests[0]['stream'])
        self.assertTrue(requests[0]['stream_options']['include_usage'])
        self.assertEqual(requests[0]['response_format'], {'type': 'json_object'})
        self.assertEqual(result['content'], 'hello world')
        self.assertEqual(result['usage']['total_tokens'], 120)
        self.assertEqual(result['tool_calls'][0]['function'], {'name': 'read', 'arguments': '{"p":"a"}'})
        self.assertEqual(result['finish_reason'], 'tool_calls')

    async def test_partial_stream_does_not_retry_or_return_partial_plan(self):
        requests = []
        def respond(request):
            requests.append(request)
            return httpx.Response(200, text='data: {"choices":[{"delta":{"content":"half"}}]}\n\n',
                                  headers={'content-type': 'text/event-stream'})
        client_type = httpx.AsyncClient
        with patch.object(openai.httpx, 'AsyncClient', side_effect=lambda **kw: client_type(**kw, transport=httpx.MockTransport(respond))):
            with self.assertRaisesRegex(RuntimeError, '提前结束'):
                await openai.complete_chat_full([], 'fake', 'https://offline.invalid/v1', stream=True)
        self.assertEqual(len(requests), 1)

    async def test_stream_json_format_is_opt_in(self):
        requests = []
        def respond(request):
            requests.append(json.loads(request.content))
            return httpx.Response(200, text='data: [DONE]\n\n', headers={'content-type': 'text/event-stream'})
        client_type = httpx.AsyncClient
        def client(**kwargs):
            return client_type(**kwargs, transport=httpx.MockTransport(respond))
        with patch.object(openai.httpx, 'AsyncClient', side_effect=client):
            for fmt in [None, {'type': 'json_object'}]:
                events = [event async for event in openai.stream_chat(
                    [{'role': 'user', 'content': 'test'}], 'fake', 'https://offline.invalid/v1', response_format=fmt)]
                self.assertEqual(events[-1]['type'], 'done')
        self.assertNotIn('response_format', requests[0])
        self.assertEqual(requests[1]['response_format'], {'type': 'json_object'})

    async def test_json_format_is_opt_in_and_sent_to_upstream(self):
        requests = []

        def respond(request):
            requests.append(json.loads(request.content))
            return httpx.Response(200, json={'usage': {'prompt_tokens': 40, 'completion_tokens': 12}, 'choices': [{
                'message': {'content': '{"actions":[]}'}, 'finish_reason': 'stop'}]})

        client_type = httpx.AsyncClient
        def client(**kwargs):
            return client_type(**kwargs, transport=httpx.MockTransport(respond))

        with patch.object(openai.httpx, 'AsyncClient', side_effect=client):
            for fmt in [None, {'type': 'json_object'}]:
                result = await openai.complete_chat_full(
                    [{'role': 'user', 'content': 'test'}], 'fake', 'https://offline.invalid/v1',
                    response_format=fmt)
                self.assertEqual(result['finish_reason'], 'stop')
                self.assertEqual(result['usage'], {'prompt_tokens': 40, 'completion_tokens': 12})
        self.assertNotIn('response_format', requests[0])
        self.assertEqual(requests[1]['response_format'], {'type': 'json_object'})
