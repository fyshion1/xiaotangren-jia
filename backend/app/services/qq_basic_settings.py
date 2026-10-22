"""Basic QQ policy: preserve expert configuration, constrain the effective runtime."""
import copy
import json
from urllib.parse import urlsplit

from fastapi import HTTPException
from .. import db, expert_mode

SELECTION_KEY = 'qq_basic_account_v1'
BASIC_KEYS = {'accounts', 'owner.qq', 'persona.character_id', 'onebot.self_id',
              'allow.groups', 'allow.private', 'allow.require_mention_in_group',
              'gateway.folder', 'gateway.webui_port', 'gateway.password',
              'onebot.ws_url', 'onebot.access_token', 'voice.enabled', 'voice.auto',
              'voice.engine', 'voice.voice', 'asr.engine', 'asr.fallback',
              'sticker.enabled', 'sticker.library'}
ROW_KEYS = {'name', 'self_id', 'persona', 'ws_url', 'access_token', 'listen_port',
            'groups', 'private', 'enabled'}
FIXED = {'onebot.mode': 'client', 'tools.enabled': False, 'tools.allow': [],
         'proactive.enabled': False, 'proactive.qzone': False, 'proactive.group_id': '',
         'owner.admin_commands': False, 'allow.ignore_bots': True,
         'events.notice': False,
         'modes.dm': 'chat', 'modes.group': 'chat',
         'reply.debounce_seconds': 2, 'reply.max_wait_seconds': 10,
         'reply.max_bubbles': 4, 'reply.interval_seconds': 1.2,
         'voice.max_chars': 80, 'voice.max_per_minute': 3}


def saved():
    return (db.get_feature_settings('qq_bridge') or {}).get('data') or {}


def choices(data=None):
    data = saved() if data is None else data
    rows = [r for r in data.get('accounts', []) if isinstance(r, dict) and r.get('self_id')]
    return [{'self_id': str(r['self_id']), 'name': str(r.get('name') or r['self_id'])} for r in rows]


def selected_id():
    try:
        return str(json.loads(db.get_settings().get(SELECTION_KEY, '{}')).get('self_id') or '')
    except (ValueError, AttributeError):
        return ''


def choose(self_id, data=None):
    if self_id not in {r['self_id'] for r in choices(data)}:
        raise HTTPException(400, '请选择已有配置中的一个 QQ 账号')
    db.set_settings({SELECTION_KEY: json.dumps({'self_id': self_id})})


def local_ws(value):
    try:
        u = urlsplit(str(value))
        return (u.scheme in ('ws', 'wss') and u.hostname in ('127.0.0.1', 'localhost', '::1')
                and not u.username and not u.password and not u.query and not u.fragment and bool(u.port))
    except ValueError:
        return False


def effective(values):
    out = copy.deepcopy(values)
    rows = [r for r in out.get('accounts', []) if isinstance(r, dict)]
    selected = selected_id()
    match = next((r for r in rows if str(r.get('self_id') or '') == selected), None)
    needs_selection = len(rows) > 1 and match is None
    row = match or (rows[0] if len(rows) == 1 else None)
    if not row:
        row = {'self_id': out.get('onebot.self_id', ''), 'persona': out.get('persona.character_id', ''),
               'ws_url': out.get('onebot.ws_url', 'ws://127.0.0.1:3001/'),
               'access_token': out.get('onebot.access_token', ''),
               'groups': out.get('allow.groups') or [], 'private': out.get('allow.private') or []}
    row = {k: v for k, v in row.items() if k in ROW_KEYS}
    row['enabled'] = True
    # Do not let stale global expert contact lists expand this account's scope.
    row['groups'] = row.get('groups') or []
    row['private'] = row.get('private') or []
    if not local_ws(row.get('ws_url') or out.get('onebot.ws_url', 'ws://127.0.0.1:3001/')):
        needs_selection = True
    out.update(FIXED)
    out['accounts'] = [row]
    for field, key in [('self_id', 'onebot.self_id'), ('ws_url', 'onebot.ws_url'),
                       ('access_token', 'onebot.access_token'), ('persona', 'persona.character_id'),
                       ('groups', 'allow.groups'), ('private', 'allow.private')]:
        if field in row and row[field] is not None:
            out[key] = row[field]
    out['bridge.basic_mode'] = True
    out['bridge.selection_required'] = needs_selection
    if out.get('asr.engine') not in ('qq', 'local', 'none'):
        out['asr.engine'] = 'qq'
    if out.get('asr.fallback') not in ('local', 'none'):
        out['asr.fallback'] = 'local'
    if out.get('voice.auto') not in ('off', 'mirror'):
        out['voice.auto'] = 'mirror'
    if out.get('voice.engine') not in ('edge', 'piper'):
        out['voice.engine'] = 'edge'
    if out.get('voice.voice') not in ('zh-CN-XiaoxiaoNeural', 'huayan', 'xiaoya', 'chaowen'):
        out['voice.voice'] = 'huayan' if out.get('voice.engine') == 'piper' else 'zh-CN-XiaoxiaoNeural'
    return out


