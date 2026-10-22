"""External embeddings stay independent of local inference and deployment mode."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import db
from app.config import Settings
from app.routers import memory as router
from app.services import embedding, memory, memory_retrieval


class EmbeddingApiTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        for name, value in [('DB_PATH', Path(temp.name) / 'db.sqlite'), ('DATA_DIR', Path(temp.name))]:
            p = patch.object(db, name, value)
            p.start(); self.addCleanup(p.stop)
        db.init_db()
        self.settings = Settings(_env_file=None, model_base_url='https://chat.invalid/v1',
                                 model_api_key='chat-secret', embed_engine='local')
        p = patch('app.config.get_settings', return_value=self.settings)
        p.start(); self.addCleanup(p.stop)
        app = FastAPI()
        app.include_router(router.router, prefix='/api')
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def save(self, **values):
        return self.client.put('/api/memories/embedding-config', json={
            'engine': 'cloud', 'base_url': 'https://embed.invalid/v1',
            'cloud_model': 'embedding-model', **values})

    def test_independent_credentials_saved_without_echo(self):
        response = self.save(api_key='embed-secret')
        self.assertEqual(response.status_code, 200)
        self.assertNotIn('embed-secret', response.text)
        self.assertTrue(response.json()['has_api_key'])
        self.assertEqual(memory.embeddings_config()['api_key'], 'embed-secret')
        self.save(api_key='')
        self.assertEqual(memory.embeddings_config()['api_key'], 'embed-secret')
        self.save(clear_api_key=True)
        self.assertEqual(memory.embeddings_config()['api_key'], '')

    def test_separate_endpoint_does_not_receive_chat_key(self):
        self.save()
        self.assertEqual(memory.embeddings_config()['api_key'], '')
        self.save(base_url='')
        self.assertEqual(memory.embeddings_config()['api_key'], 'chat-secret')

    def test_environment_supports_independent_key_and_no_changes_to_original_default(self):
        self.assertEqual(memory.embeddings_config()['engine'], 'local')
        self.settings.embed_base_url = 'https://embed.invalid/v1'
        self.settings.embed_api_key = 'env-secret'
        self.assertEqual(memory.embeddings_config()['api_key'], 'env-secret')

    def test_changed_provider_invalidates_vectors_but_changed_key_does_not(self):
        self.save(api_key='one')
        first = memory.current_engine_signature()
        self.save(api_key='two')
        self.assertEqual(memory.current_engine_signature(), first)
        self.save(base_url='https://other.invalid/v1')
        self.assertNotEqual(memory.current_engine_signature(), first)

    def test_invalid_configuration_rejected(self):
        for values in [{'engine': 'unknown'}, {'base_url': 'file:///tmp'},
                       {'base_url': 'https://user:secret@example.com/v1'},
                       {'cloud_model': '   '}]:
            self.assertIn(self.save(**values).status_code, (400, 422))

    def test_cloud_request_sorted_and_no_local_model_loaded(self):
        response = httpx.Response(200, json={'data': [
            {'index': 1, 'embedding': [0, 1]}, {'index': 0, 'embedding': [1, 0]}]})
        with patch.object(embedding.httpx, 'post', return_value=response) as post, \
             patch.object(embedding, '_load_local', side_effect=AssertionError('local model loaded')):
            vectors = embedding.embed_texts(['a', 'b'], engine='cloud', cloud_model='test',
                                           base_url='https://embed.invalid/v1/', api_key='secret')
        self.assertEqual(vectors, [[1, 0], [0, 1]])
        args, kwargs = post.call_args
        self.assertEqual(args[0], 'https://embed.invalid/v1/embeddings')
        self.assertEqual(kwargs['headers']['Authorization'], 'Bearer secret')
        self.assertEqual(kwargs['json']['encoding_format'], 'float')

    def test_bad_responses_become_embedding_errors(self):
        responses = [httpx.Response(401, text='sensitive upstream text'),
                     httpx.Response(200, text='not json'),
                     httpx.Response(200, json={'data': ['bad']}),
                     httpx.Response(200, json={'data': [{'index': 3, 'embedding': [1]}]}),
                     httpx.Response(200, json={'data': [{'index': 0, 'embedding': ['Infinity']}]})
                     ]
        for response in responses:
            with self.subTest(response=response), patch.object(embedding.httpx, 'post', return_value=response):
                with self.assertRaises(embedding.EmbeddingError) as raised:
                    embedding.embed_texts(['hello'], engine='cloud', base_url='https://embed.invalid/v1')
                self.assertNotIn('sensitive upstream text', str(raised.exception))

    def test_timeout_keeps_memory_and_keyword_retrieval(self):
        self.save()
        with patch.object(embedding.httpx, 'post', side_effect=httpx.ConnectTimeout('secret-url')):
            item = memory.remember('喜欢咖啡')
            self.assertIsNotNone(item)
            ranked = memory_retrieval.rank([{'id': 'test', 'text': '喜欢咖啡'}], '咖啡')
            self.assertTrue(ranked)
            self.assertEqual(ranked[0]['injection_reason'], 'keyword')


if __name__ == '__main__':
    unittest.main()
