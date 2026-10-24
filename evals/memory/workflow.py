"""Exercise daily memory orchestration using archived real outputs and controlled adversarial outputs."""
from __future__ import annotations

import asyncio
import argparse
from contextlib import ExitStack
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
from unittest.mock import patch

import semantic

sys.path.insert(0, str(semantic.ROOT / 'backend'))


def run_case(case, raw, *, topic_drift=False, incremental=False):
    with tempfile.TemporaryDirectory(prefix='xtr-workflow-eval-') as folder, ExitStack() as stack:
        root = Path(folder)
        runner = stack.enter_context(asyncio.Runner())
        runner.get_loop()  # Windows loop creates its local socket pair before network guard.
        stack.enter_context(patch.dict(os.environ, {'PERSONAL_MEMORY_ROOT': str(root / 'memory'),
                                                   'PERSONAL_DATABASE_ROOT': str(root / 'database')}))
        stack.enter_context(patch.object(socket.socket, 'connect', side_effect=RuntimeError('Network forbidden')))
        from app import db
        from app.services import memory, memory_daily as daily, memory_workflow as work
        from app.services import memory_extract as extractor, persona_memory as pm, self_profile as sp
        for obj, key, value in [(db, 'DB_PATH', root / 'test.db'), (db, 'DATA_DIR', root / 'data'),
                                (work, 'ROOT', root / 'memory'), (sp, '_SELF_PROFILE_ROOT', root / 'profiles')]:
            stack.enter_context(patch.object(obj, key, value))
        stack.enter_context(patch.object(memory, 'embeddings_config', return_value={
            'engine': 'local', 'local_model': 'workflow-offline', 'cloud_model': '', 'base_url': '', 'api_key': ''}))
        stack.enter_context(patch.object(memory.emb, 'embed_texts', side_effect=memory.emb.EmbeddingError('offline')))
        db.init_db()
        db.upsert_profile('eval-a', {'name': '合成用户'})
        messages = [{**m, 'created_at': f'2026-10-19T09:{i:02}:00+08:00'} for i, m in enumerate(case['messages'])]
        kwargs = dict(messages=messages, character_ids=['dashiyin'], session_kind='single', name_of={},
                      base_url='https://eval.invalid/v1', api_key='', model='archived-gpt-6.1-sol',
                      force=True, save=True, feature_id='', persona_id='eval-a',
                      session_id='eval-a@single-dashiyin', requested_day='2026-10-19')
        checks, calls = [], []
        def check(name, condition, actual=None):
            checks.append({'name': name, 'status': 'pass' if condition else 'fail', 'actual': actual})
        async def replay(request, **options):
            calls.append(request)
            return raw
        with patch.object(extractor.openai, 'complete_chat', replay):
            result = runner.run(daily.process(**kwargs))
            check('每日整理完成', result.get('status') == 'completed', result.get('status'))
            check('原文及清洗副本已归档', bool(list((work.root() / work.SOURCE).rglob('*.md'))) and
                  bool(list((work.root() / '01_清洗层').rglob('*.md'))))
            check('未审核不得注入', pm.injectable('eval-a', ['dashiyin'], '今天')[0] == [])
            candidates = result.get('candidates', [])
            check('候选数与原始模型输出一致', len(candidates) == len(json.loads(extractor._strip_fences(raw))['memories']), len(candidates))
            check('候选全部待审核', all(c['review_status'] == 'pending' for c in candidates))
            if candidates:
                item = candidates[0]
                query = item['text']
                item = work.review(item['id'], 'eval-a', 'approve', {}, item['revision'])
                check('批准后相关查询召回', len(pm.injectable('eval-a', ['dashiyin'], query)[0]) == 1)
                check('其他身份不可召回', pm.injectable('eval-b', ['dashiyin'], query)[0] == [])
                item = work.review(item['id'], 'eval-a', 'save', {'inject': False}, item['revision'])
                check('停用后消失', pm.injectable('eval-a', ['dashiyin'], query)[0] == [])
                corrected = '用户人工核对：周日一起练习日语，时间仍待确定。'
                item = work.review(item['id'], 'eval-a', 'save', {'text': corrected, 'details': '', 'inject': True}, item['revision'])
                # Reorganize same topic with a deliberately conflicting model answer.
                decoded = json.loads(extractor._strip_fences(raw))
                decoded['memories'][0]['text'] = '模型错误覆盖：周一已经完成学习。'
                if topic_drift:
                    decoded['memories'][0]['event_key'] = '学习计划_重新命名的主题'
                conflict = json.dumps(decoded, ensure_ascii=False)
                next_kwargs = kwargs
                if incremental:
                    next_kwargs = {**kwargs, 'force': False, 'messages': [*messages, {
                        'id': 'incremental-correction', 'role': 'user',
                        'content': '再次确认：改为周日练日语，不是周一，也还没有完成。',
                        'created_at': '2026-10-19T10:00:00+08:00'}]}
                    decoded['memories'][0]['source_ids'] = ['incremental-correction']
                    conflict = json.dumps(decoded, ensure_ascii=False)
                async def conflicting(request, **options):
                    calls.append(request)
                    return conflict
                with patch.object(extractor.openai, 'complete_chat', conflicting):
                    runner.run(daily.process(**next_kwargs))
                _, after = work.get(item['id'])
                check('同主题重整不覆盖人工版本', after['text'] == corrected, after['text'])
                injected = pm.injectable('eval-a', ['dashiyin'], '日语')[0]
                check('召回保持人工核对内容', any(corrected in m['text'] for m in injected))
                check('冲突输出未新增旁路候选', len(work.list_items('eval-a', work.LONG)) == len(candidates))
                if topic_drift:
                    all_items = work.list_items('eval-a', work.LONG)
                    from app.services.memory_relations import annotate
                    annotated = annotate(all_items, 'eval-a')
                    new_pending = [m for m in annotated if m['review_status'] == 'pending']
                    if not incremental:
                        check('相同证据的新候选显示人工记忆关联', bool(new_pending) and all(m['related_reviewed'] for m in new_pending))
                    check('新冲突候选未审核不可注入', not any('模型错误覆盖' in m['text'] for m in injected))
                    checks.append({'name': '诊断：重整后条目', 'status': 'info', 'actual': [
                        {k: m.get(k) for k in ['text', 'event_topic', 'review_status', 'user_edited', 'inject', 'evidence']}
                        for m in all_items]})
            before = len(calls)
            runner.run(daily.process(**{**(next_kwargs if candidates else kwargs), 'force': False}))
            check('相同输入不重复请求模型', len(calls) == before)
        return {'id': case['id'], 'status': 'fail' if any(c['status'] == 'fail' for c in checks) else 'pass',
                'model_boundary': 'archived real output replay; conflict stage uses controlled output',
                'calls_replayed': len(calls), 'checks': checks}


