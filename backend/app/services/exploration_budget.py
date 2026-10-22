"""自主活动唯一模型入口：SQLite 原子预留，累计输入+输出，未知用量当天停机。"""
from __future__ import annotations

import asyncio
import hashlib
import json
import time
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException

from .. import db
from ..providers import openai


def day():
    return datetime.now(timezone(timedelta(hours=8))).date().isoformat()


def initialize(c):
    c.execute('''CREATE TABLE IF NOT EXISTS exploration_runs (
        id TEXT PRIMARY KEY, binding TEXT NOT NULL, persona TEXT NOT NULL, day TEXT NOT NULL,
        created REAL NOT NULL, state TEXT NOT NULL, run_limit INTEGER NOT NULL)''')
    c.execute('''CREATE TABLE IF NOT EXISTS exploration_calls (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, day TEXT NOT NULL, reserved INTEGER NOT NULL,
        input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL, created REAL NOT NULL)''')
    c.execute('''CREATE TABLE IF NOT EXISTS exploration_artifacts (
        run_id TEXT NOT NULL, step INTEGER NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL,
        synced INTEGER NOT NULL DEFAULT 0, occurred_at TEXT NOT NULL, PRIMARY KEY(run_id,step,kind))''')
    c.execute('''CREATE TABLE IF NOT EXISTS exploration_controls (
        day TEXT PRIMARY KEY, stopped INTEGER NOT NULL DEFAULT 0)''')


def limits():
    from .exploration_autonomy import settings
    data = settings()
    def value(key, default, high):
        return max(0, min(int(data.get(key, default)), high))
    return value('run_tokens', 12000, 50000), value('day_tokens', 24000, 200000)


def begin(run_id, session):
    binding = hashlib.sha256(json.dumps(session, sort_keys=True).encode()).hexdigest()
    run_limit, _ = limits()
    with db._tx() as c:
        initialize(c)
        c.execute('BEGIN IMMEDIATE')
        row = c.execute('SELECT * FROM exploration_runs WHERE id=?', (run_id,)).fetchone()
        if row:
            if row['binding'] != binding:
                raise HTTPException(409, '探索身份已变化')
            return
        c.execute('INSERT INTO exploration_runs VALUES(?,?,?,?,?,?,?)',
                  (run_id, binding, session['persona_id'], day(), time.time(), 'active', run_limit))


def _charged(c, where, args):
    return c.execute('SELECT COALESCE(SUM(CASE WHEN state IN ("settled","overrun") THEN MAX(input+output,reserved*(state="overrun")) ELSE reserved END),0) '
                     'FROM exploration_calls WHERE ' + where, args).fetchone()[0]


def estimate(messages, output_limit):
    # UTF-8 字节数 + 协议余量是保守估算，不声称适用于所有供应商的精确 tokenizer。
    return len(json.dumps(messages, ensure_ascii=False).encode('utf-8')) + 512 + output_limit


def blocking_unknown_in(c, today):
    """Uncertain provider-balance calls stop their run, not the entire day.

    Keep the original reservation and stopped run. Strict wallets and project
    grants still require reconciliation before further calls.
    """
    from . import exploration_wallet as wallet, exploration_projects as projects
    for row in c.execute("SELECT run_id,state FROM exploration_calls WHERE day=? AND state IN ('unknown','overrun')", (today,)).fetchall():
        if (row['state'] == 'overrun' or not wallet.provider_balance_in(c, row['run_id'])
                or projects.grant_for_run(c, row['run_id'])):
            return True
    return False


