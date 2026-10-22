"""Persistent projects and explicit grants. Model text can request, never approve."""
from __future__ import annotations

import json
import time
import uuid

from fastapi import HTTPException

from .. import db


def initialize(c):
    c.execute('''CREATE TABLE IF NOT EXISTS exploration_projects (
        id TEXT PRIMARY KEY, persona TEXT NOT NULL, speaker TEXT NOT NULL,
        title TEXT NOT NULL, goal TEXT NOT NULL, progress TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL DEFAULT 'open', created REAL NOT NULL, updated REAL NOT NULL)''')
    c.execute('''CREATE TABLE IF NOT EXISTS exploration_requests (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, reason TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending', created REAL NOT NULL)''')
    c.execute('''CREATE TABLE IF NOT EXISTS exploration_grants (
        id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL,
        tokens INTEGER NOT NULL, capabilities TEXT NOT NULL, created REAL NOT NULL,
        expires REAL NOT NULL, state TEXT NOT NULL DEFAULT 'approved')''')
    c.execute('''CREATE TABLE IF NOT EXISTS exploration_run_grants (
        run_id TEXT PRIMARY KEY, grant_id TEXT NOT NULL)''')
    c.execute('''CREATE TABLE IF NOT EXISTS exploration_project_events (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL,
        content TEXT NOT NULL, created REAL NOT NULL)''')


def event(c, project_id, kind, content):
    c.execute('INSERT INTO exploration_project_events VALUES(?,?,?,?,?)',
              (uuid.uuid4().hex, project_id, kind, json.dumps(content, ensure_ascii=False), time.time()))


def owned(c, project_id, persona, speaker):
    row = c.execute('SELECT * FROM exploration_projects WHERE id=? AND persona=? AND speaker=?',
                    (project_id, persona, speaker)).fetchone()
    if not row or row['state'] != 'open':
        raise HTTPException(409, '项目不存在、已暂停或不属于当前角色')
    return row


def propose(persona, speaker, title, goal):
    if not isinstance(title, str) or not 1 <= len(title.strip()) <= 80 or not isinstance(goal, str) or not 1 <= len(goal.strip()) <= 1600:
        raise HTTPException(422, '项目标题或目标长度无效')
    with db._tx() as c:
        initialize(c)
        c.execute('BEGIN IMMEDIATE')
        # A model cannot exhaust the database by inventing projects each turn.
        if c.execute("SELECT COUNT(*) FROM exploration_projects WHERE persona=? AND speaker=? AND state='open'", (persona, speaker)).fetchone()[0] >= 10:
            raise HTTPException(409, '每位角色最多保留十个进行中项目')
        project_id = uuid.uuid4().hex
        now = time.time()
        c.execute('INSERT INTO exploration_projects(id,persona,speaker,title,goal,created,updated) VALUES(?,?,?,?,?,?,?)',
                  (project_id, persona, speaker, title.strip(), goal.strip(), now, now))
        event(c, project_id, 'created', {'title': title.strip(), 'goal': goal.strip()})
    return project_id


def request_more(project_id, persona, speaker, reason):
    if not isinstance(reason, str) or not 1 <= len(reason.strip()) <= 800:
        raise HTTPException(422, '申请理由长度无效')
    with db._tx() as c:
        initialize(c)
        c.execute('BEGIN IMMEDIATE')
        owned(c, project_id, persona, speaker)
        existing = c.execute("SELECT id FROM exploration_requests WHERE project_id=? AND state='pending'", (project_id,)).fetchone()
        if existing:
            return existing[0]
        since = time.time()-86400
        if c.execute("SELECT 1 FROM exploration_project_events WHERE project_id=? AND kind='rejected' AND created>?",
                     (project_id, since)).fetchone():
            raise HTTPException(429, '本项目申请被拒后休息 24 小时，不反复申请')
        if c.execute('SELECT COUNT(*) FROM exploration_requests r JOIN exploration_projects p ON p.id=r.project_id '
                     'WHERE p.persona=? AND p.speaker=? AND r.created>?', (persona, speaker, since)).fetchone()[0] >= 3:
            raise HTTPException(429, '每位角色 24 小时内最多提出三次资源申请，先休息')
        request_id = uuid.uuid4().hex
        c.execute('INSERT INTO exploration_requests(id,project_id,reason,created) VALUES(?,?,?,?)',
                  (request_id, project_id, reason.strip(), time.time()))
        event(c, project_id, 'requested', {'request_id': request_id, 'reason': reason.strip()})
    return request_id


