"""Opt-in real container checks. No paid model, QQ, or external HTTP request.

PowerShell: $env:XTR_SANDBOX_LIVE='1'; .venv/Scripts/python -m unittest tests.test_exploration_container
"""
import asyncio
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

from fastapi import HTTPException

from app import db
from app.services import exploration_budget as budget, exploration_projects as projects
from app.services import exploration_workspace as workspace


@unittest.skipUnless(os.environ.get('XTR_SANDBOX_LIVE') == '1', 'requires explicit local Docker validation')
class ContainerTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        for key, value in [('DATA_DIR', Path(temp.name)), ('DB_PATH', Path(temp.name)/'test.db')]:
            p = patch.object(db, key, value)
            p.start()
            self.addCleanup(p.stop)
        db.init_db()
        self.assertTrue(workspace.capability()['available'], 'Docker Linux image must be built first')
        self.project = projects.propose('dalaoda', 'dashiyin', '隔离验证', '仅在临时数据库和工作区验证')
        request = projects.request_more(self.project, 'dalaoda', 'dashiyin', '测试隔离边界')
        projects.approve(request, 12000, 1, ['document', 'python'])
        budget.begin('live-test', {'persona_id': 'dalaoda', 'character_ids': ['dashiyin']})
        projects.attach('live-test', 'dalaoda', 'dashiyin')

    async def run_code(self, code):
        workspace.write('live-test', 'main.py', code)
        return await workspace.execute('live-test', 'main.py')

    async def test_read_only_network_resources_git_and_export(self):
        result = await self.run_code('''
import os, pathlib, socket, subprocess
assert pathlib.Path('/work/docs/README.md').is_file()
assert pathlib.Path('/work/docs/interfaces.md').is_file()
assert pathlib.Path('/work/docs/memory-context.md').is_file()
assert not pathlib.Path('/work/memory').exists()  # Original personal store is not mounted.
assert os.getuid() == 65534
status = pathlib.Path('/proc/self/status').read_text()
assert 'NoNewPrivs:\\t1' in status and 'Seccomp:\\t2' in status
assert int(pathlib.Path('/sys/fs/cgroup/memory.max').read_text()) == 268435456
assert int(pathlib.Path('/sys/fs/cgroup/pids.max').read_text()) == 32
quota, period = map(int, pathlib.Path('/sys/fs/cgroup/cpu.max').read_text().split())
assert quota / period == 0.5
assert not pathlib.Path('/var/run/docker.sock').exists()
assert os.statvfs('/reference').f_flag & os.ST_RDONLY
assert not any('API_KEY' in key or 'QQ_TOKEN' in key for key in os.environ)
for path in ('/reference/escape.txt', '/etc/xtr-escape.txt'):
    try:
        pathlib.Path(path).write_text('must fail')
    except OSError:
        pass
    else:
        raise AssertionError('write escaped workspace')
try:
    socket.create_connection(('1.1.1.1', 443), timeout=0.5)
except OSError:
    pass
else:
    raise AssertionError('network escaped container')
branch = subprocess.check_output(['git', '-C', '/work/desktop-pet', 'branch', '--show-current'], text=True).strip()
assert branch == 'sandbox-experiment', branch
assert not subprocess.check_output(['git', '-C', '/work/desktop-pet', 'remote'], text=True).strip()
pathlib.Path('/work/desktop-pet/sandbox-result.md').write_text('isolated experiment', encoding='utf-8')
print('BOUNDARIES_OK', flush=True)
''')
        self.assertEqual(result['exit_code'], 0, result['output'])
        self.assertIn('BOUNDARIES_OK', result['output'])
        self.assertIn('desktop-pet/sandbox-result.md', result['exported'])
        saved = next(f for f in workspace.files(self.project) if f['path'] == 'desktop-pet/sandbox-result.md')
        self.assertEqual(saved['content'], 'isolated experiment')
        self.assertFalse((workspace.REPO/'features/desktop-pet/sandbox-result.md').exists())

    async def test_output_flood_is_terminated(self):
        with self.assertRaises(HTTPException) as error:
            await self.run_code('print("x" * 70000, flush=True)')
        self.assertIn('64 KB', error.exception.detail)
        self.assert_finished()

    async def test_timeout_is_terminated(self):
        started = time.monotonic()
        try:
            result = await self.run_code('import time; time.sleep(60)')
            self.assertEqual(result['exit_code'], 124, result['output'])
        except HTTPException as exc:
            # Slow Docker startup can let the host deadline win over the inner
            # timeout. Both must stop the program and clean the container.
            self.assertEqual(exc.status_code, 409)
            self.assertIn('超过期限', exc.detail)
        self.assertLess(time.monotonic()-started, 45)
        self.assert_finished()

    async def test_revocation_terminates_in_flight_container(self):
        task = asyncio.create_task(self.run_code('import time; time.sleep(60)'))
        try:
            for _ in range(100):
                with db._tx() as c:
                    workspace.initialize(c)
                    found = c.execute("SELECT 1 FROM exploration_workspace_jobs WHERE state='running'").fetchone()
                if found:
                    break
                await asyncio.sleep(0.1)
            self.assertTrue(found, 'execution never started')
            await asyncio.sleep(2)
            projects.pause(self.project)
            with self.assertRaises(HTTPException):
                await asyncio.wait_for(task, 12)
            self.assert_finished()
        finally:
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

    def assert_finished(self):
        with db._tx() as c:
            self.assertIsNone(c.execute("SELECT 1 FROM exploration_workspace_jobs WHERE state='running'").fetchone())


if __name__ == '__main__':
    unittest.main()