def reserve(run_id, step, messages, output_limit):
    amount = estimate(messages, output_limit)
    run_limit, day_limit = limits()
    recover()
    with db._tx() as c:
        initialize(c)
        c.execute('BEGIN IMMEDIATE')
        today = day()
        control = c.execute('SELECT stopped FROM exploration_controls WHERE day=?', (today,)).fetchone()
        row = c.execute('SELECT * FROM exploration_runs WHERE id=?', (run_id,)).fetchone()
        from . import exploration_projects as projects
        from . import exploration_wallet as wallet
        if not wallet.valid_in(c, run_id, amount):
            raise HTTPException(409, '独立钱包已暂停、变化或累计额度不足')
        grant = projects.grant_for_run(c, run_id)
        unknown = blocking_unknown_in(c, today)
        if not row or row['state'] != 'active' or row['day'] != today or time.time()-row['created'] > 600:
            raise HTTPException(409, '探索已结束、过期或停止')
        if unknown or (control and control[0]):
            raise HTTPException(409, '今天的探索已停止（暂停或用量不确定）')
        if grant and not projects.valid(grant):
            raise HTTPException(409, '项目后台授权已撤销或过期')
        calls = c.execute('SELECT * FROM exploration_calls WHERE run_id=?', (run_id,)).fetchall()
        if step != len(calls) or step >= 6 or any(r['state'] not in ('settled', 'estimated') for r in calls):
            raise HTTPException(409, '探索步骤重复、并发或超过安全轮数')
        # 全局仅一笔在途调用，包含不同角色、任务和 worker。
        if c.execute("SELECT 1 FROM exploration_calls WHERE state='pending' LIMIT 1").fetchone():
            raise HTTPException(409, '已有探索模型调用在运行')
        if grant:
            allowed = amount + _charged(c, 'run_id IN (SELECT run_id FROM exploration_run_grants WHERE grant_id=?)', (grant['id'],)) <= grant['tokens']
            run_cap = row['run_limit']
        else:
            allowed = amount + _charged(c, 'day=? AND run_id NOT IN (SELECT run_id FROM exploration_run_grants)', (today,)) <= day_limit
            run_cap = min(run_limit, row['run_limit'])
        provider_balance = wallet.provider_balance_in(c, run_id) and not grant
        if provider_balance:
            allowed = True
        if not allowed:
            raise HTTPException(409, '累计 token 预算不足，本次不再调用模型')
        remaining = max(0, run_cap - _charged(c, 'run_id=?', (run_id,)))
        if not provider_balance and amount > remaining:
            raise HTTPException(409, f'本轮 token 预算不足：本次请求保守预留需 {amount}，本轮剩余 {remaining}；未发起模型请求',
                                headers={'X-Exploration-Budget': 'run'})
        call_id = f'{run_id}:{step}'
        c.execute('INSERT INTO exploration_calls(id,run_id,day,reserved,state,created) VALUES(?,?,?,?,?,?)',
                  (call_id, run_id, today, amount, 'pending', time.time()))
        return call_id


def recover():
    with db._tx() as c:
        initialize(c)
        c.execute("UPDATE exploration_calls SET state='unknown' WHERE state='pending' AND created<?", (time.time()-180,))


def settle(call_id, usage, *, allow_estimate=False, allow_reported_total=False, failure_reason=''):
    def count(key, alias):
        n = usage.get(key, usage.get(alias)) if isinstance(usage, dict) else None
        return n if type(n) is int and n >= 0 else None
    incoming, outgoing = count('prompt_tokens', 'input_tokens'), count('completion_tokens', 'output_tokens')
    with db._tx() as c:
        initialize(c)
        c.execute('BEGIN IMMEDIATE')
        row = c.execute('SELECT * FROM exploration_calls WHERE id=?', (call_id,)).fetchone()
        if not row or row['state'] != 'pending':
            return False
        valid = incoming is not None and outgoing is not None
        problem = '' if valid else (failure_reason or '供应商输入或输出用量缺失或格式无效')
        total = usage.get('total_tokens') if isinstance(usage, dict) else None
        if total is not None and (type(total) is not int or not valid or total != incoming+outgoing):
            valid = False
            problem = '供应商总用量与输入加输出不一致或格式无效'
        state = 'settled' if valid else 'unknown'
        reported = max((incoming or 0) + (outgoing or 0), total if type(total) is int and total >= 0 else 0)
        accounted = row['reserved']
        reported_compat = (not valid and allow_reported_total and incoming is not None
                           and outgoing is not None and type(total) is int and total >= 0)
        if not valid and allow_estimate:
            state = 'estimated'
            problem += '；按完整预留额度保守扣账，允许继续'
        if reported_compat:
            state, accounted = 'estimated', reported
            problem = '供应商用量口径差异；按已返回数字中的较大总量记账，允许继续（非账单核验）'
        if (valid or allow_estimate) and reported > row['reserved']:
            state = 'overrun'
            problem = '供应商实际用量超出调用前预留'
        c.execute('UPDATE exploration_calls SET input=?,output=?,state=?,reserved=? WHERE id=?',
                  (incoming or 0, outgoing or 0, state, max(row['reserved'], reported) if state == 'overrun' else accounted, call_id))
        if state not in ('settled', 'estimated'):
            c.execute("UPDATE exploration_runs SET state='stopped' WHERE id=?", (row['run_id'],))
        if state != 'settled':
            # Numeric receipt only: no response text, credential or provider URL.
            receipt = {key: value for key, value in (usage or {}).items()
                       if key in ('prompt_tokens', 'input_tokens', 'completion_tokens', 'output_tokens', 'total_tokens')
                       and type(value) is int} if isinstance(usage, dict) else {}
            receipt.update(reason=problem, reserved=row['reserved'], state=state)
            if reported_compat:
                receipt.update(accounted=reported, accounting_basis='reported_max', severity='info',
                               discrepancy=total-incoming-outgoing)
            c.execute('INSERT OR REPLACE INTO exploration_artifacts(run_id,step,kind,content,occurred_at) VALUES(?,?,?,?,?)',
                      (row['run_id'], int(call_id.rsplit(':', 1)[1]), 'usage_receipt', json.dumps(receipt, ensure_ascii=False), datetime.now(timezone.utc).isoformat()))
        return state in ('settled', 'estimated')


