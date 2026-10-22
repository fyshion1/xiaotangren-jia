"""Offline permission, accounting, workspace and network boundary regression tests."""
import asyncio
import json
from pathlib import Path
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import AsyncMock, patch
from types import SimpleNamespace

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app import db
from app.routers import exploration_projects as router
from app.services import exploration_budget as budget, exploration_projects as projects
from app.services import exploration_workspace as workspace, exploration_web as web


class ProjectTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        for key, value in [('DATA_DIR', self.root), ('DB_PATH', self.root/'test.db')]:
            p = patch.object(db, key, value)
            p.start()
            self.addCleanup(p.stop)
        db.init_db()
        self.project = projects.propose('dalaoda', 'dashiyin', '桌宠小动作', '在自己的副本里做个小实验')
        self.session = {'persona_id': 'dalaoda', 'character_ids': ['dashiyin']}
        self.app = FastAPI()
        self.app.include_router(router.router, prefix='/api')
        self.client = TestClient(self.app)
        self.addCleanup(self.client.close)
        self.headers = {'X-Exploration-Dashboard': '1'}

    def request(self):
        return projects.request_more(self.project, 'dalaoda', 'dashiyin', '想把这个项目做完')

    def authorize(self, tokens=12000, capabilities=None):
        return projects.approve(self.request(), tokens, 2, capabilities or ['document'])

    def attach(self, run='work'):
        budget.begin(run, self.session)
        return projects.attach(run, 'dalaoda', 'dashiyin')

    def test_chat_agreement_or_forged_body_cannot_grant_budget(self):
        request_id = self.request()
        payload = {'tokens': 12000, 'hours': 2, 'capabilities': ['document']}
        response = self.client.post(f'/api/exploration-projects/requests/{request_id}/approve', json=payload)
        self.assertEqual(response.status_code, 403)
        self.assertIsNone(self.attach())
        self.assertEqual(projects.listing()[0]['requests'][0]['state'], 'pending')

    def test_local_dashboard_approval_and_replay(self):
        request_id = self.request()
        url = f'/api/exploration-projects/requests/{request_id}/approve'
        payload = {'tokens': 12000, 'hours': 2, 'capabilities': ['document', 'web_read']}
        response = self.client.post(url, json=payload, headers={**self.headers, 'Origin': 'http://localhost:5173'})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.client.post(url, json=payload, headers=self.headers).status_code, 409)
        self.assertEqual(self.attach()['id'], response.json()['grant_id'])

    def test_cross_origin_and_nonlocal_approval_rejected(self):
        request_id = self.request()
        url = f'/api/exploration-projects/requests/{request_id}/approve'
        payload = {'tokens': 12000, 'hours': 2, 'capabilities': ['document']}
        response = self.client.post(url, json=payload, headers={**self.headers, 'Origin': 'https://evil.invalid'})
        self.assertEqual(response.status_code, 403)
        with TestClient(self.app, client=('192.168.1.9', 5000)) as remote:
            self.assertEqual(remote.post(url, json=payload, headers=self.headers).status_code, 403)

    def test_pending_request_is_idempotent_and_bound_to_role(self):
        request_id = self.request()
        self.assertEqual(self.request(), request_id)
        with self.assertRaises(HTTPException):
            projects.request_more(self.project, 'dalaoda', 'other', '想用别人的额度')
        with self.assertRaises(HTTPException):
            projects.progress(self.project, 'other', 'dashiyin', '假进度')

    def test_rejected_project_cannot_immediately_request_again(self):
        projects.reject(self.request())
        with self.assertRaises(HTTPException) as error:
            self.request()
        self.assertEqual(error.exception.status_code, 429)

    def test_pause_blocks_a_finished_runs_pending_publication(self):
        self.authorize()
        self.attach()
        budget.finish('work')
        self.assertIn('work', budget.status()['publishable_runs'])
        projects.pause(self.project)
        self.assertNotIn('work', budget.status()['publishable_runs'])

    def test_requests_are_limited_across_new_projects(self):
        self.request()
        for n in range(2):
            project = projects.propose('dalaoda', 'dashiyin', '想法'+str(n), '实验')
            projects.request_more(project, 'dalaoda', 'dashiyin', '想做')
        other = projects.propose('dalaoda', 'dashiyin', '再来一个', '实验')
        with self.assertRaises(HTTPException) as error:
            projects.request_more(other, 'dalaoda', 'dashiyin', '想做')
        self.assertEqual(error.exception.status_code, 429)

    def test_grant_usage_is_shared_across_runs_and_does_not_spend_daily_baseline(self):
        self.authorize(tokens=1000)
        self.attach('one')
        db.set_feature_settings('qq_bridge', {'proactive.day_tokens': 0, 'proactive.run_tokens': 0})
        call = budget.reserve('one', 0, [], 10)
        budget.settle(call, {'input_tokens': 500, 'output_tokens': 100})
        budget.finish('one')
        self.attach('two')
        with self.assertRaises(HTTPException):
            budget.reserve('two', 0, [], 10)
        budget.begin('normal', self.session)
        with self.assertRaises(HTTPException):
            budget.reserve('normal', 0, [], 10)
        self.assertEqual(budget.status()['project_charged'], 600)
        self.assertEqual(projects.listing()[0]['grants'][0]['charged'], 600)

    def test_concurrent_runs_cannot_double_spend_grant(self):
        self.authorize(tokens=1000)
        self.attach('one')
        self.attach('two')
        def reserve(run):
            try:
                return budget.reserve(run, 0, [], 10)
            except HTTPException:
                return None
        with ThreadPoolExecutor(2) as pool:
            results = list(pool.map(reserve, ['one', 'two']))
        self.assertEqual(sum(x is not None for x in results), 1)

    def test_approval_cannot_upgrade_an_existing_unapproved_run(self):
        self.attach('old')
        call = budget.reserve('old', 0, [], 10)
        budget.settle(call, {'input_tokens': 20, 'output_tokens': 10})
        self.authorize()
        self.assertIsNone(projects.attach('old', 'dalaoda', 'dashiyin'))
        self.assertIsNotNone(self.attach('new'))

    def test_small_remainder_can_fall_back_before_any_charge_to_request_renewal(self):
        self.authorize(tokens=1000)
        self.attach('small')
        self.assertTrue(projects.fallback_if_insufficient('small', 5000))
        with db._tx() as c:
            self.assertIsNone(projects.grant_for_run(c, 'small'))
        call = budget.reserve('small', 0, [], 10)
        budget.settle(call, {'input_tokens': 20, 'output_tokens': 10})
        self.assertEqual(projects.listing()[0]['grants'][0]['charged'], 0)
        self.assertEqual(budget.status()['project_charged'], 0)

    def test_revocation_expiry_and_stop_block_writes(self):
        grant = self.authorize()
        self.attach()
        workspace.write('work', 'notes/idea.md', '草稿')
        with db._tx() as c:
            c.execute('UPDATE exploration_grants SET expires=? WHERE id=?', (time.time()-1, grant))
        with self.assertRaises(HTTPException):
            workspace.write('work', 'notes/idea.md', '不应写入')
        self.assertEqual(workspace.files(self.project)[0]['content'], '草稿')
        projects.pause(self.project)
        self.assertFalse(budget.active('work'))
        with self.assertRaises(HTTPException):
            budget.reserve('work', 0, [], 10)

    def test_stop_between_preflight_and_write_is_checked_atomically(self):
        self.authorize()
        grant = self.attach()
        budget.stop()
        with patch.object(projects, 'check_run', return_value=grant), self.assertRaises(HTTPException):
            workspace.write('work', 'late.md', 'must not save after pause')
        self.assertEqual(workspace.files(self.project), [])

    def test_unknown_usage_cannot_be_bypassed_by_a_new_approval(self):
        self.authorize()
        self.attach('one')
        call = budget.reserve('one', 0, [], 10)
        budget.settle(call, None)
        self.authorize()
        self.attach('two')
        with self.assertRaises(HTTPException):
            budget.reserve('two', 0, [], 10)

    def test_workspace_paths_quotas_and_destruction_preserve_ledger(self):
        self.authorize()
        self.attach()
        for path in ('../escape.py', '/abs.py', 'C:/host.py', '.git/config', 'a//b.py', 'a\\b.py', 'a/../b.py', 'a.exe'):
            with self.subTest(path=path), self.assertRaises(HTTPException):
                workspace.write('work', path, 'x')
        with self.assertRaises(HTTPException):
            workspace.write('work', 'large.txt', 'x'*32001)
        workspace.write('work', 'hello.py', 'print("hi")')
        call = budget.reserve('work', 0, [], 10)
        budget.settle(call, {'input_tokens': 20, 'output_tokens': 10})
        workspace.discard(self.project)
        self.assertEqual(workspace.files(self.project), [])
        self.assertEqual(projects.listing()[0]['grants'][0]['charged'], 30)
        self.assertFalse(budget.active('work'))

    def test_python_and_external_agents_fail_closed(self):
        with patch.object(workspace, 'capability', return_value={'available': False}):
            with self.assertRaises(HTTPException):
                self.authorize(capabilities=['document', 'python'])
        with patch.object(workspace, 'capability', return_value={'available': True, 'agent_available': False}):
            with self.assertRaises(HTTPException):
                self.authorize(capabilities=['document', 'codex'])
        self.assertEqual(projects.listing()[0]['requests'][0]['state'], 'pending')

    def test_snapshot_excludes_secrets_data_and_git(self):
        repo = self.root/'source'
        src = repo/'features/desktop-pet/src'
        src.mkdir(parents=True)
        (src/'hello.py').write_text('print("hi")')
        (src/'secret.py').write_text('password="should-not-copy"')
        (src/'key.py').write_text('api_key="sk-abcdefghijklmnopqrstuv"')
        (src/'.env').write_text('KEY=private')
        (src/'data').mkdir()
        (src/'data'/'private.py').write_text('private')
        (repo/'features/desktop-pet/.git').mkdir()
        with patch.object(workspace, 'REPO', repo):
            root = workspace.snapshot()
            self.assertFalse(root.is_relative_to(workspace.REPO))
            self.assertFalse(root.is_relative_to(db.DATA_DIR))
            self.assertEqual([p.relative_to(root).as_posix() for p in root.rglob('*') if p.is_file()], ['desktop-pet/src/hello.py'])
            self.assertEqual(workspace.reference_index('desktop-pet/src/'), ['desktop-pet/src/hello.py'])
            self.assertEqual(workspace.read_reference('desktop-pet/src/hello.py', 6), 'print("hi")'[6:])
            workspace.remove_snapshot(root)
            self.assertFalse(root.exists())
        with self.assertRaises(ValueError):
            workspace.remove_snapshot(repo)

    def test_readonly_snapshot_includes_bridge_and_desktop_runtime_sources(self):
        repo = self.root/'readonly-source'
        paths = ['features/qq-bridge/qqbridge/conversation.py', 'features/desktop-pet/electron/main.cjs',
                 'docs/integrations/sample.md']
        for name in paths:
            target = repo/name; target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text('source content', encoding='utf-8')
        with patch.object(workspace, 'REPO', repo):
            self.assertEqual(workspace.read_reference('features/qq-bridge/qqbridge/conversation.py'), 'source content')
            self.assertEqual(workspace.read_reference('desktop-pet/electron/main.cjs'), 'source content')
            self.assertEqual(workspace.read_reference('docs/integrations/sample.md'), 'source content')

    def test_container_command_has_no_host_write_mount_or_credentials(self):
        args = workspace.command('sha256:'+'a'*64, 'xtr-sandbox-'+'a'*32, self.root)
        for flag in ('--network=none', '--read-only', '--cap-drop=ALL', '--pids-limit=32', '--memory=256m', '--user=65534:65534', '--pull=never'):
            self.assertIn(flag, args)
        mounts = [args[i+1] for i, x in enumerate(args) if x == '--mount']
        self.assertEqual(len(mounts), 1)
        self.assertTrue(mounts[0].endswith(',target=/reference,readonly'))
        self.assertNotIn('docker.sock', ' '.join(args))
        self.assertIn('timeout=25', workspace.BOOTSTRAP)

    def test_three_execution_failures_revoke_only_current_grant(self):
        grant_id = self.authorize()
        grant = self.attach()
        for _ in range(3):
            workspace.record_execution(grant, {'exit_code': 1, 'output': 'failed'})
        self.assertFalse(budget.active('work'))
        self.assertEqual(projects.listing()[0]['grants'][0]['state'], 'revoked')
        renewed_id = self.authorize()
        self.assertNotEqual(grant_id, renewed_id)
        renewed = self.attach('new')
        workspace.record_execution(renewed, {'exit_code': 1, 'output': 'failed'})
        self.assertTrue(budget.active('new'))

    def run_mock_container(self, exports, revoke=False):
        with patch.object(workspace, 'capability', return_value={'available': True, 'image_id': 'sha256:'+'a'*64}):
            self.authorize(capabilities=['document', 'python'])
            self.attach()
            workspace.write('work', 'main.py', 'print("hello")')
            async def execute():
                stream = asyncio.StreamReader()
                stream.feed_data(('hello\nXTR_EXPORT:'+json.dumps(exports)).encode())
                stream.feed_eof()
                process = SimpleNamespace(returncode=None)
                process.stdin = SimpleNamespace(write=lambda data: None, drain=AsyncMock(), close=lambda: None)
                async def read(size):
                    if revoke:
                        projects.pause(self.project)
                    return await stream.read(size)
                process.stdout = SimpleNamespace(read=read)
                async def wait():
                    process.returncode = 0
                    return 0
                process.wait = wait
                process.kill = lambda: setattr(process, 'returncode', -9)
                cleanup = SimpleNamespace(returncode=0, communicate=AsyncMock(return_value=(b'', b'')))
                factory = AsyncMock(side_effect=[process, cleanup])
                with patch.object(workspace.asyncio, 'create_subprocess_exec', factory):
                    return await workspace.execute('work', 'main.py')
            return asyncio.run(execute())

    def test_container_exports_are_revalidated_and_persisted(self):
        result = self.run_mock_container({'notes/result.md': '完成的小实验'})
        self.assertEqual(result['exported'], ['notes/result.md'])
        self.assertEqual(result['exit_code'], 0)
        self.assertNotIn('XTR_EXPORT', result['output'])
        self.assertEqual(next(f for f in workspace.files(self.project) if f['path'] == 'notes/result.md')['content'], '完成的小实验')
        with db._tx() as c:
            self.assertEqual(c.execute('SELECT state FROM exploration_workspace_jobs').fetchone()[0], 'finished')

    def test_container_cannot_export_outside_workspace(self):
        with self.assertRaises(HTTPException):
            self.run_mock_container({'../escape.py': 'not allowed'})
        self.assertEqual([f['path'] for f in workspace.files(self.project)], ['main.py'])
        self.assertFalse((self.root/'escape.py').exists())

    def test_revocation_during_execution_blocks_export(self):
        with self.assertRaises(HTTPException):
            self.run_mock_container({'notes/result.md': 'not allowed'}, revoke=True)
        self.assertEqual([f['path'] for f in workspace.files(self.project)], ['main.py'])

    def test_auto_remove_race_checks_that_container_is_really_absent(self):
        removal = SimpleNamespace(returncode=1, communicate=AsyncMock(return_value=(b'', b'removal already in progress')))
        inspection = SimpleNamespace(returncode=1, communicate=AsyncMock(return_value=(b'', b'No such object: xtr-sandbox-test')))
        with patch.object(workspace.asyncio, 'create_subprocess_exec', AsyncMock(side_effect=[removal, inspection])) as calls:
            self.assertTrue(asyncio.run(workspace.remove_container('xtr-sandbox-'+'a'*32)))
        self.assertEqual(calls.await_count, 2)


