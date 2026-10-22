"""Global exploration clock. QQ is an optional delivery plugin, never the clock."""
from __future__ import annotations

import asyncio
import json
import logging
import random
import time
import uuid

from fastapi import HTTPException
from .. import db

log = logging.getLogger(__name__)
_task = None


def settings():
    with db._tx() as c:
        return settings_in(c)


def settings_in(c):
    saved = c.execute('SELECT data FROM feature_settings WHERE feature_id=?', ('autonomous_activity',)).fetchone()
    if saved:
        return {'continuous': True, 'continuation_minutes': 1, 'qq_account_index': None, **json.loads(saved[0])}
    # Read-only migration defaults; after the first dashboard save QQ settings
    # cannot change this clock or these caps. Never enable a new paid scheduler.
    row = c.execute('SELECT data FROM feature_settings WHERE feature_id=?', ('qq_bridge',)).fetchone()
    old = json.loads(row[0]) if row else {}
    return {'enabled': False, 'continuous': True, 'continuation_minutes': 1, 'qq_notify': True, 'min_minutes': 60, 'max_minutes': 180, 'daily_opportunities': 6,
            'run_tokens': old.get('proactive.run_tokens', 12000),
            'day_tokens': old.get('proactive.day_tokens', 24000)}


def initialize(c):
    c.execute('''CREATE TABLE IF NOT EXISTS exploration_clock (
        id INTEGER PRIMARY KEY CHECK(id=1), next_at REAL NOT NULL, day TEXT NOT NULL,
        count INTEGER NOT NULL, lease_until REAL NOT NULL, last_run TEXT NOT NULL,
        last_result TEXT NOT NULL)''')


def status():
    from . import exploration_threads as threads
    with db._tx() as c:
        initialize(c)
        row = c.execute('SELECT * FROM exploration_clock WHERE id=1').fetchone()
    return {'settings': settings(), 'clock': dict(row) if row else None, 'threads': threads.listing()}


def configure(values):
    db.set_feature_settings('autonomous_activity', values)
    # Configuration changes cancel the old appointment, not an in-flight bill.
    with db._tx() as c:
        initialize(c)
        c.execute('UPDATE exploration_clock SET next_at=0 WHERE id=1')


def claim():
    from . import exploration_budget as budget, exploration_wallet as wallet
    from . import exploration_threads as threads
    cfg = settings()
    if not cfg.get('enabled'):
        return None
    gate = budget.status()
    if gate['stopped'] or gate['uncertain']:
        return None
    candidates = [w for w in wallet.listing() if w['enabled'] and (w['remaining'] > 0 or w.get('provider_balance'))]
    if not candidates:
        return None
    now, today = time.time(), budget.day()
    stamps = {(w['persona'], w['speaker']): threads.stamp(w, cfg) for w in candidates}
    with db._tx() as c:
        initialize(c)
        threads.initialize(c)
        c.execute('BEGIN IMMEDIATE')
        row = c.execute('SELECT * FROM exploration_clock WHERE id=1').fetchone()
        if row and row['lease_until'] > now:
            return None
        count = row['count'] if row and row['day'] == today else 0
        for w in candidates:
            c.execute('INSERT OR IGNORE INTO exploration_threads VALUES(?,?,?,?,?,?,?,?,?,?)',
                      (w['persona'], w['speaker'], 'ready', '', '', 0, 0, '', '', now))
        roles = {(w['persona'], w['speaker']): w for w in candidates}
        eligible = [t for t in c.execute('SELECT * FROM exploration_threads ORDER BY urgent DESC,updated,persona,speaker')
                    if (t['persona'], t['speaker']) in roles and t['state'] != 'paused'
                    and t['next_at'] <= now and (t['state'] not in ('waiting_resources', 'error')
                    or t['blocked_stamp'] != stamps[(t['persona'], t['speaker'])])]
        urgent = next((t for t in eligible if t['urgent']), None)
        continuous = cfg.get('continuous', True)
        if not continuous and not urgent and count >= cfg.get('daily_opportunities', 6):
            return None
        next_at = row['next_at'] if row else 0
        # Restart/overdue appointment: schedule afresh, never catch up.
        if not continuous and not urgent and (not next_at or now-next_at > 600):
            delay = random.uniform(cfg.get('min_minutes', 60), cfg.get('max_minutes', 180))*60
            c.execute('INSERT OR REPLACE INTO exploration_clock VALUES(1,?,?,?,?,?,?)',
                      (now+delay, today, count, 0, row['last_run'] if row else '', '等待独立活动机会'))
            return None
        if not continuous and not urgent and next_at > now:
            return None
        if not eligible:
            return None
        # Round robin by last role, so one wallet cannot monopolize the clock.
        thread = urgent or eligible[0]
        role = roles[(thread['persona'], thread['speaker'])]
        run = uuid.uuid4().hex
        delay = random.uniform(cfg.get('min_minutes', 60), cfg.get('max_minutes', 180))*60
        c.execute('INSERT OR REPLACE INTO exploration_clock VALUES(1,?,?,?,?,?,?)',
                  (now+delay, today, count+1, now+660, f"{role['persona']}:{role['speaker']}:{run}", '正在探索'))
        c.execute("UPDATE exploration_threads SET state='running',urgent=0,last_run=?,next_at=?,updated=? WHERE persona=? AND speaker=?",
                  (run, now+660, now, role['persona'], role['speaker']))
    return role, run