def main():
    parser = argparse.ArgumentParser(description='Replay explicitly supplied local model results; no network calls.')
    parser.add_argument('--results', type=Path, nargs='+', required=True, help='Authorized local results.json files')
    args = parser.parse_args()
    source_names = ['memory_daily.py', 'memory_workflow.py', 'memory_extract.py', 'memory_cleaning.py',
                    'memory_sources.py', 'persona_memory.py', 'memory_retrieval.py', 'activity_memory.py']
    before = {name: semantic.sha((semantic.ROOT / 'backend/app/services' / name).read_bytes()) for name in source_names}
    paths = args.results
    selected = {'S01', 'S06', 'S11'}
    rows, sources = [], {}
    for path in paths:
        report = semantic.read(path)
        cases = {c['id']: c for c in report['plan']['cases']}
        sources[path.name] = semantic.sha(path.read_bytes())
        for result in report['results']:
            if result['id'] in selected and result['status'] == 'needs_review':
                try:
                    row = run_case(cases[result['id']], result['raw_output'])
                except Exception as exc:
                    row = {'id': result['id'], 'status': 'error', 'error': f'{type(exc).__name__}: {exc}'}
                rows.append(row)
    folder = semantic.HERE / 'workflow-runs' / semantic.stamp()
    folder.mkdir(parents=True)
    report = {'mode': 'offline archival replay, no new API calls', 'paid_calls': 0,
              'source_sha256_before': before,
              'source_sha256_after': {name: semantic.sha((semantic.ROOT / 'backend/app/services' / name).read_bytes()) for name in source_names},
              'source_results_sha256': sources, 'runner_sha256': semantic.sha(Path(__file__).read_bytes()),
              'results': rows, 'release_gate': 'not_assessed',
              'limitations': 'No HTTP authentication, vectors, images, cross-batch identity changes or live model continuity tested.'}
    report['sources_changed_during_run'] = [name for name in before if before[name] != report['source_sha256_after'][name]]
    semantic.write(folder / 'report.json', report)
    print(json.dumps({'artifact': str(folder / 'report.json'), 'results': [{k: r[k] for k in ['id','status']} for r in rows]}, ensure_ascii=False))
    return 1 if len(rows) != 3 or any(r['status'] != 'pass' for r in rows) or report['sources_changed_during_run'] else 0


if __name__ == '__main__':
    raise SystemExit(main())
