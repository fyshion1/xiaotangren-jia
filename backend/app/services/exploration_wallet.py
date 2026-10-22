"""Owner-funded model accounts. Keys stay DPAPI-encrypted on the Windows host."""
from __future__ import annotations

import base64
import ctypes
import hashlib
from ctypes import wintypes
import json
import os
import time
from urllib.parse import urlsplit
import uuid

from fastapi import HTTPException

from .. import db


def initialize(c):
    c.execute('''CREATE TABLE IF NOT EXISTS exploration_wallets (
        id TEXT PRIMARY KEY, persona TEXT NOT NULL, speaker TEXT NOT NULL,
        base_url TEXT NOT NULL, model TEXT NOT NULL, secret TEXT NOT NULL,
        token_limit INTEGER NOT NULL, enabled INTEGER NOT NULL, revision INTEGER NOT NULL,
        updated REAL NOT NULL, UNIQUE(persona,speaker))''')
    c.execute('''CREATE TABLE IF NOT EXISTS exploration_wallet_bindings (
        run_id TEXT PRIMARY KEY, wallet_id TEXT NOT NULL, revision INTEGER NOT NULL)''')
    c.execute('''CREATE TABLE IF NOT EXISTS exploration_wallet_operations (
        id TEXT PRIMARY KEY, wallet_id TEXT NOT NULL, fingerprint TEXT NOT NULL)''')
    c.execute('CREATE TABLE IF NOT EXISTS exploration_wallet_spending (wallet_id TEXT PRIMARY KEY, provider_balance INTEGER NOT NULL)')


def crypt(value, decrypt=False):
    if os.name != 'nt':
        raise HTTPException(503, '独立钱包密钥需要 Windows DPAPI；此平台未配置安全密钥存储')
    class Blob(ctypes.Structure):
        _fields_ = [('size', wintypes.DWORD), ('data', ctypes.POINTER(ctypes.c_ubyte))]
    raw = base64.b64decode(value) if decrypt else value.encode('utf-8')
    buffer = (ctypes.c_ubyte * len(raw)).from_buffer_copy(raw)
    incoming, outgoing = Blob(len(raw), buffer), Blob()
    library = ctypes.WinDLL('crypt32', use_last_error=True)
    fn = library.CryptUnprotectData if decrypt else library.CryptProtectData
    fn.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
                   ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    fn.restype = wintypes.BOOL
    if not fn(ctypes.byref(incoming), None, None, None, None, 1, ctypes.byref(outgoing)):
        raise HTTPException(503, '钱包密钥加密或解密失败，已停止，未回退其他密钥')
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    try:
        result = ctypes.string_at(outgoing.data, outgoing.size)
        return result.decode('utf-8') if decrypt else base64.b64encode(result).decode('ascii')
    finally:
        kernel.LocalFree(outgoing.data)


def save(persona, speaker, base_url, model, api_key, add_tokens, enabled, operation_id='', provider_balance=None):
    from . import exploration_budget as budget
    if not db.get_profile(persona) or not db.get_character(speaker):
        raise HTTPException(404, '身份或角色不存在')
    try:
        parsed = urlsplit(base_url)
        port = parsed.port
    except ValueError:
        raise HTTPException(422, '钱包模型入口地址无效')
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password
            or parsed.query or parsed.fragment or port not in (None, 443)):
        raise HTTPException(422, '钱包模型入口须为不含凭据或查询参数的 HTTPS 地址')
    if not isinstance(model, str) or not 1 <= len(model.strip()) <= 120 or type(add_tokens) is not int or not 0 <= add_tokens <= 2000000:
        raise HTTPException(422, '模型名称或追加额度无效')
    encrypted = crypt(api_key) if api_key else None
    fingerprint = hashlib.sha256(json.dumps([persona, speaker, base_url, model, api_key, add_tokens, enabled, provider_balance]).encode()).hexdigest()
    with db._tx() as c:
        initialize(c)
        budget.initialize(c)
        c.execute('BEGIN IMMEDIATE')
        if operation_id:
            receipt = c.execute('SELECT * FROM exploration_wallet_operations WHERE id=?', (operation_id,)).fetchone()
            if receipt:
                if receipt['fingerprint'] != fingerprint:
                    raise HTTPException(409, '钱包操作编号已用于不同内容')
                return receipt['wallet_id']
        old = c.execute('SELECT * FROM exploration_wallets WHERE persona=? AND speaker=?', (persona, speaker)).fetchone()
        old_mode = c.execute('SELECT provider_balance FROM exploration_wallet_spending WHERE wallet_id=?', (old['id'],)).fetchone() if old else None
        mode_changed = provider_balance is not None and bool(provider_balance) != bool(old_mode and old_mode[0])
        secret = encrypted or (old['secret'] if old else '')
        if enabled and not secret:
            raise HTTPException(422, '请先填写独立 API Key')
        revision = old['revision'] if old else 1
        base_url = base_url.rstrip('/')
        if old and (mode_changed or encrypted or old['base_url'] != base_url or old['model'] != model.strip() or bool(old['enabled']) != enabled):
            revision += 1
        ident = old['id'] if old else uuid.uuid4().hex
        total = (old['token_limit'] if old else 0) + add_tokens
        if total > 100000000:
            raise HTTPException(422, '单钱包累计额度最多一亿 token')
        c.execute('INSERT OR REPLACE INTO exploration_wallets VALUES(?,?,?,?,?,?,?,?,?,?)',
                  (ident, persona, speaker, base_url, model.strip(), secret, total, int(enabled), revision, time.time()))
        if provider_balance is not None:
            c.execute('INSERT OR REPLACE INTO exploration_wallet_spending VALUES(?,?)', (ident, int(bool(provider_balance))))
        if operation_id:
            c.execute('INSERT INTO exploration_wallet_operations VALUES(?,?,?)', (operation_id, ident, fingerprint))
    return ident


