"""Real CLI tests use mocked paid provider, real Docker and disposable DB only."""
import asyncio
import json
import os
import shlex
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

from app import db
from app.services import exploration_agent as agent, exploration_budget as budget
from app.services import exploration_projects as projects, exploration_workspace as workspace

CFG = {'model': 'trusted-model', 'base_url': 'https://model.invalid/v1', 'api_key': 'host-only-test-key'}
USAGE = {'prompt_tokens': 100, 'completion_tokens': 20}


class Fixtures:
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        for name, value in [('DATA_DIR', Path(temp.name)), ('DB_PATH', Path(temp.name)/'test.db')]:
            p = patch.object(db, name, value)
            p.start()
            self.addCleanup(p.stop)
        db.init_db()
        self.project = projects.propose('dalaoda', 'dashiyin', 'agent测试', '仅工作区实验')
        self.request = projects.request_more(self.project, 'dalaoda', 'dashiyin', '测试')
        budget.begin('agent-test', {'persona_id': 'dalaoda', 'character_ids': ['dashiyin']})

    def approve(self, tokens=50000, caps=None):
        with patch.object(workspace, 'capability', return_value={'available': True, 'agent_available': True}):
            projects.approve(self.request, tokens, 1, caps or ['document', 'codex'])
        projects.attach('agent-test', 'dalaoda', 'dashiyin')


class AgentTests(Fixtures, unittest.IsolatedAsyncioTestCase):
    def test_text_functions_and_custom_translation(self):
        body = {'instructions': 'fixed', 'input': [{'role': 'user', 'content': [{'type': 'input_text', 'text': 'task'}]},
                {'type': 'custom_tool_call', 'name': 'apply_patch', 'call_id': 'c1', 'input': 'patch'},
                {'type': 'custom_tool_call_output', 'call_id': 'c1', 'output': 'ok'}],
                'tools': [{'type': 'custom', 'name': 'apply_patch', 'description': 'edit', 'format': {'type': 'grammar', 'definition': 'bounded'}},
                          {'type': 'function', 'name': 'exec_command', 'parameters': {'type': 'object'}}]}
        messages, tools, custom = agent.translate(body)
        self.assertEqual(custom, {'apply_patch'})
        self.assertIn('bounded', tools[0]['function']['description'])
        self.assertEqual(json.loads(messages[2]['tool_calls'][0]['function']['arguments']), {'input': 'patch'})
        self.assertEqual(messages[3]['role'], 'tool')

    def test_remote_tools_images_and_hidden_history_rejected(self):
        for body in [{'previous_response_id': 'hidden'}, {'conversation': 'hidden'},
                     {'tools': [{'type': 'web_search'}]}, {'tools': [{'type': 'computer_use'}]},
                     {'input': [{'role': 'user', 'content': [{'type': 'input_image', 'image_url': 'private'}]}]}]:
            with self.subTest(body=body), self.assertRaises(HTTPException):
                agent.translate(body)

    async def test_no_grant_no_paid_request(self):
        with patch.object(budget.openai, 'complete_chat_full', new_callable=AsyncMock) as provider:
            with self.assertRaises(HTTPException):
                await agent.respond('agent-test', {'input': 'hi'}, CFG)
            provider.assert_not_awaited()

    async def test_workspace_agent_selection_keeps_codex_permission_check(self):
        with patch.object(workspace, 'capability') as capability:
            with self.assertRaises(HTTPException) as denied:
                await workspace.execute('agent-test', 'Write a note.', agent_cfg=CFG, agent='codex')
            self.assertEqual(denied.exception.status_code, 409)
            capability.assert_not_called()
            with self.assertRaises(HTTPException) as unsupported:
                await workspace.execute('agent-test', 'Write a note.', agent_cfg=CFG, agent='claude')
            self.assertEqual(unsupported.exception.status_code, 422)
            capability.assert_not_called()

    async def test_trusted_provider_and_shared_input_output_accounting(self):
        self.approve()
        with patch.object(budget.openai, 'complete_chat_full', new_callable=AsyncMock,
                          return_value={'content': 'done', 'finish_reason': 'stop', 'usage': USAGE}) as provider:
            events = await agent.respond('agent-test', {'model': 'steal-model', 'base_url': 'http://private', 'input': 'hi'}, CFG)
            await agent.respond('agent-test', {'input': 'again'}, CFG)
        self.assertEqual(provider.await_args.kwargs['model'], 'trusted-model')
        self.assertEqual(events[-1]['type'], 'response.completed')
        self.assertEqual(projects.listing()[0]['grants'][0]['charged'], 240)
        with db._tx() as c:
            self.assertEqual(c.execute('SELECT COUNT(*) FROM exploration_calls').fetchone()[0], 2)

    async def test_tool_schema_reservation_blocks_before_paid_request(self):
        self.approve(tokens=1000)
        with patch.object(budget.openai, 'complete_chat_full', new_callable=AsyncMock) as provider:
            with self.assertRaises(HTTPException):
                await agent.respond('agent-test', {'input': 'hi', 'tools': [{'type': 'function', 'name': 'run', 'description': 'x'*2000}]}, CFG)
            provider.assert_not_awaited()

    async def test_unknown_usage_halts_even_after_new_approval(self):
        self.approve()
        with patch.object(budget.openai, 'complete_chat_full', new_callable=AsyncMock,
                          return_value={'content': 'done', 'finish_reason': 'stop', 'usage': None}):
            with self.assertRaises(HTTPException):
                await agent.respond('agent-test', {'input': 'hi'}, CFG)
        self.assertTrue(budget.status()['uncertain'])
        self.assertFalse(budget.active('agent-test'))
        self.assertGreater(projects.listing()[0]['grants'][0]['charged'], 0)

    async def test_six_call_guard_includes_agent_requests(self):
        self.approve()
        with patch.object(budget.openai, 'complete_chat_full', new_callable=AsyncMock,
                          return_value={'content': 'done', 'finish_reason': 'stop', 'usage': USAGE}) as provider:
            for _ in range(6):
                await agent.respond('agent-test', {'input': 'hi'}, CFG)
            with self.assertRaises(HTTPException):
                await agent.respond('agent-test', {'input': 'hi'}, CFG)
            self.assertEqual(provider.await_count, 6)

    def test_custom_tool_stream_and_final_usage(self):
        events = agent.response_events({'tool_calls': [{'id': 'c1', 'function': {'name': 'apply_patch', 'arguments': '{"input":"patch"}'}}],
                                        'usage': USAGE}, {'apply_patch'})
        self.assertEqual(events[-1]['response']['output'][0]['input'], 'patch')
        self.assertEqual(events[-1]['response']['usage']['input_tokens'], 100)
        self.assertIn('response.custom_tool_call_input.delta', [e['type'] for e in events])


