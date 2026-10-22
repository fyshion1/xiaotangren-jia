import asyncio
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch
import httpx

from app import db
from app.routers import session_chat, tools
from app.services import agent_tools
from app.services import project_costs
from fastapi import FastAPI
from fastapi.testclient import TestClient


def decision(path="note.txt"):
    return {"tool_calls": [{"id": "call-model", "function": {
        "name": "local_read", "arguments": json.dumps({"path": path})}}]}


class AgentToolAPITests(unittest.TestCase):
    def test_daily_photo_context_tool_result_and_natural_reply(self):
        self.config.allowed_names = ['daily_life_record']
        messages = [{'role': 'user', 'content': [{'type': 'text', 'text': '我现在正在吃牛肉面'},
                    {'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,fixture'}}]}]
        self.model.side_effect = [
            {'tool_calls': [{'id': 'daily-photo', 'function': {'name': 'daily_life_record',
                'arguments': json.dumps({'kind': 'diet', 'content': '牛肉面'})}}]},
            {'content': '慢慢吃呀。', 'finish_reason': 'stop'}]
        with patch.object(project_costs, 'request', AsyncMock(return_value=httpx.Response(200, json={'content': '牛肉面'}))) as request:
            result = asyncio.run(agent_tools.generate(messages, {'model': 'fake-vision', 'base_url': 'http://unused'}, self.config,
                persona_id='dalaoda', session_id='single-dashiyin', feature_id='core', request_id='daily-photo-test', max_tokens=None))
            self.assertEqual(result.content, '慢慢吃呀。')
            self.assertEqual(request.await_args.args[:2], ('POST', 'daily'))
            self.assertTrue(request.await_args.kwargs['request_key'].startswith('call-'))
        self.assertTrue(any(isinstance(m.get('content'), list) for m in self.model.await_args_list[0].args[0]))
        history = self.model.await_args_list[1].args[0]
        self.assertTrue(any(m['role'] == 'tool' and '记录成功' in m['content'] for m in history))

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        for name, value in (("DATA_DIR", self.root), ("DB_PATH", self.root / "test.db")):
            p = patch.object(db, name, value)
            p.start()
            self.addCleanup(p.stop)
        p = patch.dict(os.environ, {"PERSONAL_MEMORY_ROOT": str(self.root / "memory")})
        p.start()
        self.addCleanup(p.stop)
        db.init_db()
        self.sandbox = self.root / "sandbox"
        self.sandbox.mkdir()
        (self.sandbox / "note.txt").write_text("PRIVATE-FILE-CONTENT", encoding="utf-8")
        self.config = agent_tools.ToolSettings(enabled=True, root=str(self.sandbox))
        self.model = AsyncMock(side_effect=[decision(), {"content": "已读取文本", "finish_reason": "stop"}])
        p = patch.object(agent_tools.openai, "complete_chat_full", self.model)
        p.start()
        self.addCleanup(p.stop)
        p = patch.object(session_chat, "_effective_config", return_value={"model": "test", "base_url": "http://unused", "api_key": "SECRET"})
        p.start()
        self.addCleanup(p.stop)
        p = patch.object(session_chat, "_to_openai_messages", side_effect=lambda messages, ids, **kw: [{"role": m.role, "content": m.content} for m in messages])
        p.start()
        self.addCleanup(p.stop)
        app = FastAPI()
        app.include_router(tools.router, prefix="/api")
        app.include_router(session_chat.router, prefix="/api")
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def enable(self):
        result = self.client.put('/api/tools/config', json=self.config.model_dump())
        self.assertEqual(result.status_code, 200, result.text)

    def body(self, **changes):
        return {"character_id": "dashiyin", "session_id": "single-dashiyin", "text": "读取 note.txt",
                "request_id": "test-agent-0001", "auto_memory": False, **changes}

    def test_config_defaults_validation_and_fail_closed_legacy_settings(self):
        initial = self.client.get('/api/tools/config').json()
        self.assertFalse(initial['config']['enabled'])
        self.assertEqual(len(initial['capabilities']), len(agent_tools.CAPABILITIES))
        self.assertFalse((self.root / 'tool-sandbox').exists())
        for changes in ({'allowed_names': ['shell']}, {'timeout_seconds': 999}, {'owner_persona_id': 'missing'}, {'root': '\x00'}):
            result = self.client.put('/api/tools/config', json={**self.config.model_dump(), **changes})
            self.assertEqual(result.status_code, 422, result.text)
        db.set_settings({agent_tools.SETTING_KEY: '{"enabled":true,"allowed_names":["shell"]}'})
        self.assertFalse(agent_tools.settings().enabled)

    def test_web_round_trip_streams_activity_and_replays_without_execution(self):
        self.enable()
        body = self.body(base_url='http://unused', model='test', api_key='SECRET')
        response = self.client.post('/api/chat/session/web-stream', json=body)
        self.assertEqual(response.status_code, 200)
        self.assertIn('event: tool_start', response.text)
        self.assertIn('event: tool_result', response.text)
        self.assertIn('PRIVATE-FILE-CONTENT', response.text)
        self.assertIn('event: done', response.text)
        self.assertEqual(self.model.await_count, 2)
        again = self.client.post('/api/chat/session/web-stream', json=body)
        self.assertIn('event: done', again.text)
        self.assertEqual(self.model.await_count, 2)
        runs = self.client.get('/api/tools/runs', params={'session_id': 'single-dashiyin'}).json()['items']
        self.assertEqual(len(runs), 1)
        self.assertEqual(runs[0]['status'], 'completed')
        self.assertNotIn('PRIVATE-FILE-CONTENT', json.dumps(runs))
        self.assertNotIn('SECRET', json.dumps(runs))
        self.assertNotIn('note.txt', json.dumps(runs))

    def test_journal_keeps_bounded_web_search_evidence_but_not_private_tool_output(self):
        self.enable()

        async def complete(history, model, base_url, api_key, **kwargs):
            return {'tool_calls': [{'id': 'search-1', 'function': {'name': 'web_search',
                'arguments': json.dumps({'query': '765PRO Thank You 歌词'})}}]} if not any(m.get('role') == 'tool' for m in history) else {'content': '找到了。'}

        from xiaotangren_tools import web_search
        with patch.object(agent_tools, 'web_search', web_search), \
             patch.object(agent_tools, 'ToolExecutor') as executor_factory:
            from xiaotangren_tools import ToolExecutor as RealExecutor
            executor = RealExecutor
            executor_factory.side_effect = lambda *a, **kw: executor(*a, **kw)
            with patch.object(agent_tools.openai, 'complete_chat_full', side_effect=complete), \
                 patch.object(web_search, 'find_cli', return_value=Path('C:/fake/omnireach.exe')), \
                 patch.object(web_search.subprocess, 'run', return_value=__import__('subprocess').CompletedProcess([], 0,
                     json.dumps({'results': [{'source': 'google', 'title': 'Thank You 歌詞', 'url': 'https://example.test', 'content': '正确歌词摘要'}]}).encode(), b'')):
                asyncio.run(agent_tools.generate([{'role': 'user', 'content': '搜歌词'}],
                    {'model': 'test', 'base_url': 'http://unused'}, self.config, persona_id='dalaoda',
                    session_id='search-session', feature_id='core', request_id='search-journal', max_tokens=None))
        runs = self.client.get('/api/tools/runs', params={'session_id': 'search-session'}).json()['items']
        journal = json.dumps(runs, ensure_ascii=False)
        self.assertIn('765PRO Thank You 歌词', journal)
        self.assertIn('正确歌词摘要', journal)
        self.assertIn('https://example.test', journal)

        async def file_run():
            return await agent_tools.generate([{'role': 'user', 'content': 'read'}],
                {'model': 'test', 'base_url': 'http://unused'}, self.config, persona_id='dalaoda',
                session_id='file-session', feature_id='core', request_id='file-journal', max_tokens=None)

        self.model.side_effect = [decision(), {'content': '完成'}]
        asyncio.run(file_run())
        file_runs = self.client.get('/api/tools/runs', params={'session_id': 'file-session'}).json()['items']
        self.assertNotIn('PRIVATE-FILE-CONTENT', json.dumps(file_runs))

    def test_lyrics_search_is_available_with_web_and_journaled_for_inspection(self):
        self.enable()
        self.config.allowed_names = ['web_search']
        rows = [{"id": 42, "trackName": "Thank You!", "artistName": "765 MILLIONSTARS",
                 "albumName": "Test Album", "duration": 200, "plainLyrics": "开头歌词内容"}]

        async def complete(history, model, base_url, api_key, **kwargs):
            if not any(m.get('role') == 'tool' for m in history):
                self.assertIn('lyrics_search', json.dumps(kwargs.get('tools', [])))
                self.assertIn('不能直接代存', ' '.join(m.get('content', '') for m in history if m.get('role') == 'system'))
                return {'tool_calls': [{'id': 'lyrics-1', 'function': {'name': 'lyrics_search',
                    'arguments': json.dumps({'title': 'Thank You!', 'artist': '765 MILLIONSTARS'})}}]}
            return {'content': '找到了候选。'}

        with patch('xiaotangren_tools.lyrics_search.lookup', return_value=rows):
            with patch.object(agent_tools.openai, 'complete_chat_full', side_effect=complete):
                asyncio.run(agent_tools.generate([{'role': 'user', 'content': '搜歌词'}],
                    {'model': 'test', 'base_url': 'http://unused'}, self.config, persona_id='dalaoda',
                    session_id='lyrics-session', feature_id='core', request_id='lyrics-journal', max_tokens=None))
        runs = self.client.get('/api/tools/runs', params={'session_id': 'lyrics-session'}).json()['items']
        journal = json.dumps(runs, ensure_ascii=False)
        self.assertIn('Thank You!', journal)
        self.assertIn('开头歌词内容', journal)
        self.assertIn('https://lrclib.net/api/get/42', journal)

    def test_full_lyrics_reach_model_after_search_and_read(self):
        self.config.allowed_names = ['web_search']
        text = '开头资料\n' + '中段资料\n' * 30 + '末尾资料'
        row = {'id': 42, 'trackName': 'Song', 'artistName': 'Singer', 'plainLyrics': text}
        self.model.side_effect = [
            {'tool_calls': [{'function': {'name': 'lyrics_search', 'arguments': json.dumps({'title': 'Song', 'artist': 'Singer'})}}]},
            {'tool_calls': [{'function': {'name': 'lyrics_read', 'arguments': json.dumps({'candidate_id': 42, 'title': 'Song', 'artist': 'Singer'})}}]},
            {'content': '已阅读到结尾，以下是全曲主题。'}]
        with patch('xiaotangren_tools.lyrics_search.lookup', return_value=[row]), \
             patch('xiaotangren_tools.lyrics_search.fetch_candidate', return_value=row):
            result = asyncio.run(agent_tools.generate([{'role': 'user', 'content': '读完整首再聊'}],
                {'model': 'test', 'base_url': 'http://unused'}, self.config, persona_id='dalaoda',
                session_id='lyrics-read-session', feature_id='qq_bridge', request_id='lyrics-read', max_tokens=1200))
        history = self.model.await_args_list[-1].args[0]
        outputs = [json.loads(m['content']) for m in history if m['role'] == 'tool']
        payload = json.loads(outputs[-1]['content'])
        self.assertEqual(payload['lyrics'], text)
        self.assertTrue(payload['complete'])
        self.assertEqual(result.status, 'completed')
        self.assertEqual(result.tool_receipts[-1]['name'], 'lyrics_read')

    def test_pet_uses_same_loop_and_ndjson_events(self):
        self.enable()
        response = self.client.post('/api/chat/session/stream', json=self.body())
        events = [json.loads(line) for line in response.text.splitlines()]
        self.assertIn('tool_result', [event['type'] for event in events])
        self.assertEqual(events[-1]['type'], 'done')
        self.assertEqual(self.model.await_count, 2)

    def test_other_features_and_disabled_clients_cannot_inherit_tools(self):
        self.enable()
        self.assertTrue(agent_tools.available('qq_bridge', 'dalaoda'))
        self.assertFalse(agent_tools.available('unknown', 'dalaoda'))
        self.config.qq_enabled = False
        self.assertFalse(agent_tools.available('core', 'other'))
        self.config.web_enabled = False
        self.config.pet_enabled = False
        self.enable()
        self.assertFalse(agent_tools.available('core', 'dalaoda'))
        self.assertFalse(agent_tools.available('desktop_pet', 'dalaoda'))
        self.assertFalse(agent_tools.available('qq_bridge', 'dalaoda'))

    def test_denied_file_result_reaches_model(self):
        self.enable()
        self.model.side_effect = [decision('../secret'), {"content": "无法访问越界文件"}]
        response = self.client.post('/api/chat/session/turn', json=self.body())
        self.assertEqual(response.status_code, 200, response.text)
        history = self.model.await_args_list[1].args[0]
        self.assertEqual(json.loads(history[-1]['content'])['code'], 'denied')

    def test_model_failure_journal_and_safe_user_retry(self):
        self.enable()
        self.model.side_effect = RuntimeError('SECRET upstream detail')
        response = self.client.post('/api/chat/session/turn', json=self.body())
        self.assertEqual(response.status_code, 502)
        self.assertNotIn('SECRET', response.text)
        runs = self.client.get('/api/tools/runs').json()['items']
        self.assertEqual(runs[0]['status'], 'failed')
        self.assertEqual(len(db.list_messages('single-dashiyin')), 1)
        self.model.side_effect = [{"content": "重试完成"}]
        self.assertEqual(self.client.post('/api/chat/session/turn', json=self.body()).status_code, 200)
        self.assertEqual(len(db.list_messages('single-dashiyin')), 2)

    def test_cancelled_run_settles_without_saving_file_contents(self):
        self.enable()

        async def run():
            entered = asyncio.Event()

            async def model(*args, **kwargs):
                entered.set()
                await asyncio.Event().wait()

            with patch.object(agent_tools.openai, 'complete_chat_full', model):
                task = asyncio.create_task(agent_tools.generate([], {'model': 'test', 'base_url': 'http://unused'}, self.config,
                    persona_id='dalaoda', session_id='single-dashiyin', feature_id='core', request_id='cancelled-run', max_tokens=None))
                await entered.wait()
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task

        asyncio.run(run())
        self.assertEqual(self.client.get('/api/tools/runs').json()['items'][0]['status'], 'cancelled')


if __name__ == '__main__':
    unittest.main()
