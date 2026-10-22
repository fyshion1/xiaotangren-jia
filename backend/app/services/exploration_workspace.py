"""Disposable Linux containers; never run project code on the host.

Persistent files are bounded SQLite text blobs, not caller-controlled host paths.
Docker receives only an allowlisted source snapshot mounted read-only. No engine
socket, host service, credentials, or writable host mount enters the container.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import tempfile
import time
import uuid

from fastapi import HTTPException

from .. import db
from . import exploration_projects as projects

IMAGE = 'xiaotangren-sandbox:local'
REPO = Path(__file__).resolve().parents[3]
MAX_FILE = 32000
MAX_TOTAL = 256000
MAX_FILES = 30
_running: dict[str, tuple[str, str]] = {}


def docker_executable():
    for candidate in (Path('D:/other software/Docker/app/resources/bin/docker.exe'),
                      Path('C:/Program Files/Docker/Docker/resources/bin/docker.exe')):
        if candidate.is_file():
            return str(candidate)
    return shutil.which('docker')


def snapshot_base():
    # Source copies include .py: putting them under backend/data makes uvicorn
    # --reload restart the app on every read, cancelling the next metered call.
    parent = Path(tempfile.gettempdir()) / 'xiaotangren-source-snapshots'
    scope = hashlib.sha256(str(db.DATA_DIR.resolve()).encode()).hexdigest()[:32]
    base = parent / scope
    for folder in (parent, base):
        if folder.is_symlink() or getattr(folder, 'is_junction', lambda: False)():
            raise ValueError('Snapshot cache cannot use filesystem links')
    base.mkdir(parents=True, exist_ok=True)
    return base.resolve()


def remove_snapshot(root):
    # Resolve and verify the exact deletion target before every recursive removal.
    base = snapshot_base()
    resolved = Path(root).resolve()
    if resolved.parent != base or not re.fullmatch(r'[0-9a-f]{32}', resolved.name) or Path(root).is_symlink():
        raise ValueError('Invalid snapshot cleanup target')
    shutil.rmtree(resolved, ignore_errors=True)


def initialize(c):
    projects.initialize(c)
    c.execute('''CREATE TABLE IF NOT EXISTS exploration_workspace_files (
        project_id TEXT NOT NULL, path TEXT NOT NULL, content TEXT NOT NULL,
        updated REAL NOT NULL, PRIMARY KEY(project_id,path))''')
    c.execute('''CREATE TABLE IF NOT EXISTS exploration_workspace_jobs (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, project_id TEXT NOT NULL,
        state TEXT NOT NULL, created REAL NOT NULL)''')


def safe_path(value, *, directory=False):
    if not isinstance(value, str) or len(value) > 160 or not re.fullmatch(r'[a-zA-Z0-9_./-]+', value):
        raise HTTPException(422, '工作区相对路径无效')
    parts = value.split('/')
    if any(x in ('', '.', '..') or x.startswith('.') for x in parts) or PurePosixPath(value).is_absolute():
        raise HTTPException(422, '不允许隐藏文件、绝对路径或目录穿越')
    if not directory and PurePosixPath(value).suffix not in ('.py', '.md', '.txt', '.html', '.css', '.js', '.cjs', '.mjs', '.ts', '.tsx', '.json'):
        raise HTTPException(422, '不支持的工作区文件类型')
    return value


def write(run_id, path, content):
    grant = projects.check_run(run_id)
    path = safe_path(path)
    if not isinstance(content, str) or len(content.encode('utf-8')) > MAX_FILE:
        raise HTTPException(422, '单文件最多 32 KB')
    with db._tx() as c:
        initialize(c)
        c.execute('BEGIN IMMEDIATE')
        from . import exploration_budget as budget
        if not budget.active_in(c, run_id) or not projects.valid(projects.grant_for_run(c, run_id)):
            raise HTTPException(409, '授权已失效')
        files = {r['path']: r['content'] for r in c.execute('SELECT * FROM exploration_workspace_files WHERE project_id=?', (grant['project_id'],))}
        files[path] = content
        if len(files) > MAX_FILES or sum(len(v.encode('utf-8')) for v in files.values()) > MAX_TOTAL:
            raise HTTPException(409, '项目文件容量或数量已达上限')
        c.execute('INSERT OR REPLACE INTO exploration_workspace_files VALUES(?,?,?,?)', (grant['project_id'], path, content, time.time()))
        projects.event(c, grant['project_id'], 'file_written', {'path': path, 'bytes': len(content.encode('utf-8'))})
    return path


def files(project_id):
    with db._tx() as c:
        initialize(c)
        return [dict(r) for r in c.execute('SELECT * FROM exploration_workspace_files WHERE project_id=? ORDER BY path', (project_id,))]


def capability():
    docker = docker_executable()
    if not docker:
        return {'available': False, 'reason': '未安装 Docker；禁止回退到宿主执行', 'agent_available': False}
    try:
        result = subprocess.run([docker, 'image', 'inspect', IMAGE, '--format', '{{.Id}}'],
                                capture_output=True, timeout=4, text=True,
                                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        image_id = result.stdout.strip()
        if result.returncode or not re.fullmatch(r'sha256:[0-9a-f]{64}', image_id):
            raise ValueError('missing image')
        info = subprocess.run([docker, 'info', '--format', '{{.OSType}}'], capture_output=True, timeout=4, text=True,
                              creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        if info.returncode or info.stdout.strip() != 'linux':
            raise ValueError('Linux containers required')
        from .exploration_agent import IMAGE as agent_image
        agent = subprocess.run([docker, 'image', 'inspect', agent_image, '--format', '{{.Id}}'],
                               capture_output=True, timeout=4, text=True,
                               creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        agent_id = agent.stdout.strip()
        ready = agent.returncode == 0 and bool(re.fullmatch(r'sha256:[0-9a-f]{64}', agent_id))
        return {'available': True, 'reason': '本地 Linux 容器镜像就绪；网络关闭', 'image_id': image_id,
                'agent_available': ready, 'agent_image_id': agent_id if ready else None}
    except (OSError, subprocess.SubprocessError, ValueError):
        return {'available': False, 'reason': 'Docker Linux 引擎或本地沙盒镜像未就绪', 'agent_available': False}


def snapshot():
    """Curated source only. No git metadata, symlinks, settings, data, or assets."""
    root = snapshot_base() / uuid.uuid4().hex
    root.mkdir(parents=True)
    count = 0
    total = 0
    roots = [('frontend/src', REPO / 'frontend/src'), ('backend/app', REPO / 'backend/app'),
             ('desktop-pet', REPO / 'features/desktop-pet'), ('docs', REPO / 'docs'),
             ('features/qq-bridge/qqbridge', REPO / 'features/qq-bridge/qqbridge'),
             ('backend/sandbox', REPO / 'backend/sandbox')]
    excluded = {'node_modules', 'data', 'dist', 'build', 'logs', 'assets', 'artifacts', 'outputs', 'config', 'configs', 'tests', '__pycache__'}
    suffixes = {'.py', '.ts', '.tsx', '.js', '.cjs', '.mjs', '.css', '.html', '.md'}
    try:
        for label, source in roots:
            if not source.is_dir() or source.is_symlink() or getattr(source, 'is_junction', lambda: False)():
                continue
            for current, dirs, names in os.walk(source, followlinks=False):
                dirs[:] = sorted(d for d in dirs if not d.startswith('.') and d not in excluded and not (Path(current)/d).is_symlink() and not getattr(Path(current)/d, 'is_junction', lambda: False)())
                for name in sorted(names):
                    file = Path(current)/name
                    if file.is_symlink() or file.suffix not in suffixes or name.startswith('.') or any(x in name.lower() for x in ('secret', 'credential', 'config', 'token', 'seed_', 'private')):
                        continue
                    data = file.read_bytes()
                    if len(data) > 256000 or total+len(data) > 8000000 or count >= 1000:
                        continue
                    text = data.decode('utf-8', errors='replace')
                    if re.search(r'(?:sk-[a-zA-Z0-9_-]{16,}|-----BEGIN .*PRIVATE KEY-----|(?:api_key|password|access_token)\s*[=:]\s*[\"\'][^\"\']{8,}[\"\'])', text):
                        continue
                    target = root / label / file.relative_to(source)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(data)
                    total += len(data)
                    count += 1
        return root
    except BaseException:
        remove_snapshot(root)
        raise


# Fixed bootstrap, not a host command. Agent code is executed only inside Docker.
BOOTSTRAP = r'''
import hashlib, json, os, pathlib, shutil, subprocess, sys
payload = json.load(sys.stdin)
os.chdir('/work')
if pathlib.Path('/reference/desktop-pet').is_dir():
    shutil.copytree('/reference/desktop-pet', '/work/desktop-pet')
    subprocess.run(['git', 'init', '-b', 'sandbox-experiment', '/work/desktop-pet'], check=True, stdout=subprocess.DEVNULL)
    subprocess.run(['git', '-C', '/work/desktop-pet', 'add', '.'], check=True)
    subprocess.run(['git', '-C', '/work/desktop-pet', '-c', 'user.name=Sandbox', '-c', 'user.email=sandbox@localhost', 'commit', '--allow-empty', '-m', 'Read-only source snapshot'], check=True, stdout=subprocess.DEVNULL)
for name, content in payload['files'].items():
    p = pathlib.Path(name)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding='utf-8')
def candidates():
    for current, dirs, names in os.walk('/work', followlinks=False):
        dirs[:] = [d for d in dirs if not d.startswith('.') and not pathlib.Path(current, d).is_symlink()]
        for name in names:
            p = pathlib.Path(current, name)
            if not name.startswith('.') and not p.is_symlink() and p.is_file() and p.stat().st_size <= 32000:
                yield p
baseline = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in candidates()}
try:
    result = subprocess.run([sys.executable, '-I', payload['entry']], stdin=subprocess.DEVNULL, timeout=25)
except subprocess.TimeoutExpired:
    print('[execution timeout]', flush=True)
    sys.exit(124)
print('\n[exit_code=' + str(result.returncode) + ']')
exports = {}
for p in candidates():
    if len(exports) >= 30:
        break
    data = p.read_bytes()
    if baseline.get(str(p)) == hashlib.sha256(data).hexdigest():
        continue
    try:
        content = data.decode('utf-8')
    except UnicodeError:
        continue
    candidate = {**exports, str(p.relative_to('/work')): content}
    if len(json.dumps(candidate, ensure_ascii=False).encode('utf-8')) <= 24000:
        exports = candidate
print('\nXTR_EXPORT:' + json.dumps(exports, ensure_ascii=False), flush=True)
sys.exit(result.returncode)
'''


def command(image_id, name, reference):
    return [docker_executable() or 'docker', 'run', '--rm', '--pull=never', '--name', name, '-i',
            '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
            '--user=65534:65534', '--cpus=0.5', '--memory=256m', '--memory-swap=256m', '--pids-limit=32',
            '--ulimit=nofile=128:128', '--ulimit=core=0', '--log-driver=none',
            '--tmpfs=/work:rw,nosuid,nodev,size=32m,mode=1777',
            '--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=16m,mode=1777',
            '--mount', f'type=bind,source={reference},target=/reference,readonly',
            '--workdir=/work', '--env=HOME=/work', '--env=PYTHONDONTWRITEBYTECODE=1',
            # Docker CLI can inject proxy credentials from its own config unless
            # every proxy variable is explicitly overridden. Pass none through.
            *['--env='+key+'=' for key in ('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'FTP_PROXY',
                                         'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'ftp_proxy')],
            image_id, 'python', '-I', '-c', BOOTSTRAP]


async def execute(run_id, entry, *, agent_cfg=None, agent="codex"):
    if agent != "codex":
        raise HTTPException(422, "当前隔离工作区仅支持 Codex")
    agent_mode = agent_cfg is not None
    permission = 'codex' if agent_mode else 'python'
    grant = projects.check_run(run_id, permission)
    if agent_mode:
        if not isinstance(entry, str) or not 1 <= len(entry.strip()) <= 1600:
            raise HTTPException(422, 'agent 任务应为 1–1600 字')
    else:
        entry = safe_path(entry)
        if not entry.endswith('.py'):
            raise HTTPException(422, '一期仅执行 Python 文件')
    state = await asyncio.to_thread(capability)
    if not state['available']:
        raise HTTPException(409, state['reason'])
    if agent_mode and not state.get('agent_available'):
        raise HTTPException(409, '隔离 Codex 镜像未就绪；禁止使用宿主 CLI')
    content = {r['path']: r['content'] for r in files(grant['project_id'])}
    # Seed every execution with role-owned working instructions. Existing
    # project documents take precedence; personal notes remain independently
    # persistent and are modified only through the personal_docs broker.
    from . import exploration_memory
    for path, text in exploration_memory.bundle(grant['persona'], grant['speaker'], entry).items():
        content.setdefault(path, text)
    if not agent_mode and entry not in content:
        raise HTTPException(404, '入口文件不存在')
    await reap_jobs()
    name = 'xtr-sandbox-' + uuid.uuid4().hex
    with db._tx() as c:
        initialize(c)
        c.execute('BEGIN IMMEDIATE')
        if c.execute("SELECT 1 FROM exploration_workspace_jobs WHERE state='running' LIMIT 1").fetchone():
            raise HTTPException(409, '已有沙盒执行在运行或等待清理')
        c.execute('INSERT INTO exploration_workspace_jobs VALUES(?,?,?,?,?)', (name, run_id, grant['project_id'], 'running', time.time()))
    _running[run_id] = (name, grant['project_id'])
    reference = None
    proc = None
    output = bytearray()
    cleaned = False
    try:
        reference = await asyncio.to_thread(snapshot)
        projects.check_run(run_id, permission)
        argv = command(state['agent_image_id'] if agent_mode else state['image_id'], name, reference)
        if agent_mode:
            # A CPU quota alone does not constrain Rust's hardware thread count.
            # CLI pools need extra threads; Python retains its 32-pid limit.
            argv[argv.index('--pids-limit=32')] = '--pids-limit=64'
            argv = argv[:-5] + ['--cpuset-cpus=0', argv[-5], 'python', '-I', '/opt/xtr-agent.py']
        proc = await asyncio.create_subprocess_exec(*argv,
                                                   stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                                                   stderr=asyncio.subprocess.STDOUT, limit=256000)
        async def exchange():
            proc.stdin.write((json.dumps({'task' if agent_mode else 'entry': entry, 'files': content})+'\n').encode())
            await proc.stdin.drain()
            if not agent_mode:
                proc.stdin.close()
            while True:
                chunk = await proc.stdout.readline() if agent_mode else await proc.stdout.read(4096)
                if not chunk:
                    break
                if agent_mode and chunk.startswith(b'XTR_MODEL:'):
                    from . import exploration_agent
                    if len(chunk) > exploration_agent.MAX_REQUEST + 32:
                        raise HTTPException(409, 'agent 模型请求超过上限')
                    events = await exploration_agent.respond(run_id, json.loads(chunk[len(b'XTR_MODEL:'):]), agent_cfg)
                    proc.stdin.write((json.dumps({'events': events}, ensure_ascii=False)+'\n').encode())
                    await proc.stdin.drain()
                    continue
                output.extend(chunk)
                if len(output) > 64000:
                    raise HTTPException(409, '沙盒输出超出 64 KB，已终止')
            await proc.wait()
        task = asyncio.create_task(exchange())
        try:
            deadline = time.monotonic()+(60 if agent_mode else 30)
            while not task.done():
                await asyncio.wait({task}, timeout=0.25)
                if task.done():
                    break
                projects.check_run(run_id, permission)
                if time.monotonic() > deadline:
                    raise HTTPException(409, '沙盒执行超过期限，已终止')
            await task
        finally:
            if not task.done():
                task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        text = output.decode('utf-8', errors='replace')
        exported = []
        if '\nXTR_EXPORT:' in text:
            text, encoded = text.rsplit('\nXTR_EXPORT:', 1)
            candidate = json.loads(encoded)
            if not isinstance(candidate, dict) or len(candidate) > MAX_FILES:
                raise HTTPException(409, '沙盒导出格式无效')
            for path, content in candidate.items():
                # Export is untrusted data; paths/quotas/permissions rechecked.
                if PurePosixPath(path).suffix not in ('.py', '.md', '.txt', '.html', '.css', '.js', '.ts', '.tsx', '.json'):
                    continue
                exported.append(write(run_id, path, content))
        result = {'entry': 'codex' if agent_mode else entry, 'output': text, 'exit_code': proc.returncode, 'exported': exported}
        record_execution(grant, result)
        return result
    except BaseException as exc:
        record_execution(grant, {'entry': entry, 'exit_code': -1, 'reason': exc.detail if isinstance(exc, HTTPException) else type(exc).__name__})
        raise
    finally:
        # rm -f is scoped to our generated container name; never a host file operation.
        cleaned = await remove_container(name)
        if proc and proc.returncode is None:
            proc.kill()
            await proc.wait()
        if reference:
            await asyncio.to_thread(remove_snapshot, reference)
        _running.pop(run_id, None)
        if cleaned:
            with db._tx() as c:
                c.execute("UPDATE exploration_workspace_jobs SET state='finished' WHERE id=?", (name,))


def record_execution(grant, result):
    with db._tx() as c:
        projects.event(c, grant['project_id'], 'execution', {**result, 'grant_id': grant['id']})
        recent = [json.loads(r[0]) for r in c.execute("SELECT content FROM exploration_project_events WHERE project_id=? AND kind='execution' ORDER BY created DESC LIMIT 3", (grant['project_id'],))]
        if len(recent) == 3 and all(r.get('grant_id') == grant['id'] and r.get('exit_code') != 0 for r in recent):
            c.execute("UPDATE exploration_grants SET state='revoked' WHERE id=?", (grant['id'],))
            projects.event(c, grant['project_id'], 'execution_fuse', {'reason': '连续三次执行失败，撤销本次授权；需要后台重新审批'})


async def remove_container(name):
    if not re.fullmatch(r'xtr-sandbox-[0-9a-f]{32}', name):
        return False
    for _ in range(3):
        process = None
        try:
            process = await asyncio.create_subprocess_exec(docker_executable() or 'docker', 'rm', '-f', name,
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
            _, error = await asyncio.wait_for(process.communicate(), 5)
            if process.returncode == 0 or b'No such container' in error or b'No such object' in error:
                return True
            # Docker --rm may already be removing the container. Verify absence
            # rather than marking it running forever or assuming removal worked.
            process = await asyncio.create_subprocess_exec(docker_executable() or 'docker', 'container', 'inspect', name,
                '--format', '{{.Id}}', stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
            _, error = await asyncio.wait_for(process.communicate(), 5)
            if process.returncode != 0 and (b'No such container' in error or b'No such object' in error):
                return True
        except (OSError, TimeoutError):
            if process and process.returncode is None:
                process.kill()
                await process.wait()
            return False
        await asyncio.sleep(0.1)
    return False


async def reap_jobs():
    """A crashed host cannot silently forget a container and start another."""
    with db._tx() as c:
        initialize(c)
        jobs = [dict(r) for r in c.execute("SELECT * FROM exploration_workspace_jobs WHERE state='running' AND created<?", (time.time()-90,))]
    for job in jobs:
        if not re.fullmatch(r'xtr-sandbox-[0-9a-f]{32}', job['id']):
            continue
        if await remove_container(job['id']):
            with db._tx() as c:
                c.execute("UPDATE exploration_workspace_jobs SET state='recovered' WHERE id=?", (job['id'],))


def discard(project_id):
    projects.pause(project_id)
    with db._tx() as c:
        initialize(c)
        c.execute('DELETE FROM exploration_workspace_files WHERE project_id=?', (project_id,))
        projects.event(c, project_id, 'workspace_discarded', {})


def read_reference(path, offset=0):
    """Same curated snapshot as runtime, even when Docker is not installed."""
    path = safe_path(path)
    root = snapshot()
    try:
        target = root / path
        if not target.is_file():
            raise HTTPException(404, '文件不在只读源码快照中')
        if type(offset) is not int or not 0 <= offset <= 256000:
            raise HTTPException(422, '源码读取偏移无效')
        return target.read_text(encoding='utf-8', errors='replace')[offset:offset+4000]
    finally:
        remove_snapshot(root)


def reference_index(prefix=''):
    if prefix:
        prefix = safe_path(prefix.rstrip('/'), directory=True)
    root = snapshot()
    try:
        directory = root / prefix
        if not directory.is_dir():
            raise HTTPException(404, '源码目录不在只读快照中')
        return [p.relative_to(root).as_posix()+('/' if p.is_dir() else '') for p in sorted(directory.iterdir())][:60]
    finally:
        remove_snapshot(root)