def merge(submitted):
    data = copy.deepcopy(saved())
    unknown = set(submitted) - BASIC_KEYS
    if unknown:
        raise HTTPException(403, '非专家模式不允许修改高级 QQ 设置：' + '、'.join(sorted(unknown)))
    for key in ('onebot.ws_url',):
        if key in submitted and not local_ws(submitted[key]):
            raise HTTPException(400, '非专家模式仅支持本机正向 WebSocket，请使用自动配置')
    for key in ('asr.engine', 'asr.fallback'):
        if key in submitted and submitted[key] not in (('qq', 'local', 'none') if key.endswith('engine') else ('local', 'none')):
            raise HTTPException(403, '非专家模式仅支持 QQ 或本地语音识别')
    if 'voice.auto' in submitted and submitted['voice.auto'] not in ('off', 'mirror'):
        raise HTTPException(403, '非专家模式仅支持文字或跟随语音回复')
    if 'voice.engine' in submitted and submitted['voice.engine'] not in ('edge', 'piper'):
        raise HTTPException(403, '请选择预设语音引擎')
    if 'voice.voice' in submitted and submitted['voice.voice'] not in ('zh-CN-XiaoxiaoNeural', 'huayan', 'xiaoya', 'chaowen'):
        raise HTTPException(400, '请选择预设音色')
    patch = dict(submitted)
    if 'accounts' in patch:
        rows = patch.pop('accounts')
        if not isinstance(rows, list) or len(rows) != 1:
            raise HTTPException(400, '非专家模式只能绑定一个 QQ 账号')
        row = rows[0]
        if not isinstance(row, dict) or set(row) - ROW_KEYS:
            raise HTTPException(400, 'QQ 账号设置无效')
        if not str(row.get('self_id') or '').isdigit():
            raise HTTPException(400, '请先选择机器人 QQ 账号')
        if not local_ws(row.get('ws_url') or data.get('onebot.ws_url', 'ws://127.0.0.1:3001/')):
            raise HTTPException(400, '非专家模式仅支持本机网关')
        old = list(data.get('accounts') or [])
        selected = selected_id()
        index = next((i for i, r in enumerate(old) if str(r.get('self_id') or '') == str(row['self_id'])), None)
        # Rebinding replaces only the basic account. Archived expert accounts stay intact.
        if index is None:
            index = next((i for i, r in enumerate(old) if str(r.get('self_id') or '') == selected), None)
        new_row = {**row, 'enabled': True}
        if index is None:
            old.append(new_row)
        else:
            old[index] = {**old[index], **new_row}
        data['accounts'] = old
        db.set_settings({SELECTION_KEY: json.dumps({'self_id': str(row['self_id'])})})
    data.update(patch)
    return data


def require_ready():
    if not expert_mode.enabled() and effective(saved()).get('bridge.selection_required'):
        raise HTTPException(409, '请先在 QQ 桥设置中选择一个账号并完成本机连接配置')