async def complete_full(run_id, step, messages, cfg, *, max_tokens=600, tools=None, response_format=None):
    from . import exploration_wallet as wallet
    cfg = wallet.configuration(run_id, cfg)
    if not cfg.get('base_url') or not cfg.get('model'):
        raise HTTPException(409, '请配置独立钱包或活动模型')
    with db._tx() as c:
        provider_balance = wallet.provider_balance_in(c, run_id)
        from . import exploration_projects as projects
        allow_reported_total = provider_balance and not projects.grant_for_run(c, run_id)
    if provider_balance:
        max_tokens = max(max_tokens, 4096)
    # Agent tool schemas are input too. The same ledger covers every request.
    call_id = reserve(run_id, step, {'messages': messages, 'tools': tools} if tools else messages, max_tokens)
    try:
        full = await asyncio.wait_for(openai.complete_chat_full(
            messages, model=cfg['model'], base_url=cfg['base_url'], api_key=cfg.get('api_key', ''),
            max_tokens=max_tokens, stream=True, **({'tools': tools} if tools else {}),
            **({'response_format': response_format} if response_format else {})), 120 if provider_balance else 55)
    except BaseException as exc:
        reason = ('模型请求被取消（可能为后端关闭或重载）' if isinstance(exc, asyncio.CancelledError)
                  else '模型请求超时' if isinstance(exc, TimeoutError)
                  else '模型请求失败：' + type(exc).__name__)
        settle(call_id, None, failure_reason=reason)
        raise
    from .exploration_autonomy import settings
    # Only a completed provider response can use this explicit dashboard option.
    # Timeout/crash reservations above still stop as unknown; no free retries.
    if not settle(call_id, full.get('usage'), allow_estimate=provider_balance or bool(settings().get('allow_estimated_usage')),
                  allow_reported_total=allow_reported_total):
        with db._tx() as c:
            receipt = c.execute("SELECT content FROM exploration_artifacts WHERE run_id=? AND step=? AND kind='usage_receipt'", (run_id, step)).fetchone()
        reason = json.loads(receipt[0])['reason'] if receipt else '供应商用量未通过校验'
        raise HTTPException(409, reason + '；保留预留扣账，今天停止自主活动')
    if full.get('finish_reason') not in (('stop', 'tool_calls') if tools else ('stop',)):
        raise HTTPException(502, '探索回复未完整结束，本次不执行动作')
    if not active(run_id):
        raise HTTPException(409, '探索已停止，不执行后续动作')
    return full


async def complete(run_id, step, messages, cfg, *, max_tokens=600, response_format=None):
    return (await complete_full(run_id, step, messages, cfg, max_tokens=max_tokens, response_format=response_format)).get('content') or ''


def active(run_id):
    with db._tx() as c:
        return active_in(c, run_id)


def active_in(c, run_id):
    """Recheck control state within the same transaction as a protected write."""
    initialize(c)
    row = c.execute('SELECT * FROM exploration_runs WHERE id=?', (run_id,)).fetchone()
    from . import exploration_projects as projects
    from . import exploration_wallet as wallet
    grant = projects.grant_for_run(c, run_id)
    today = day()
    control = c.execute('SELECT stopped FROM exploration_controls WHERE day=?', (today,)).fetchone()
    uncertain = blocking_unknown_in(c, today)
    return bool(row and row['state'] == 'active' and row['day'] == today and time.time()-row['created'] <= 600
                and not (control and control[0]) and not uncertain and (not grant or projects.valid(grant))
                and wallet.valid_in(c, run_id))


def stop(run_id=''):
    with db._tx() as c:
        initialize(c)
        if run_id:
            c.execute("UPDATE exploration_runs SET state='stopped' WHERE id=?", (run_id,))
        else:
            c.execute('INSERT OR REPLACE INTO exploration_controls VALUES(?,1)', (day(),))
            c.execute("UPDATE exploration_runs SET state='stopped' WHERE state='active'")


def finish(run_id):
    with db._tx() as c:
        initialize(c)
        c.execute("UPDATE exploration_runs SET state='finished' WHERE id=? AND state='active'", (run_id,))


def resume():
    with db._tx() as c:
        initialize(c)
        c.execute('DELETE FROM exploration_controls WHERE day=?', (day(),))