def charged(c, wallet_id):
    from . import exploration_budget as budget
    return budget._charged(c, 'run_id IN (SELECT run_id FROM exploration_wallet_bindings WHERE wallet_id=?)', (wallet_id,))


def listing():
    from . import exploration_budget as budget
    with db._tx() as c:
        initialize(c)
        budget.initialize(c)
        rows = c.execute('SELECT * FROM exploration_wallets ORDER BY persona,speaker').fetchall()
        modes = {r['wallet_id']: bool(r['provider_balance']) for r in c.execute('SELECT * FROM exploration_wallet_spending')}
        return [{k: r[k] for k in ('id', 'persona', 'speaker', 'base_url', 'model', 'token_limit', 'enabled', 'revision')}
                | {'has_key': bool(r['secret']), 'charged': charged(c, r['id']),
                   'provider_balance': modes.get(r['id'], False),
                   'remaining': max(0, r['token_limit']-charged(c, r['id']))} for r in rows]


def configuration(run_id, fallback):
    from . import exploration_budget as budget, exploration_projects as projects
    with db._tx() as c:
        initialize(c)
        budget.initialize(c)
        c.execute('BEGIN IMMEDIATE')
        run = c.execute('SELECT * FROM exploration_runs WHERE id=?', (run_id,)).fetchone()
        if not run:
            raise HTTPException(409, '活动不存在')
        identity = c.execute("SELECT content FROM exploration_artifacts WHERE run_id=? AND kind='identity'", (run_id,)).fetchone()
        grant = projects.grant_for_run(c, run_id)
        speaker = json.loads(identity[0]).get('speaker') if identity else (grant['speaker'] if grant else None)
        wallet = c.execute('SELECT * FROM exploration_wallets WHERE persona=? AND speaker=?', (run['persona'], speaker)).fetchone()
        if not speaker and c.execute('SELECT 1 FROM exploration_wallets WHERE persona=?', (run['persona'],)).fetchone():
            raise HTTPException(409, '未固定角色，不能选择钱包')
        binding = c.execute('SELECT * FROM exploration_wallet_bindings WHERE run_id=?', (run_id,)).fetchone()
        ident, revision = (wallet['id'], wallet['revision']) if wallet else ('', 0)
        if binding and (binding['wallet_id'] != ident or binding['revision'] != revision):
            raise HTTPException(409, '钱包配置已变化；本轮停止，不切换资金来源')
        if not binding:
            if c.execute('SELECT 1 FROM exploration_calls WHERE run_id=?', (run_id,)).fetchone():
                if wallet:
                    raise HTTPException(409, '进行中的活动不能切换钱包')
            c.execute('INSERT INTO exploration_wallet_bindings VALUES(?,?,?)', (run_id, ident, revision))
        if not wallet:
            if identity and json.loads(identity[0]).get('autonomous'):
                raise HTTPException(409, '沙盒生活必须使用自己的独立钱包，不借用聊天密钥')
            return fallback
        if not wallet['enabled'] or not wallet['secret']:
            raise HTTPException(409, '独立钱包已暂停；不借用聊天或 QQ 模型密钥')
        result = {'base_url': wallet['base_url'], 'model': wallet['model'], 'api_key': crypt(wallet['secret'], decrypt=True)}
    return result


def valid_in(c, run_id, amount=0):
    initialize(c)
    identity = c.execute("SELECT content FROM exploration_artifacts WHERE run_id=? AND kind='identity'", (run_id,)).fetchone()
    if identity and json.loads(identity[0]).get('autonomous'):
        from .exploration_autonomy import settings_in
        if not settings_in(c).get('enabled'):
            return False
        from . import exploration_threads
        exploration_threads.initialize(c)
        run = c.execute('SELECT persona FROM exploration_runs WHERE id=?', (run_id,)).fetchone()
        thread = c.execute('SELECT state,last_run FROM exploration_threads WHERE persona=? AND speaker=?',
                           (run['persona'], json.loads(identity[0])['speaker'])).fetchone() if run else None
        if thread and thread['state'] == 'paused':
            return False
    binding = c.execute('SELECT * FROM exploration_wallet_bindings WHERE run_id=?', (run_id,)).fetchone()
    if not binding or not binding['wallet_id']:
        return True
    wallet = c.execute('SELECT * FROM exploration_wallets WHERE id=?', (binding['wallet_id'],)).fetchone()
    return bool(wallet and wallet['enabled'] and wallet['revision'] == binding['revision']
                and (not amount or provider_balance_in(c, run_id) or charged(c, wallet['id'])+amount <= wallet['token_limit']))


def provider_balance_in(c, run_id):
    initialize(c)
    identity = c.execute("SELECT content FROM exploration_artifacts WHERE run_id=? AND kind='identity'", (run_id,)).fetchone()
    if not identity or not json.loads(identity[0]).get('autonomous'):
        return False
    row = c.execute('''SELECT s.provider_balance FROM exploration_wallet_spending s
        JOIN exploration_wallet_bindings b ON b.wallet_id=s.wallet_id WHERE b.run_id=?''', (run_id,)).fetchone()
    return bool(row and row[0])
