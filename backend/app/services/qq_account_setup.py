"""Local, explicit account connection setup; only read-only OneBot actions."""
import asyncio
import copy
import json
from pathlib import Path
import socket
import threading
import uuid
from urllib.parse import urlsplit

from .snowluma import SnowLumaClient, SnowLumaError, logged_in

_lock = threading.Lock()


async def login_identity(connection):
    """Read the local gateway identity without changing its configuration."""
    from websockets.asyncio.client import connect
    url = str(connection.get('ws_url') or '')
    parsed = urlsplit(url)
    if parsed.scheme not in ('ws', 'wss') or parsed.hostname not in ('127.0.0.1', 'localhost', '::1') or parsed.username or parsed.password:
        raise SnowLumaError('自动读取昵称仅支持本机网关')
    token = str(connection.get('access_token') or '')
    headers = {'Authorization': 'Bearer ' + token} if token else {}
    async with asyncio.timeout(4):
        async with connect(url, additional_headers=headers, open_timeout=2, close_timeout=1, max_size=1024 * 1024) as ws:
            echo = uuid.uuid4().hex
            await ws.send(json.dumps({'action': 'get_login_info', 'params': {}, 'echo': echo}))
            for _ in range(100):
                reply = json.loads(await ws.recv())
                if reply.get('echo') != echo:
                    continue
                identity = reply.get('data') or {}
                if reply.get('retcode') != 0 or not identity.get('user_id'):
                    raise SnowLumaError('网关未返回账号身份')
                expected = str(connection.get('self_id') or '')
                if expected and str(identity['user_id']) != expected:
                    raise SnowLumaError('网关连接到了其他 QQ 号')
                return {'self_id': str(identity['user_id']), 'nickname': str(identity.get('nickname') or '')}
    raise SnowLumaError('未能读取网关身份')


async def choices():
    """Use the bridge's enabled-row order, never the settings table row index."""
    from ..routers.nest import _setting
    def read():
        from .. import expert_mode
        if not expert_mode.enabled():
            from ..routers.nest import _settings_payload
            return _settings_payload('qq_bridge')['values']['accounts']
        rows = [r for r in (_setting('qq_bridge', 'accounts', []) or []) if isinstance(r, dict) and r.get('enabled', True)]
        if not rows:
            rows = [{'self_id': _setting('qq_bridge', 'onebot.self_id', ''), 'name': '默认账号'}]
        default_url = _setting('qq_bridge', 'onebot.ws_url', 'ws://127.0.0.1:3001/')
        default_token = _setting('qq_bridge', 'onebot.access_token', '')
        return [{**r, 'ws_url': r.get('ws_url') or default_url,
                 'access_token': default_token if r.get('access_token') is None else r['access_token']} for r in rows]
    rows = await asyncio.to_thread(read)
    semaphore = asyncio.Semaphore(4)
    async def describe(index, row):
        result = {'index': index, 'self_id': str(row.get('self_id') or ''),
                  'name': str(row.get('name') or ''), 'nickname': '', 'status': 'unavailable'}
        async with semaphore:
            try:
                result.update(await login_identity(row))
                result['status'] = 'connected'
            except Exception:
                pass  # Offline accounts remain selectable; never return tokens or raw errors.
        return result
    return await asyncio.gather(*(describe(i, row) for i, row in enumerate(rows)))


def client():
    from ..routers.nest import _setting
    password = str(_setting('qq_bridge', 'gateway.password', ''))
    if not password:
        raise SnowLumaError('请先填写并保存网关网页密码，再读取账号')
    return SnowLumaClient(password, int(_setting('qq_bridge', 'gateway.webui_port', 5099)))


def accounts():
    with client() as gateway:
        return [{'id': uin, 'name': uin} for uin in logged_in(gateway)]


def allocate(used):
    for port in range(3100, 4000):
        if port in used:
            continue
        with socket.socket() as probe:
            try:
                probe.bind(('127.0.0.1', port))
            except OSError:
                continue
        used.add(port)
        return port
    raise SnowLumaError('没有可用端口，请手动配置')


def prepare(uin):
    from ..routers.nest import _gateway_spec
    with _lock, client() as gateway:
        if uin not in logged_in(gateway):
            raise SnowLumaError('请先在 QQ 中登录这个账号并启动网关')
        config = copy.deepcopy(gateway.config(uin))
        used = set()
        folder = Path(_gateway_spec('qq_bridge')['folder']) / 'config'
        for path in folder.glob('onebot_*.json'):
            if path.stem == f'onebot_{uin}':
                continue
            try:
                other = json.loads(path.read_text(encoding='utf-8-sig'))
                for kind in ('wsServers', 'httpServers'):
                    used.update(int(s['port']) for s in other.get('networks', {}).get(kind, []))
            except (ValueError, KeyError, TypeError, OSError):
                raise SnowLumaError('其他账号的端口配置无法读取，请先检查网关配置') from None
        networks = config.setdefault('networks', {})
        servers = networks.get('wsServers') or []
        if not servers:
            raise SnowLumaError('此账号尚无正向 WebSocket 服务，请先在网关中开启')
        changed = False
        for kind in ('httpServers', 'wsServers'):
            for server in networks.get(kind, []):
                port = int(server.get('port') or 0)
                if not port or port in used:
                    server['port'] = allocate(used)
                    changed = True
                else:
                    used.add(port)
        server = servers[0]
        if server.get('host') not in ('127.0.0.1', 'localhost', '0.0.0.0', '::', ''):
            raise SnowLumaError('自动配置只支持本机网关')
        if changed:
            gateway.save_config(uin, config)
        path = str(server.get('path') or '/')
        if not path.startswith('/'):
            path = '/' + path
        return {'self_id': uin, 'ws_url': f"ws://127.0.0.1:{int(server['port'])}{path}",
                'access_token': str(server.get('accessToken') or ''),
                'listen_port': allocate(used)}


async def contacts(connection):
    from websockets.asyncio.client import connect
    headers = {'Authorization': 'Bearer ' + connection['access_token']} if connection['access_token'] else {}
    async with asyncio.timeout(18):
        async with connect(connection['ws_url'], additional_headers=headers, open_timeout=5, max_size=4 * 1024 * 1024) as ws:
            async def call(action):
                echo = uuid.uuid4().hex
                await ws.send(json.dumps({'action': action, 'params': {}, 'echo': echo}))
                for _ in range(500):
                    reply = json.loads(await ws.recv())
                    if reply.get('echo') == echo:
                        if reply.get('retcode') != 0:
                            raise SnowLumaError('网关读取名单失败，请稍后重试')
                        return reply.get('data')
                raise SnowLumaError('网关事件过多，请稍后重试')
            identity = await call('get_login_info')
            if str((identity or {}).get('user_id')) != connection['self_id']:
                raise SnowLumaError('网关端口连接到了其他 QQ 号，未读取名单')
            groups = await call('get_group_list')
            friends = await call('get_friend_list')
            return {
                'groups': [{'id': str(g['group_id']), 'name': str(g.get('group_name') or g['group_id'])} for g in groups or []],
                'private': [{'id': str(f['user_id']), 'name': str(f.get('remark') or f.get('nickname') or f['user_id'])} for f in friends or []],
            }
