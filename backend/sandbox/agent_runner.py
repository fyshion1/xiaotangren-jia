"""Untrusted container side only. Host never runs its tool commands."""
import hashlib
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import threading

payload = json.loads(sys.stdin.readline())
os.chdir('/work')
if Path('/reference/desktop-pet').is_dir():
    shutil.copytree('/reference/desktop-pet', '/work/desktop-pet')
    subprocess.run(['git', 'init', '-b', 'sandbox-experiment', '/work/desktop-pet'], check=True, stdout=subprocess.DEVNULL)
    subprocess.run(['git', '-C', '/work/desktop-pet', 'add', '.'], check=True)
    subprocess.run(['git', '-C', '/work/desktop-pet', '-c', 'user.name=Sandbox', '-c', 'user.email=sandbox@localhost',
                    'commit', '--allow-empty', '-m', 'Read-only source snapshot'], check=True, stdout=subprocess.DEVNULL)
for name, content in payload['files'].items():
    target = Path(name)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding='utf-8')


def candidates():
    for current, dirs, names in os.walk('/work', followlinks=False):
        dirs[:] = sorted(d for d in dirs if not d.startswith('.') and not Path(current, d).is_symlink())
        for name in sorted(names):
            path = Path(current, name)
            if not name.startswith('.') and not path.is_symlink() and path.is_file() and path.stat().st_size <= 32000:
                yield path


baseline = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in candidates()}


class Relay(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if self.path != '/v1/responses' or not 0 < size <= 192000 or self.headers.get('Content-Encoding'):
                raise ValueError('Only bounded uncompressed Responses requests supported')
            body = json.loads(self.rfile.read(size))
            print('XTR_MODEL:' + json.dumps(body, ensure_ascii=False), flush=True)
            reply = json.loads(sys.stdin.readline())
            if 'error' in reply:
                self.send_response(403)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({'error': {'message': reply['error'], 'type': 'budget_or_policy'}}).encode())
                return
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Connection', 'close')
            self.end_headers()
            for seq, event in enumerate(reply['events']):
                event['sequence_number'] = seq
                self.wfile.write(('event: '+event['type']+'\ndata: '+json.dumps(event, ensure_ascii=False)+'\n\n').encode())
            self.wfile.flush()
        except (ValueError, OSError):
            self.send_error(400, 'Unsupported or closed relay')


server = HTTPServer(('127.0.0.1', 8765), Relay)
server.timeout = 2
threading.Thread(target=server.serve_forever, daemon=True).start()
home = Path('/work/.codex')
home.mkdir(exist_ok=True)
(home/'config.toml').write_text('''model = "sandbox-model"
model_provider = "sandbox"
approval_policy = "never"
sandbox_mode = "danger-full-access"
web_search = "disabled"
model_auto_compact_token_limit = 1000000
[features]
shell_snapshot = false
multi_agent = false
goals = false
remote_plugin = false
plugins = false
responses_websockets = false
responses_websockets_v2 = false
enable_request_compression = false
[model_providers.sandbox]
name = "Metered sandbox relay"
base_url = "http://127.0.0.1:8765/v1"
wire_api = "responses"
requires_openai_auth = false
request_max_retries = 0
stream_max_retries = 0
supports_websockets = false
''', encoding='utf-8')
env = {**os.environ, 'CODEX_HOME': str(home), 'TOKIO_WORKER_THREADS': '2', 'RAYON_NUM_THREADS': '2'}
prompt = ('You are working inside a disposable offline container. /reference is a read-only sanitized source snapshot. '
          'Only edit /work; desktop-pet is an isolated Git experiment with no remotes. No deployment, messaging, '
          'external networking, credentials, installing dependencies or spawning other agents. All model calls share '
          'a strictly approved token budget. Finish in a few calls; save useful results as small UTF-8 files.\nTask:\n' + payload['task'])
try:
    result = subprocess.run(['codex', 'exec', '--ephemeral', '--skip-git-repo-check', '--json', prompt],
                            stdin=subprocess.DEVNULL, env=env, timeout=55)
    code = result.returncode
except subprocess.TimeoutExpired:
    print('[agent timeout]', flush=True)
    code = 124
exports = {}
for path in candidates():
    data = path.read_bytes()
    if baseline.get(str(path)) == hashlib.sha256(data).hexdigest():
        continue
    try:
        content = data.decode('utf-8')
    except UnicodeError:
        continue
    candidate = {**exports, path.relative_to('/work').as_posix(): content}
    if len(candidate) <= 30 and len(json.dumps(candidate, ensure_ascii=False).encode()) <= 24000:
        exports = candidate
print('XTR_EXPORT:' + json.dumps(exports, ensure_ascii=False), flush=True)
sys.exit(code)
