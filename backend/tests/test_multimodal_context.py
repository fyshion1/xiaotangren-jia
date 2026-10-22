import base64
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.routers import chat, images
from app.services import attachments


class MultimodalContextTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        for obj, name, value in (
            (chat.db, 'DB_PATH', self.root / 'test.db'),
            (chat.db, 'DATA_DIR', self.root),
            (attachments, 'ATTACHMENTS_DIR', self.root),
            (chat.db, 'list_characters', lambda: []),
            (chat, 'build_system_prompt', lambda **kwargs: 'system'),
            (chat, '_resolve_persona', lambda _: None),
        ):
            mock = patch.object(obj, name, value)
            mock.start()
            self.addCleanup(mock.stop)
        chat.db.init_db()
        chat.db.set_brain_default({'base_url': 'http://brain.test/v1', 'model': 'test', 'api_key': 'test-key'})
        folder = self.root / 'session' / 'orig'
        folder.mkdir(parents=True)
        buffer = io.BytesIO()
        Image.new('RGB', (2400, 1600), 'red').save(buffer, format='PNG')
        self.raw = buffer.getvalue()
        (folder / 'test.png').write_bytes(self.raw)
        self.url = '/api/files/session/orig/test.png'
        self.calls = []

        async def stream(messages, *args, **kwargs):
            self.calls.append(messages)
            yield {'type': 'text', 'text': 'reply'}
            yield {'type': 'done'}

        mock = patch.object(chat.openai, 'stream_chat_retry', stream)
        mock.start()
        self.addCleanup(mock.stop)
        app = FastAPI()
        app.include_router(chat.router)
        app.include_router(images.router)
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def test_followup_and_preview_send_identical_image_bytes(self):
        body = {'messages': [
            {'role': 'user', 'content': '看图', 'images': [self.url]},
            {'role': 'assistant', 'content': 'reply'},
            {'role': 'user', 'content': '图里是什么？'},
        ]}
        preview = self.client.post('/chat/preview', json=body)
        self.assertEqual(preview.status_code, 200, preview.text)
        response = self.client.post('/chat', json=body)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.calls[0], preview.json()['messages'])
        context = json.loads(response.text.split('data: ', 1)[1].split('\n', 1)[0])
        self.assertEqual(context['messages'][1]['image_count'], 1)
        self.assertEqual(context['messages'][-1]['image_count'], 0)
        self.assertNotIn('base64', json.dumps(context))
        content = self.calls[0][1]['content']
        self.assertEqual(content[0]['text'], '看图')
        self.assertEqual(content[1]['image_url']['url'], attachments.model_image_data(self.raw))
        self.assertEqual(self.calls[0][-1]['content'], '图里是什么？')

    def test_vision_keeps_previous_conversation(self):
        response = self.client.post('/images/chat', json={
            'image_base64': base64.b64encode(self.raw).decode(), 'prompt': '这是第二张',
            'messages': [{'role': 'user', 'content': '第一张', 'images': [self.url]},
                         {'role': 'assistant', 'content': '之前的回复'}],
        })
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(len(self.calls[0]), 4)
        self.assertEqual(self.calls[0][-1]['content'][1]['image_url']['url'], attachments.model_image_data(self.raw))

    def test_request_budget_keeps_newest_visuals_and_old_text(self):
        response = self.client.post('/chat/preview', json={'messages': [
            {'role': 'user', 'content': 'old', 'images': ['/api/files/missing.png'] * 8},
            {'role': 'assistant', 'content': 'reply'},
            {'role': 'user', 'content': 'new batch', 'images': [self.url] * 10},
        ]})
        self.assertEqual(response.status_code, 200, response.text)
        messages = response.json()['messages']
        self.assertIn('old', messages[1]['content'])
        self.assertEqual(len(messages[-1]['content']), 11)
        self.assertEqual(messages[2]['content'], 'reply')

    def test_more_than_ten_images_in_one_message_rejected(self):
        response = self.client.post('/chat/preview', json={'messages': [
            {'role': 'user', 'content': 'too many', 'images': [self.url] * 11},
        ]})
        self.assertEqual(response.status_code, 422)
        self.assertEqual(self.calls, [])

    def test_model_images_are_resized_and_original_is_unchanged(self):
        local = attachments.image_for_model(self.url)
        inline = attachments.image_for_model(attachments.to_data_url(self.raw))
        self.assertEqual(local, inline)
        raw, mime = attachments.parse_data_url(local)
        with Image.open(io.BytesIO(raw)) as image:
            self.assertEqual(image.size, (1280, 853))
        self.assertEqual(mime, 'image/jpeg')
        self.assertEqual((self.root / 'session/orig/test.png').read_bytes(), self.raw)

    def test_invalid_inline_image_rejected_before_provider(self):
        response = self.client.post('/chat', json={'messages': [
            {'role': 'user', 'content': 'broken', 'images': ['data:image/png;base64,YWJj']},
        ]})
        self.assertEqual(response.status_code, 422)
        self.assertEqual(self.calls, [])

    def test_invalid_or_missing_local_images_fail_explicitly(self):
        for url in ('/api/files/../../private.png', '/api/files/session/orig/missing.png', 'http://localhost/private'):
            response = self.client.post('/chat/preview', json={
                'messages': [{'role': 'user', 'content': '看图', 'images': [url]}],
            })
            self.assertEqual(response.status_code, 422, response.text)


if __name__ == '__main__':
    unittest.main()