async def explore(role, run):
    from . import qq_proactive, qq_conversation, exploration_budget as budget, exploration_outbox as outbox
    from . import exploration_conversations
    session = exploration_conversations.context(role['speaker'], role['persona'])
    step, videos, can_browse = 0, None, True
    deadline = time.monotonic()+600
    result = '安静结束'
    from . import exploration_threads as threads
    state, notes, rest_minutes = 'ready', '', settings().get('continuation_minutes', 1)
    blocked_stamp = ''
    work_pending = False
    try:
        while step < 6 and time.monotonic() < deadline:
            if not settings().get('enabled'):
                budget.stop(run)
                break
            plan = await qq_proactive.plan(session, can_browse=can_browse, videos=videos,
                                          run_id=run, step=step, channels=['private'], autonomous=True)
            step = plan['next_step']
            work_pending = plan['intent'] in ('continue', 'browse') or (plan['intent'] == 'say' and bool(plan.get('continue_work')))
            if plan.get('next_interest') or plan.get('reflection'):
                notes = ('感想：' + plan.get('reflection', '') + '\n下一步：' + plan.get('next_interest', ''))[:1200]
            if plan['intent'] == 'browse':
                videos = await browse(plan.get('interest', ''))
                can_browse = False
            elif plan['intent'] == 'say':
                exploration_conversations.say(run, session, plan['actions'])
                queued = outbox.submit(run, session, plan)
                result = '分享候选已交给 QQ 插件；资源仍需后台审批' if queued else '分享候选已保存，QQ 目标未配置'
                break
            elif plan['intent'] == 'rest':
                work_pending = False
                state, rest_minutes = 'resting', plan['rest_minutes']
                result = '自己选择休息，之后自动继续'
                break
            elif plan['intent'] != 'continue':
                break
        if work_pending and settings().get('continuous', True):
            # A segment is a checkpoint, not a compulsory cooldown. The next
            # claim rechecks pause, wallet, grants and fairness before any call.
            rest_minutes = 0
            result += '；有明确下一步，立即接续工作'
            if threads.repeating_work(role['persona'], role['speaker']):
                state, rest_minutes = 'error', settings().get('continuation_minutes', 1)
                blocked_stamp = threads.stamp(role, settings())
                result = '连续三次工具结果完全相同，已保存进度并停止连续工作；等待新消息或配置变化'
    except HTTPException as exc:
        state = 'waiting_resources' if exc.status_code == 409 else 'error'
        blocked_stamp = threads.stamp(role, settings())
        result = str(exc.detail)[:200]
        if (exc.headers or {}).get('X-Exploration-Budget') == 'run':
            with db._tx() as c:
                spent = c.execute("SELECT 1 FROM exploration_calls WHERE run_id=? AND state IN ('settled','estimated')", (run,)).fetchone()
            if spent:
                # Only the bounded epoch ends. Wallet/day/project pools never reset.
                state, blocked_stamp = 'ready', ''
                result = '本轮额度装不下下一次请求，保存已有活动，稍后在原钱包与当日总额内继续'
        raise
    except (Exception, asyncio.CancelledError):
        state, result = 'error', '本轮中止；保留接力记录，配置修复或明确唤醒后再试'
        blocked_stamp = threads.stamp(role, settings())
        raise
    finally:
        budget.finish(run)
        with db._tx() as c:
            initialize(c)
            threads.initialize(c)
            c.execute('''UPDATE exploration_threads SET
                state=CASE WHEN state='paused' THEN state WHEN urgent=1 THEN 'ready' ELSE ? END,
                notes=CASE WHEN ?!='' THEN ? ELSE notes END,
                motivation=CASE WHEN urgent=1 THEN motivation ELSE '' END,
                next_at=CASE WHEN urgent=1 THEN 0 ELSE ? END,blocked_stamp=?,updated=?
                WHERE persona=? AND speaker=? AND last_run=?''',
                (state, notes, notes, time.time()+rest_minutes*60, blocked_stamp, time.time(), role['persona'], role['speaker'], run))
            c.execute('UPDATE exploration_clock SET lease_until=0,last_result=? WHERE id=1 AND last_run LIKE ?',
                      (result, '%:'+run))


async def browse(interest):
    """Existing fixed, credential-free Bilibili reader, without a QQ process."""
    import os
    from pathlib import Path
    import subprocess
    import sys
    folder = Path(__file__).resolve().parents[3]/'features/bilibili-scout'
    env = {k: v for k, v in os.environ.items() if k.upper() in {'SYSTEMROOT','WINDIR','PATH','TEMP','TMP'}}
    proc = await asyncio.create_subprocess_exec(sys.executable, '-I', '-X', 'utf8', '-c',
        "import runpy,sys;sys.path.insert(0,sys.argv[1]);runpy.run_module('scout.qq_candidates',run_name='__main__')",
        str(folder), cwd=str(folder), env=env, stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        **({'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {}))
    try:
        raw, _ = await asyncio.wait_for(proc.communicate(json.dumps({'look_for': str(interest)[:120], 'avoid': ''}).encode()), 20)
        return json.loads(raw).get('videos', [])[:3] if proc.returncode == 0 and len(raw) <= 16000 else []
    finally:
        if proc.returncode is None:
            proc.kill()
            await proc.wait()


async def _run():
    while True:
        try:
            selected = await asyncio.to_thread(claim)
            if selected:
                try:
                    await asyncio.wait_for(explore(*selected), 620)
                    # Claim again immediately: active work can continue, peers
                    # get a fair turn, and idle/resting roles fall back to polling.
                    await asyncio.sleep(0)
                    continue
                except HTTPException:
                    pass  # explore() already persisted the precise stop/continuation reason.
        except asyncio.CancelledError:
            raise
        except Exception:
            log.warning('自主活动本次停止；未自动重试模型请求')
        await asyncio.sleep(20)


def start():
    global _task
    if _task is None or _task.done():
        _task = asyncio.create_task(_run())


async def stop():
    global _task
    if _task:
        _task.cancel()
        await asyncio.gather(_task, return_exceptions=True)
        _task = None