def status():
    recover()
    run_limit, day_limit = limits()
    with db._tx() as c:
        initialize(c)
        calls = [dict(r) for r in c.execute('SELECT * FROM exploration_calls WHERE day=? ORDER BY created DESC', (day(),))]
        runs = [dict(r) for r in c.execute('SELECT * FROM exploration_runs ORDER BY created DESC LIMIT 20')]
        artifacts = [dict(r) for r in c.execute('SELECT a.* FROM exploration_artifacts a JOIN exploration_runs r ON r.id=a.run_id ORDER BY r.created DESC,a.step DESC LIMIT 30')]
        control = c.execute('SELECT stopped FROM exploration_controls WHERE day=?', (day(),)).fetchone()
        from . import exploration_projects as projects
        from . import exploration_wallet as wallet
        projects.initialize(c)
        project_charged = _charged(c, 'day=? AND run_id IN (SELECT run_id FROM exploration_run_grants)', (day(),))
        uncertain = blocking_unknown_in(c, day())
        publishable = []
        for run in runs:
            grant = projects.grant_for_run(c, run['id'])
            if (run['state'] in ('active', 'finished') and run['day'] == day()
                    and time.time()-run['created'] <= 600 and (not grant or projects.valid(grant))
                    and wallet.valid_in(c, run['id'])):
                publishable.append(run['id'])
        from . import exploration_outbox
        publishable.extend(exploration_outbox.publishing(c))
    from .exploration_autonomy import settings as autonomy_settings
    options = autonomy_settings()
    return dict(day=day(), run_limit=run_limit, day_limit=day_limit, runs=runs, artifacts=artifacts,
                qq_notify=bool(options.get('enabled') and options.get('qq_notify', True) and options.get('qq_account_index') is not None),
                qq_account_index=options.get('qq_account_index'),
                publishable_runs=publishable,
                project_charged=project_charged,
                input=sum(r['input'] for r in calls), output=sum(r['output'] for r in calls),
                charged=sum(r['input']+r['output'] if r['state'] in ('settled','overrun') else r['reserved'] for r in calls),
                uncertain=uncertain,
                unconfirmed_calls=sum(r['state'] == 'unknown' for r in calls),
                stopped=bool(control and control[0]), calls=calls)


def artifact(run_id, step, kind, content):
    with db._tx() as c:
        initialize(c)
        c.execute('INSERT OR IGNORE INTO exploration_artifacts(run_id,step,kind,content,occurred_at) VALUES(?,?,?,?,?)',
                  (run_id, step, kind, json.dumps(content, ensure_ascii=False), datetime.now(timezone.utc).isoformat()))
    from . import exploration_memory
    exploration_memory.archive_activity(run_id, step, kind, content)


def sync_activity(run_id, session):
    """来源禁收/原文已删时保留待办；不切身份、不冒用 core。"""
    from . import activity_memory
    with db._tx() as c:
        initialize(c)
        rows = [dict(r) for r in c.execute('SELECT * FROM exploration_artifacts WHERE run_id=? AND synced=0', (run_id,))]
        identity = c.execute("SELECT content FROM exploration_artifacts WHERE run_id=? AND kind='identity'", (run_id,)).fetchone()
        source = 'autonomous_activity' if identity and json.loads(identity[0]).get('autonomous') else 'qq_bridge'
    for row in rows:
        if row['kind'] not in ('browse', 'document', 'project', 'request_budget', 'progress', 'write_file', 'execute', 'web', 'agent', 'self_observe'):
            continue
        try:
            activity_memory.append(session['persona_id'], source, {
                'event_id': f'explore-{run_id}-{row["step"]}-{row["kind"]}', 'revision': 1,
                'occurred_at': row['occurred_at'],
                'kind': 'exploration', 'role': 'activity', 'text': row['content'],
                'character_ids': session['character_ids'], 'scope': 'personal', 'context': 'real',
                'topic': '沙盒探索：' + row['kind']})
        except (PermissionError, LookupError, ValueError, RuntimeError):
            continue
        with db._tx() as c:
            c.execute('UPDATE exploration_artifacts SET synced=1 WHERE run_id=? AND step=? AND kind=?', (run_id, row['step'], row['kind']))


def sync_pending():
    with db._tx() as c:
        initialize(c)
        rows = c.execute('''SELECT DISTINCT r.id,r.persona,i.content FROM exploration_runs r
            JOIN exploration_artifacts a ON a.run_id=r.id AND a.synced=0 AND a.kind IN ('browse','document','project','request_budget','progress','write_file','execute','web','agent','self_observe')
            JOIN exploration_artifacts i ON i.run_id=r.id AND i.kind='identity' LIMIT 30''').fetchall()
    for row in rows:
        speaker = json.loads(row['content'])['speaker']
        if db.get_character(speaker):
            sync_activity(row['id'], {'persona_id': row['persona'], 'character_ids': [speaker]})