def approve(request_id, tokens, hours, capabilities):
    if type(tokens) is not int or not 1000 <= tokens <= 200000 or type(hours) is not int or not 1 <= hours <= 24:
        raise HTTPException(422, '额度应为 1,000–200,000 token，有效期 1–24 小时')
    if not isinstance(capabilities, list) or not capabilities or 'document' not in capabilities or any(x not in ('document', 'python', 'web_read', 'codex') for x in capabilities):
        raise HTTPException(422, '仅支持文档、只读网页、隔离 Python 和隔离 Codex')
    if 'python' in capabilities or 'codex' in capabilities:
        from .exploration_workspace import capability
        runtime = capability()
        if not runtime['available'] or ('codex' in capabilities and not runtime.get('agent_available')):
            raise HTTPException(409, '对应隔离执行镜像尚未就绪，不能授予执行权限')
    with db._tx() as c:
        initialize(c)
        c.execute('BEGIN IMMEDIATE')
        row = c.execute("SELECT * FROM exploration_requests WHERE id=? AND state='pending'", (request_id,)).fetchone()
        if not row:
            raise HTTPException(409, '申请已处理或不存在')
        project = c.execute('SELECT * FROM exploration_projects WHERE id=?', (row['project_id'],)).fetchone()
        if not project or project['state'] != 'open':
            raise HTTPException(409, '项目已暂停')
        # Renewals replace permission, not history or already charged usage.
        c.execute("UPDATE exploration_grants SET state='revoked' WHERE project_id=? AND state='approved'", (row['project_id'],))
        grant_id = uuid.uuid4().hex
        now = time.time()
        c.execute('INSERT INTO exploration_grants(id,request_id,project_id,tokens,capabilities,created,expires) VALUES(?,?,?,?,?,?,?)',
                  (grant_id, request_id, row['project_id'], tokens, json.dumps(sorted(set(capabilities))), now, now+hours*3600))
        c.execute("UPDATE exploration_requests SET state='approved' WHERE id=?", (request_id,))
        event(c, row['project_id'], 'approved', {'grant_id': grant_id, 'tokens': tokens, 'hours': hours, 'capabilities': capabilities})
    return grant_id


def reject(request_id):
    with db._tx() as c:
        initialize(c)
        c.execute('BEGIN IMMEDIATE')
        row = c.execute("SELECT * FROM exploration_requests WHERE id=? AND state='pending'", (request_id,)).fetchone()
        if not row:
            raise HTTPException(409, '申请已处理或不存在')
        c.execute("UPDATE exploration_requests SET state='rejected' WHERE id=?", (request_id,))
        event(c, row['project_id'], 'rejected', {'request_id': request_id})


def pause(project_id):
    with db._tx() as c:
        initialize(c)
        c.execute('BEGIN IMMEDIATE')
        if not c.execute('SELECT 1 FROM exploration_projects WHERE id=?', (project_id,)).fetchone():
            raise HTTPException(404, '项目不存在')
        c.execute("UPDATE exploration_projects SET state='paused',updated=? WHERE id=?", (time.time(), project_id))
        c.execute("UPDATE exploration_grants SET state='revoked' WHERE project_id=?", (project_id,))
        c.execute("UPDATE exploration_requests SET state='cancelled' WHERE project_id=? AND state='pending'", (project_id,))
        event(c, project_id, 'paused', {})


def progress(project_id, persona, speaker, text):
    if not isinstance(text, str) or not 1 <= len(text.strip()) <= 1600:
        raise HTTPException(422, '进度长度无效')
    with db._tx() as c:
        initialize(c)
        owned(c, project_id, persona, speaker)
        c.execute('UPDATE exploration_projects SET progress=?,updated=? WHERE id=?', (text.strip(), time.time(), project_id))
        event(c, project_id, 'progress', {'text': text.strip()})


def grant_for_run(c, run_id):
    initialize(c)
    return c.execute('SELECT g.*,p.persona,p.speaker,p.state AS project_state FROM exploration_run_grants r '
                     'JOIN exploration_grants g ON g.id=r.grant_id JOIN exploration_projects p ON p.id=g.project_id '
                     'WHERE r.run_id=?', (run_id,)).fetchone()


