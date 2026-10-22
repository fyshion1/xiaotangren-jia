"""Immutable owner notifications. Talking grants no resources; dashboard does."""
from __future__ import annotations

import json
import time
from .. import db


def initialize(c):
    c.execute('''CREATE TABLE IF NOT EXISTS exploration_outbox (
        run_id TEXT PRIMARY KEY, persona TEXT NOT NULL, speaker TEXT NOT NULL,
        owner TEXT NOT NULL, account INTEGER NOT NULL, session TEXT NOT NULL,
        plan TEXT NOT NULL, state TEXT NOT NULL, created REAL NOT NULL, expires REAL NOT NULL)''')


def submit(run_id, session, plan):
    from . import exploration_autonomy
    account = exploration_autonomy.settings().get('qq_account_index')
    cfg = (db.get_feature_settings('qq_bridge') or {}).get('data') or {}
    owner = str(cfg.get('owner.qq') or '')
    if account is None or not owner.isdigit() or plan.get('channel') != 'private':
        return False
    speaker = plan['actions'][0]['speaker']
    with db._tx() as c:
        initialize(c)
        c.execute('BEGIN IMMEDIATE')
        # No ever-growing mailbox and no delayed catch-up after a long absence.
        c.execute("UPDATE exploration_outbox SET state='expired' WHERE state='pending' AND expires<?", (time.time(),))
        c.execute('INSERT OR IGNORE INTO exploration_outbox VALUES(?,?,?,?,?,?,?,?,?,?)',
                  (run_id, session['persona_id'], speaker, owner, account,
                   json.dumps(session), json.dumps(plan, ensure_ascii=False), 'pending', time.time(), time.time()+3600))
    return True


def valid(c, row):
    from . import exploration_budget as budget, exploration_projects as projects, exploration_wallet as wallet
    budget.initialize(c)
    run = c.execute('SELECT * FROM exploration_runs WHERE id=?', (row['run_id'],)).fetchone()
    grant = projects.grant_for_run(c, row['run_id'])
    control = c.execute('SELECT stopped FROM exploration_controls WHERE day=?', (budget.day(),)).fetchone()
    unknown = budget.blocking_unknown_in(c, budget.day())
    return bool(run and run['state'] in ('active', 'finished') and row['expires'] > time.time()
                and run['day'] == budget.day() and not unknown and not (control and control[0])
                and (not grant or projects.valid(grant)) and wallet.valid_in(c, row['run_id']))


def claim(session, owner, account):
    from . import qq_conversation, exploration_autonomy
    resolved = qq_conversation.validate(session)
    cfg = (db.get_feature_settings('qq_bridge') or {}).get('data') or {}
    options = exploration_autonomy.settings()
    if (not options.get('enabled') or not options.get('qq_notify', True) or not owner.isdigit()
            or owner != str(cfg.get('owner.qq') or '') or account != options.get('qq_account_index')):
        return {}
    with db._tx() as c:
        initialize(c)
        c.execute('BEGIN IMMEDIATE')
        rows = c.execute("SELECT * FROM exploration_outbox WHERE state='pending' ORDER BY created").fetchall()
        for row in rows:
            if not valid(c, row) or row['owner'] != owner or row['account'] != account:
                c.execute("UPDATE exploration_outbox SET state='cancelled' WHERE run_id=?", (row['run_id'],))
                continue
            if row['persona'] != resolved['persona_id'] or row['speaker'] not in resolved['character_ids']:
                continue
            # Crash/timeout after this transaction is UNKNOWN, never claimed again.
            c.execute("UPDATE exploration_outbox SET state='sending' WHERE run_id=?", (row['run_id'],))
            return {'plan': json.loads(row['plan']), 'run_id': row['run_id']}
    return {}


def acknowledge(run_id, sent):
    with db._tx() as c:
        initialize(c)
        c.execute("UPDATE exploration_outbox SET state=? WHERE run_id=? AND state='sending'", ('sent' if sent else 'unknown', run_id))


def publishing(c):
    initialize(c)
    return [r['run_id'] for r in c.execute("SELECT * FROM exploration_outbox WHERE state='sending'").fetchall() if valid(c, r)]


def listing():
    with db._tx() as c:
        initialize(c)
        c.execute("UPDATE exploration_outbox SET state='expired' WHERE state='pending' AND expires<?", (time.time(),))
        return [dict(r) for r in c.execute('SELECT run_id,persona,speaker,plan,state,created,expires FROM exploration_outbox ORDER BY created DESC LIMIT 20')]
