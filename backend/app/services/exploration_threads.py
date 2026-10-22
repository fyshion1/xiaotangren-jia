"""Durable, role-scoped curiosity across bounded runs. No permission grants."""
import hashlib
import json
import time
from fastapi import HTTPException
from .. import db


def initialize(c):
    c.execute('''CREATE TABLE IF NOT EXISTS exploration_threads (
        persona TEXT NOT NULL, speaker TEXT NOT NULL, state TEXT NOT NULL,
        notes TEXT NOT NULL, motivation TEXT NOT NULL, next_at REAL NOT NULL,
        urgent INTEGER NOT NULL, blocked_stamp TEXT NOT NULL, last_run TEXT NOT NULL,
        updated REAL NOT NULL, PRIMARY KEY(persona,speaker))''')
    c.execute('''CREATE TABLE IF NOT EXISTS exploration_signals (
        id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL)''')


def listing():
    with db._tx() as c:
        initialize(c)
        return [dict(r) for r in c.execute('SELECT * FROM exploration_threads ORDER BY persona,speaker')]


def stamp(role, cfg):
    from . import exploration_budget as budget, exploration_projects as projects
    from .qq_proactive import CONTEXT_VERSION
    grants = [g['id'] for p in projects.listing(role['persona'], role['speaker']) for g in p['grants']
              if g['state'] == 'approved' and g['expires'] > time.time()]
    return hashlib.sha256(json.dumps([role['token_limit'], role['revision'], budget.day(), bool(cfg.get('enabled')),
        cfg.get('run_tokens'), cfg.get('day_tokens'), cfg.get('allow_estimated_usage', False), sorted(grants), CONTEXT_VERSION]).encode()).hexdigest()


def context(persona, speaker, current_run):
    from . import exploration_budget as budget
    with db._tx() as c:
        initialize(c); budget.initialize(c)
        row = c.execute('SELECT * FROM exploration_threads WHERE persona=? AND speaker=?', (persona, speaker)).fetchone()
        history = c.execute('''SELECT a.kind,a.content FROM exploration_artifacts a
            JOIN exploration_runs r ON r.id=a.run_id
            JOIN exploration_artifacts i ON i.run_id=r.id AND i.kind='identity'
            WHERE r.persona=? AND json_extract(i.content,'$.speaker')=? AND r.id!=?
            AND json_extract(i.content,'$.autonomous')=1
            AND a.kind IN ('document','browse','web','reference','project','progress','write_file','agent','continuation','recent_chats','personal_memory','personal_docs')
            ORDER BY r.created DESC,a.step DESC LIMIT 2''', (persona, speaker, current_run)).fetchall()
    return {'notes': row['notes'][:500] if row else '', 'owner_motivation': row['motivation'] if row else '',
            'recent_evidence': [{'kind': h['kind'], 'excerpt': h['content'][:450]} for h in history]}


def repeating_work(persona, speaker):
    """Stop exact repeated tool results across segments without another model call."""
    from . import exploration_budget as budget
    with db._tx() as c:
        budget.initialize(c)
        rows = c.execute('''SELECT a.kind,a.content FROM exploration_artifacts a
            JOIN exploration_runs r ON r.id=a.run_id
            JOIN exploration_artifacts i ON i.run_id=r.id AND i.kind='identity'
            WHERE r.persona=? AND json_extract(i.content,'$.speaker')=?
            AND json_extract(i.content,'$.autonomous')=1
            AND a.kind IN ('read_file','write_file','execute','web','agent','consult','reference','browse','personal_memory','personal_docs','observe_memory')
            ORDER BY r.created DESC,a.step DESC LIMIT 3''', (persona, speaker)).fetchall()
    return len(rows) == 3 and len({(r['kind'], r['content']) for r in rows}) == 1


