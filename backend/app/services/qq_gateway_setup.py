"""Explicit local dashboard onboarding. Never exposed as a model tool."""
import json
import os
import platform
import re
import shutil
import tempfile
import threading
import urllib.request
import zipfile
from pathlib import Path

from .snowluma import SnowLumaError

RELEASES = 'https://github.com/SnowLuma/SnowLuma/releases'
_lock = threading.Lock()


def folder():
    from ..routers.nest import _gateway_spec
    return Path(_gateway_spec('qq_bridge')['folder'])


def qq_versions():
    """Read running QQ's adjacent manifest; unknown is not evidence of old QQ."""
    import psutil
    result = set()
    for proc in psutil.process_iter(['name', 'exe']):
        if str(proc.info.get('name') or '').lower() != 'qq.exe':
            continue
        try:
            root = Path(proc.info['exe']).parent
            for p in [root / 'resources/app/package.json', root / 'resources/app/app_launcher/qq_package.json']:
                if p.is_file():
                    value = str(json.loads(p.read_text(encoding='utf-8-sig')).get('version') or '')
                    if re.fullmatch(r'\d+(?:\.\d+){2,4}(?:-\d+)?', value):
                        result.add(value)
        except (OSError, ValueError, TypeError):
            pass
    return sorted(result)


def diagnostics():
    from ..routers.nest import _port_listening, _setting
    target = folder()
    installed = (target / 'node.exe').is_file() and (target / 'index.mjs').is_file()
    versions = qq_versions() if os.name == 'nt' else []
    old = [v for v in versions if tuple(map(int, re.findall(r'\d+', v)[:3])) < (9, 9, 33)]
    return {'installed': installed, 'folder': str(target), 'versions': versions,
            'old_qq': bool(old), 'webui_online': _port_listening(int(_setting('qq_bridge', 'gateway.webui_port', 5099))),
            'releases_url': RELEASES, 'install_supported': os.name == 'nt' and platform.machine().lower() in ('amd64', 'x86_64'),
            'message': '检测到较旧 QQ，请按所选 SnowLuma 发行说明升级匹配版本；升级后重启 QQ 和网关。' if old else
            'QQ 版本需与 SnowLuma 发行说明匹配；未检测到版本不代表兼容。若一直 connecting，请检查 QQ 登录、加载状态和网关日志。',
            'password_hint': '首次登录密码请在 SnowLuma 启动日志中查看；不同发行版可能不同。登录后按网关提示修改，再将新密码填入下方「网关网页密码」。'}


def initial_password_notice():
    from ..routers.nest import _log_path, _tail
    # Explicit local reveal only; never include this in poll responses or tool receipts.
    text = _tail(_log_path('qq_bridge-gateway'), 1000)
    lines = [line for line in text.splitlines() if re.search(r'初始密码|initial password|default password|默认密码', line, re.I)]
    return {'notice': '\n'.join(lines[-4:]) or '未在小窝启动日志中找到初始密码。请查看 SnowLuma 自己的启动窗口；若已经改过，请使用你修改后的密码。'}


def fetch_json(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'xiaotangren-qq-setup', 'Accept': 'application/vnd.github+json'})
    with urllib.request.urlopen(req, timeout=15) as response:
        return json.load(response)


def release():
    data = fetch_json('https://api.github.com/repos/SnowLuma/SnowLuma/releases/latest')
    assets = [a for a in data.get('assets', []) if re.search(r'win(?:dows)?[-_]x64', a.get('name', ''), re.I)
              and a['name'].endswith('.zip') and 'lite' not in a['name'].lower()]
    if len(assets) != 1:
        raise SnowLumaError('未找到唯一的 Windows x64 完整版，请从官方 Releases 手动安装后填写安装目录。')
    asset = assets[0]
    url = asset['browser_download_url']
    if not url.startswith(RELEASES + '/download/') or not 0 < int(asset.get('size', 0)) <= 600 * 1024 * 1024:
        raise SnowLumaError('发行包地址或大小不符合安装要求')
    return {'version': data['tag_name'], 'name': asset['name'], 'url': url, 'size': asset['size'],
            'notes': str(data.get('body') or '')[:16000]}


def unpack(archive, destination):
    with zipfile.ZipFile(archive) as z:
        if sum(i.file_size for i in z.infolist()) > 1500 * 1024 * 1024:
            raise SnowLumaError('解压体积超出限制')
        for item in z.infolist():
            p = Path(item.filename.replace('\\', '/'))
            if p.is_absolute() or '..' in p.parts or ':' in item.filename or (item.external_attr >> 16) & 0o170000 == 0o120000:
                raise SnowLumaError('发行包包含不安全路径')
        z.extractall(destination)


def install(version):
    if os.name != 'nt' or platform.machine().lower() not in ('amd64', 'x86_64'):
        raise SnowLumaError('自动安装目前仅支持 Windows x64，请使用官方发行包')
    with _lock:
        info = release()
        if info['version'] != version:
            raise SnowLumaError('发行版本已变更，请重新检查并确认安装')
        from .. import db
        target = db.DATA_DIR / 'gateways' / 'SnowLuma'
        if target.exists():
            raise SnowLumaError('托管安装目录已存在，不覆盖已有网关；请检查设置中的目录')
        target.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=target.parent) as temp:
            temp = Path(temp)
            req = urllib.request.Request(info['url'], headers={'User-Agent': 'xiaotangren-qq-setup'})
            archive = temp / 'release.zip'
            with urllib.request.urlopen(req, timeout=30) as response, archive.open('wb') as out:
                count = 0
                while chunk := response.read(1024 * 1024):
                    count += len(chunk)
                    if count > info['size']:
                        raise SnowLumaError('下载体积与发行信息不一致')
                    out.write(chunk)
            if count != info['size']:
                raise SnowLumaError('下载不完整，请重试')
            unpack(archive, temp / 'unpacked')
            candidates = [p.parent for p in (temp / 'unpacked').rglob('index.mjs') if (p.parent / 'node.exe').is_file()]
            if len(candidates) != 1:
                raise SnowLumaError('发行包缺少完整网关运行文件')
            shutil.move(str(candidates[0]), str(target))
        saved = (db.get_feature_settings('qq_bridge') or {}).get('data') or {}
        db.set_feature_settings('qq_bridge', {**saved, 'gateway.folder': str(target)})
        return {'installed': True, 'folder': str(target), 'version': info['version'],
                'message': '安装完成，尚未启动。请点开 QQ 网关，前往网关网页完成协议、登录及密码设置。'}