class NetworkTests(unittest.TestCase):
    def test_fake_ip_resolution_never_allows_a_private_destination(self):
        fake = [(2, 1, 6, '', ('198.18.1.5', 443))]
        with patch.object(web.socket, 'getaddrinfo', return_value=fake), patch.object(web, 'resolve_fake_ip', return_value=['8.8.8.8']):
            self.assertEqual(web.destination('https://public.example')[2], '8.8.8.8')
        for addresses in (['127.0.0.1'], ['198.18.1.5'], ['8.8.8.8', '10.1.2.3']):
            with patch.object(web.socket, 'getaddrinfo', return_value=fake), patch.object(web, 'resolve_fake_ip', return_value=addresses), self.assertRaises(HTTPException):
                web.destination('https://public.example')

    def test_redirect_is_revalidated_without_sending_credentials(self):
        def resolve(host, *args, **kwargs):
            address = '8.8.8.8' if host == 'public.example' else '127.0.0.1'
            return [(2, 1, 6, '', (address, 443))]
        response = SimpleNamespace(status=302, getheader=lambda key, default=None: 'https://private.example' if key == 'Location' else default)
        with patch.object(web.socket, 'getaddrinfo', side_effect=resolve), \
             patch.object(web.http.client.HTTPSConnection, 'request') as request, \
             patch.object(web.http.client.HTTPSConnection, 'getresponse', return_value=response):
            with self.assertRaises(HTTPException):
                web.fetch('https://public.example')
        self.assertEqual(request.call_count, 1)
        self.assertEqual(request.call_args.args[0], 'GET')
        self.assertNotIn('Cookie', request.call_args.kwargs['headers'])
        self.assertNotIn('Authorization', request.call_args.kwargs['headers'])

    def test_private_local_special_and_mixed_dns_are_rejected(self):
        for url in ('http://example.com', 'https://localhost', 'https://a.local', 'https://example.com:8000', 'https://u:p@example.com', 'https://example.com\nX:foo'):
            with self.subTest(url=url), self.assertRaises(HTTPException):
                web.destination(url)
        for addresses in (['127.0.0.1'], ['10.1.2.3'], ['169.254.169.254'], ['::1'], ['64:ff9b::7f00:1'], ['2002:7f00:1::'], ['224.0.0.1'], ['8.8.8.8', '192.168.0.1']):
            answers = [(2, 1, 6, '', (a, 443)) for a in addresses]
            with patch.object(web.socket, 'getaddrinfo', return_value=answers), self.assertRaises(HTTPException):
                web.destination('https://public.example')

    def test_public_dns_is_pinned_and_html_is_text_only(self):
        answers = [(2, 1, 6, '', ('8.8.8.8', 443))]
        with patch.object(web.socket, 'getaddrinfo', return_value=answers):
            _, host, address = web.destination('https://public.example/path')
        self.assertEqual((host, address), ('public.example', '8.8.8.8'))
        parser = web.Text()
        parser.feed('<script>steal()</script><style>x</style><p>蓝色大肥鱼</p><a href="/fish">作品</a>')
        self.assertEqual(parser.parts, ['蓝色大肥鱼', '作品'])
        self.assertEqual(parser.links, ['/fish'])


if __name__ == '__main__':
    unittest.main()