def signal(persona, speaker, action, prompt='', request_id=''):
    from . import exploration_autonomy as autonomy, exploration_budget as budget, exploration_wallet as wallet
    if action not in ('start', 'pause', 'status') or len(prompt) > 400 or not request_id:
        raise HTTPException(422, '沙盒指令无效')
    if not db.get_profile(persona) or not db.get_character(speaker):
        raise HTTPException(404, '身份或角色不存在')
    cfg = autonomy.settings()
    role = next((w for w in wallet.listing() if w['persona'] == persona and w['speaker'] == speaker), None)
    gate = budget.status()
    fingerprint = hashlib.sha256(json.dumps([persona, speaker, action, prompt]).encode()).hexdigest()
    with db._tx() as c:
        initialize(c)
        c.execute('BEGIN IMMEDIATE')
        old = c.execute('SELECT * FROM exploration_signals WHERE id=?', (request_id,)).fetchone()
        if old:
            if old['fingerprint'] != fingerprint:
                raise HTTPException(409, '此指令编号已用于其他内容')
            return json.loads(old['result'])
        c.execute('INSERT OR IGNORE INTO exploration_threads VALUES(?,?,?,?,?,?,?,?,?,?)',
                  (persona, speaker, 'ready', '', '', 0, 0, '', '', time.time()))
        row = c.execute('SELECT * FROM exploration_threads WHERE persona=? AND speaker=?', (persona, speaker)).fetchone()
        accepted = False
        if action == 'pause':
            c.execute("UPDATE exploration_threads SET state='paused',urgent=0,updated=? WHERE persona=? AND speaker=?", (time.time(), persona, speaker))
            budget.initialize(c)
            c.execute("""UPDATE exploration_runs SET state='stopped' WHERE persona=? AND id IN
                (SELECT run_id FROM exploration_artifacts WHERE kind='identity'
                 AND json_extract(content,'$.speaker')=? AND json_extract(content,'$.autonomous')=1)
                AND state IN ('active','finished')""", (persona, speaker))
            from . import exploration_outbox
            exploration_outbox.initialize(c)
            c.execute("UPDATE exploration_outbox SET state='cancelled' WHERE persona=? AND speaker=? AND state='pending'", (persona, speaker))
            message = '这位小糖人的沙盒活动已暂停；在途请求仍会结算，未增加或撤销已有额度。'
        elif action == 'status':
            message = f"沙盒状态：{row['state']}。" + (row['notes'][:250] or '还没有留下探索接力记录。')
        else:
            # Coalesce repeated encouragement into one pending wake, never a job per message.
            c.execute("UPDATE exploration_threads SET state=CASE WHEN state='running' THEN state ELSE 'ready' END,motivation=?,urgent=1,next_at=0,blocked_stamp='',updated=? WHERE persona=? AND speaker=?",
                      (prompt or '主人鼓励：去玩玩沙盒，按自己的兴趣探索并交流。', time.time(), persona, speaker))
            if not cfg.get('enabled'):
                message = '第一动力已记下，但全局自主活动尚未启用；请到前端启用，聊天不会代替后台开关。'
            elif gate['stopped']:
                message = '消息已保存，但后台已暂停今天的自主活动；请在前端恢复。当前没有调用模型。'
            elif gate['uncertain']:
                message = '消息已保存，但有本地限额或项目请求的用量尚待核对，后续调用被拦截；请到前端查看用量记录。当前没有调用模型。'
            elif not role or not role['enabled'] or (not role['remaining'] and not role.get('provider_balance')):
                message = '想玩的方向已记下，但独立钱包未启用或没有 token 许可。请到前端配置或追加；我没有获得新额度。'
            else:
                accepted = True
                message = ('收到！会接着已有活动往下探索。' if row['state'] == 'running' else '收到！已唤醒沙盒，后台将在约 20 秒内接手。') + '会使用现有额度与权限，后续自动接着玩，不需要每轮再叫我。'
        result = {'accepted': accepted, 'speaker': speaker, 'message': message, 'action': action}
        c.execute('INSERT INTO exploration_signals VALUES(?,?,?)', (request_id, fingerprint, json.dumps(result, ensure_ascii=False)))
    return result
