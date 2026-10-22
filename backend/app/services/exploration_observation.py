"""Read-only, role-scoped metacognition; no raw host state, prompts or secrets."""
from .. import db


def observe(run_id, persona, speaker):
    from . import exploration_budget as budget, exploration_projects as projects, exploration_wallet as wallet
    with db._tx() as c:
        budget.initialize(c)
        run = c.execute('SELECT id,persona,state,run_limit FROM exploration_runs WHERE id=? AND persona=?', (run_id, persona)).fetchone()
        identity = c.execute("SELECT content FROM exploration_artifacts WHERE run_id=? AND kind='identity'", (run_id,)).fetchone()
        import json
        if not run or not identity or json.loads(identity[0]).get('speaker') != speaker:
            from fastapi import HTTPException
            raise HTTPException(409, '只能观察本轮固定角色')
        charged = budget._charged(c, 'run_id=?', (run_id,))
    own_wallet = next((w for w in wallet.listing() if w['persona'] == persona and w['speaker'] == speaker), None)
    own_projects = projects.listing(persona, speaker)
    return {'speaker': speaker, 'run': dict(run), 'charged': charged,
            'wallet': ({k: own_wallet[k] for k in ('model', 'token_limit', 'charged', 'remaining', 'enabled')} if own_wallet else None),
            'projects': [{'id': p['id'], 'title': p['title'], 'progress': p['progress'], 'state': p['state']} for p in own_projects[:5]],
            'boundaries': ['主项目只读源码快照，不可读宿主配置、私密目录或密钥',
                           '代码修改与执行仅在获批项目工作区；自己的个人docs和记忆可用既有工具读写，无需项目审批',
                           '项目没有完成义务，聊天同意不增加额度，前端审批才放行',
                           '自我观察与反思不赋予权限，不可自行充值或改变自身规则']}
