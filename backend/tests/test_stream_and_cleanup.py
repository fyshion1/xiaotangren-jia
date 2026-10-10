import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.providers import openai
from app.routers import messages
from app.services import attachments


class StreamTests(unittest.IsolatedAsyncioTestCase):
    async def collect(self, chunks):
        content = ''.join(
            'data: ' + (json.dumps(chunk) if isinstance(chunk, dict) else chunk) + '\n\n'
            for chunk in chunks
        )
        client = httpx.AsyncClient(transport=httpx.MockTransport(
            lambda _: httpx.Response(200, text=content)
        ))
        with patch.object(openai.httpx, 'AsyncClient', return_value=client):
            return [ev async for ev in openai.stream_chat([], 'test', 'https://test.invalid')]

    async def test_finish_reasons_survive_last_token(self):
        for reason in ('stop', 'length', 'content_filter'):
            with self.subTest(reason=reason):
                events = await self.collect([
                    {'choices': [{'delta': {'content': 'hello'}, 'finish_reason': reason}]},
                    '[DONE]',
                ])
                self.assertEqual(events, [
                    {'type': 'text', 'text': 'hello'},
                    {'type': 'done', 'finish_reason': reason},
                ])

    async def test_missing_done_with_finish_reason_is_valid(self):
        events = await self.collect([{'choices': [{'delta': {}, 'finish_reason': 'stop'}]}])
        self.assertEqual(events[-1]['type'], 'done')

    async def test_eof_without_terminal_is_an_error(self):
        events = await self.collect([{'choices': [{'delta': {'content': 'partial'}}]}])
        self.assertEqual(events[0]['text'], 'partial')
        self.assertEqual(events[-1]['type'], 'error')

    async def test_partial_reply_is_not_retried(self):
        calls = []

        async def broken(*args, **kwargs):
            calls.append(True)
            yield {'type': 'text', 'text': 'partial'}
            yield {'type': 'error', 'message': 'upstream_error', 'status': 502}

        with patch.object(openai, 'stream_chat', broken):
            events = [ev async for ev in openai.stream_chat_retry([], 'test', 'https://test.invalid')]
        self.assertEqual(len(calls), 1)
        self.assertEqual([ev['type'] for ev in events], ['text', 'error'])

    async def test_transient_error_before_text_retries(self):
        calls = []

        async def transient(*args, **kwargs):
            calls.append(True)
            if len(calls) == 1:
                yield {'type': 'error', 'message': 'busy', 'status': 503}
            else:
                yield {'type': 'text', 'text': 'complete'}
                yield {'type': 'done', 'finish_reason': 'stop'}

        with patch.object(openai, 'stream_chat', transient), patch.object(openai.asyncio, 'sleep'):
            events = [ev async for ev in openai.stream_chat_retry([], 'test', 'https://test.invalid')]
        self.assertEqual(len(calls), 2)
        self.assertEqual(events[-1]['type'], 'done')


class CleanupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        override = patch.object(attachments, 'ATTACHMENTS_DIR', self.root)
        override.start()
        self.addCleanup(override.stop)
        for session in ('single-test', 'xizi_single-test'):
            for kind in ('orig', 'thumb'):
                folder = self.root / session / kind
                folder.mkdir(parents=True)
                (folder / 'sample.jpg').write_bytes(b'fixture')
        app = FastAPI()
        app.include_router(messages.router, prefix='/api')
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def test_unconfirmed_or_unscoped_requests_cannot_delete(self):
        for query, body in [('', None), ('?session=single-test', None),
                            ('', {'confirmed': True}), ('?session=', {'confirmed': True}),
                            ('?session=single-test', {'confirmed': False}),
                            ('?session=..', {'confirmed': True}),
                            ('?session=%20', {'confirmed': True})]:
            with self.subTest(query=query, body=body):
                response = self.client.post('/api/attachments/clear-originals' + query, json=body)
                self.assertGreaterEqual(response.status_code, 400)
                self.assertEqual(len(list(self.root.glob('*/orig/*'))), 2)

    def test_clear_only_selected_session_and_keep_thumbnails(self):
        response = self.client.post('/api/attachments/clear-originals?session=xizi%40single-test',
                                    json={'confirmed': True})
        self.assertEqual(response.json(), {'removed': 1})
        self.assertTrue((self.root / 'single-test/orig/sample.jpg').exists())
        self.assertEqual(len(list(self.root.glob('*/thumb/*'))), 2)
        stats = self.client.get('/api/attachments/stats?session=xizi%40single-test').json()
        self.assertEqual(stats['current_session'], 'xizi_single-test')

    def test_service_rejects_empty_scope(self):
        for session in ('', ' ', '.', '..', None):
            with self.subTest(session=session), self.assertRaises(ValueError):
                attachments.clear_originals(session)
        self.assertEqual(len(list(self.root.glob('*/orig/*'))), 2)


if __name__ == '__main__':
    unittest.main()