@unittest.skipUnless(os.environ.get('XTR_SANDBOX_LIVE') == '1', 'requires local agent Docker image')
class AgentLiveTests(Fixtures, unittest.IsolatedAsyncioTestCase):
    async def test_real_cli_relay_tool_execution_export_and_metering(self):
        self.assertTrue(workspace.capability().get('agent_available'))
        self.approve()
        seen = []

        async def provider(messages, **kwargs):
            seen.append((messages, kwargs))
            tools = {t['function']['name']: t for t in kwargs.get('tools', [])}
            if len(seen) == 1:
                self.assertIn('exec_command', tools, list(tools))
                code = '''
import os, pathlib, socket, subprocess
assert os.getuid()==65534
assert not pathlib.Path('/var/run/docker.sock').exists()
assert not any('API_KEY' in k for k in os.environ)
assert os.statvfs('/reference').f_flag & os.ST_RDONLY
assert pathlib.Path('/sys/fs/cgroup/pids.max').read_text().strip() == '64'
assert pathlib.Path('/sys/fs/cgroup/memory.max').read_text().strip() == '268435456'
assert 'NoNewPrivs:\\t1' in pathlib.Path('/proc/self/status').read_text()
for target in ['/reference/escape.txt', '/etc/escape.txt']:
 try: pathlib.Path(target).write_text('fail')
 except OSError: pass
 else: raise AssertionError('escaped write')
try: socket.create_connection(('1.1.1.1',443),timeout=0.3)
except OSError: pass
else: raise AssertionError('escaped network')
assert subprocess.check_output(['git','-C','/work/desktop-pet','branch','--show-current'],text=True).strip() == 'sandbox-experiment'
pathlib.Path('/work/agent-result.md').write_text('isolated agent result')
print('AGENT_TOOL_OK')
'''
                command = 'python -c ' + shlex.quote(code)
                return {'content': '', 'finish_reason': 'tool_calls', 'usage': USAGE, 'tool_calls': [
                    {'id': 'tool-test', 'type': 'function', 'function': {'name': 'exec_command', 'arguments': json.dumps({'cmd': command, 'max_output_tokens': 500, 'yield_time_ms': 1000})}}]}
            self.assertTrue(any(m.get('role') == 'tool' and 'AGENT_TOOL_OK' in m.get('content', '') for m in messages), str(messages)[-2500:])
            return {'content': 'Work saved to agent-result.md.', 'finish_reason': 'stop', 'usage': USAGE}

        with patch.object(budget.openai, 'complete_chat_full', side_effect=provider):
            result = await workspace.execute('agent-test', 'Write a tiny result file.', agent_cfg=CFG)
        self.assertEqual(result['exit_code'], 0, result['output'])
        self.assertEqual(len(seen), 2, result['output'])
        self.assertIn('agent-result.md', result['exported'])
        self.assertEqual(workspace.files(self.project)[0]['content'], 'isolated agent result')
        self.assertEqual(projects.listing()[0]['grants'][0]['charged'], 240)
        self.assertFalse((workspace.REPO/'agent-result.md').exists())

    async def test_real_cli_budget_refusal_before_provider(self):
        self.approve(tokens=1000)
        with patch.object(budget.openai, 'complete_chat_full', new_callable=AsyncMock) as provider:
            with self.assertRaises(HTTPException):
                await workspace.execute('agent-test', 'Say hello.', agent_cfg=CFG)
            provider.assert_not_awaited()
        with db._tx() as c:
            self.assertIsNone(c.execute("SELECT 1 FROM exploration_workspace_jobs WHERE state='running'").fetchone())

    async def test_real_cli_revocation_cancels_and_conservatively_settles(self):
        self.approve()
        started = asyncio.Event()

        async def slow_provider(*args, **kwargs):
            started.set()
            await asyncio.Event().wait()

        with patch.object(budget.openai, 'complete_chat_full', side_effect=slow_provider):
            task = asyncio.create_task(workspace.execute('agent-test', 'Wait for model.', agent_cfg=CFG))
            try:
                await asyncio.wait_for(started.wait(), 15)
                projects.pause(self.project)
                with self.assertRaises(HTTPException):
                    await asyncio.wait_for(task, 12)
            finally:
                if not task.done():
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
        self.assertTrue(budget.status()['uncertain'])
        self.assertEqual(workspace.files(self.project), [])
        with db._tx() as c:
            self.assertIsNone(c.execute("SELECT 1 FROM exploration_workspace_jobs WHERE state='running'").fetchone())


if __name__ == '__main__':
    unittest.main()