def valid(grant):
    return bool(grant and grant['state'] == 'approved' and grant['project_state'] == 'open' and grant['expires'] > time.time())


def attach(run_id, persona, speaker):
    """Called by trusted planner, before its first model request. No model-chosen grant."""
    from . import exploration_budget as budget
    with db._tx() as c:
        initialize(c)
        budget.initialize(c)
        c.execute('BEGIN IMMEDIATE')
        existing = grant_for_run(c, run_id)
        if existing:
            if existing['persona'] != persona or existing['speaker'] != speaker or not valid(existing):
                raise HTTPException(409, '项目授权已失效或角色变化')
            return dict(existing)
        if c.execute('SELECT 1 FROM exploration_calls WHERE run_id=?', (run_id,)).fetchone():
            return None
        candidates = c.execute("SELECT g.*,p.persona,p.speaker,p.state AS project_state FROM exploration_grants g "
                               "JOIN exploration_projects p ON p.id=g.project_id WHERE p.persona=? AND p.speaker=? "
                               "AND p.state='open' AND g.state='approved' AND g.expires>? ORDER BY g.created",
                               (persona, speaker, time.time())).fetchall()
        for grant in candidates:
            used = budget._charged(c, 'run_id IN (SELECT run_id FROM exploration_run_grants WHERE grant_id=?)', (grant['id'],))
            if used >= grant['tokens']:
                continue
            c.execute('INSERT INTO exploration_run_grants VALUES(?,?)', (run_id, grant['id']))
            c.execute('UPDATE exploration_runs SET run_limit=? WHERE id=?', (min(grant['tokens']-used, 50000), run_id))
            return dict(grant)
    return None


def check_run(run_id, capability_name='document'):
    from . import exploration_budget as budget
    if not budget.active(run_id):
        raise HTTPException(409, '活动已停止或授权过期')
    with db._tx() as c:
        grant = grant_for_run(c, run_id)
        if not valid(grant) or capability_name not in json.loads(grant['capabilities']):
            raise HTTPException(409, '当前任务没有对应的后台批准权限')
        return dict(grant)


def fallback_if_insufficient(run_id, amount):
    """An unusable remainder must not prevent asking for renewal via normal activity."""
    from . import exploration_budget as budget
    normal_limit, _ = budget.limits()
    with db._tx() as c:
        initialize(c)
        c.execute('BEGIN IMMEDIATE')
        grant = grant_for_run(c, run_id)
        if not grant:
            return False
        used = budget._charged(c, 'run_id IN (SELECT run_id FROM exploration_run_grants WHERE grant_id=?)', (grant['id'],))
        if amount+used <= grant['tokens']:
            return False
        if c.execute('SELECT 1 FROM exploration_calls WHERE run_id=?', (run_id,)).fetchone():
            raise HTTPException(409, '已开始项目不能切换额度')
        c.execute('DELETE FROM exploration_run_grants WHERE run_id=?', (run_id,))
        c.execute('UPDATE exploration_runs SET run_limit=? WHERE id=?', (normal_limit, run_id))
        return True


def listing(persona=None, speaker=None):
    from . import exploration_budget as budget
    with db._tx() as c:
        initialize(c)
        budget.initialize(c)
        where, args = (' WHERE persona=? AND speaker=?', (persona, speaker)) if persona and speaker else ('', ())
        items = [dict(r) for r in c.execute('SELECT * FROM exploration_projects'+where+' ORDER BY updated DESC LIMIT 50', args)]
        for item in items:
            item['requests'] = [dict(r) for r in c.execute('SELECT * FROM exploration_requests WHERE project_id=? ORDER BY created DESC LIMIT 10', (item['id'],))]
            item['grants'] = [dict(r) for r in c.execute('SELECT * FROM exploration_grants WHERE project_id=? ORDER BY created DESC LIMIT 10', (item['id'],))]
            for grant in item['grants']:
                grant['capabilities'] = json.loads(grant['capabilities'])
                grant['charged'] = budget._charged(c, 'run_id IN (SELECT run_id FROM exploration_run_grants WHERE grant_id=?)', (grant['id'],))
            item['events'] = [dict(r) for r in c.execute('SELECT * FROM exploration_project_events WHERE project_id=? ORDER BY created DESC LIMIT 10', (item['id'],))]
        return items
