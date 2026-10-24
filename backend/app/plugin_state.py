"""Persist host controls independently of plugin code and user databases."""
import json
import os
import tempfile
from pathlib import Path

from .data_paths import runtime_root

STATE_PATH = runtime_root() / 'plugin-state.json'


def read():
    try:
        return json.loads(STATE_PATH.read_text(encoding='utf-8'))
    except FileNotFoundError:
        return {}


def enabled(feature_id):
    return not read().get(feature_id, {}).get('disabled', False)


def visible(feature_id):
    return not read().get(feature_id, {}).get('hidden', False)


def update(feature_id, **values):
    update_many({feature_id: values})


def update_many(changes):
    state = read()
    for feature_id, values in changes.items():
        state.setdefault(feature_id, {}).update(values)
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    fd, filename = tempfile.mkstemp(dir=STATE_PATH.parent, suffix='.tmp')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(state, stream, ensure_ascii=False, indent=2)
        os.replace(filename, STATE_PATH)
    finally:
        Path(filename).unlink(missing_ok=True)


class PluginGuard:
    """Keep already-mounted endpoints closed when a plugin is disabled."""
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope['type'] in ('http', 'websocket'):
            path = scope.get('path', '')
            feature_id = None
            prefixes = {'/api/project-costs': 'project_costs', '/api/qq-bridge': 'qq_bridge',
                        '/api/exploration-projects': 'autonomous_activity',
                        '/api/plugins/autonomous_activity/ui': 'autonomous_activity',
                        '/api/imports/tavern-card': 'tavern', '/api/gemini-sync': 'gemini_sync'}
            for prefix, identifier in prefixes.items():
                if path == prefix or path.startswith(prefix + '/'):
                    feature_id = identifier
                    break
            if path.startswith('/api/nest/features/'):
                feature_id = path.split('/')[4]
            if feature_id and not enabled(feature_id):
                if scope['type'] == 'websocket':
                    await send({'type': 'websocket.close', 'code': 1008})
                else:
                    from starlette.responses import JSONResponse
                    await JSONResponse({'detail': '插件已关闭，请在插件管理中启用'}, status_code=409)(scope, receive, send)
                return
        await self.app(scope, receive, send)
