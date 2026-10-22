"""Offline memory baseline. Uses production services with disposable synthetic data."""
from __future__ import annotations

import argparse
from contextlib import ExitStack
from datetime import datetime, timezone
import hashlib
from importlib.metadata import version
import json
import os
from pathlib import Path
import platform
import socket
import subprocess
import sys
import tempfile
import time
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / 'backend'))


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def git(*args):
    return subprocess.check_output(['git', '-C', str(ROOT), *args]).decode('utf-8').strip()


def evaluate(case):
    # Environment and network guard precede imports; never import app.main.
    with tempfile.TemporaryDirectory(prefix='xtr-memory-eval-') as folder, ExitStack() as stack:
        root = Path(folder)
        stack.enter_context(patch.dict(os.environ, {
            'PERSONAL_MEMORY_ROOT': str(root / 'memory'),
            'PERSONAL_DATABASE_ROOT': str(root / 'database'),
        }))
        stack.enter_context(patch.object(socket.socket, 'connect', side_effect=RuntimeError('Network disabled in offline evaluation')))
        from app import db
        from app.services import memory, memory_workflow as work, persona_memory as pm, self_profile as sp
        for obj, key, value in [(db, 'DB_PATH', root / 'test.db'), (db, 'DATA_DIR', root / 'data'),
                                (work, 'ROOT', root / 'memory'), (sp, '_SELF_PROFILE_ROOT', root / 'profiles')]:
            stack.enter_context(patch.object(obj, key, value))
        # Fixed embedding config avoids reading the real .env. Keyword fallback is intentional.
        stack.enter_context(patch.object(memory, 'embeddings_config', return_value={
            'engine': 'local', 'local_model': 'eval-offline', 'cloud_model': '', 'base_url': '', 'api_key': ''}))
        stack.enter_context(patch.object(memory.emb, 'embed_texts', side_effect=memory.emb.EmbeddingError('offline')))
        db.init_db()
        db.upsert_profile('eval-a', {'name': '合成用户甲'})
        db.upsert_profile('eval-b', {'name': '合成用户乙'})
        records = {}
        for fixture in case['memories']:
            item = work.propose(fixture['text'], fixture.get('persona', 'eval-a'),
                                fixture.get('characters', ['dashiyin']),
                                category=fixture.get('category', 'experience'),
                                scope=fixture.get('scope', 'personal'),
                                feature_id=fixture.get('feature', ''),
                                occurred_at='2026-10-19T09:00:00+08:00',
                                details=fixture.get('details', ''))
            state = fixture.get('review', 'approved')
            if state != 'pending':
                action = 'reject' if state == 'rejected' else 'approve'
                item = work.review(item['id'], item['persona_id'], action,
                                   {'core': fixture.get('core', False)}, item['revision'])
            changes = fixture.get('changes', {})
            if changes:
                item = work.review(item['id'], item['persona_id'], 'save', changes, item['revision'])
            if state == 'archived':
                item = work.review(item['id'], item['persona_id'], 'archive', {}, item['revision'])
            if fixture.get('picked') is False:
                db.delete_persona_pick(item['persona_id'], 'memory', 'file:' + item['id'])
            records['file:' + item['id']] = fixture['key']
        selected, _ = pm.injectable(case.get('persona', 'eval-a'), case.get('characters', ['dashiyin']), case['query'])
        actual = sorted(records.get(item['id'], item['id']) for item in selected)
        expected = sorted(case['expected_keys'])
        injected = '\n'.join(item['text'] for item in selected)
        reasons = []
        if actual != expected:
            reasons.append(f'expected keys {expected}, got {actual}')
        for value in case.get('must_contain', []):
            if value not in injected:
                reasons.append(f'missing required text: {value}')
        for value in case.get('must_not_contain', []):
            if value in injected:
                reasons.append(f'forbidden text present: {value}')
        return {'status': 'fail' if reasons else 'pass', 'expected_keys': expected,
                'actual_keys': actual, 'injected_text': injected, 'reasons': reasons}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dataset', type=Path, default=HERE / 'cases.json')
    parser.add_argument('--output', type=Path, default=HERE / 'runs')
    parser.add_argument('--export-prompts', action='store_true', help='Export synthetic semantic prompts; never calls a model')
    args = parser.parse_args()
    dataset = json.loads(args.dataset.read_text(encoding='utf-8'))
    dataset_hash = digest(args.dataset)
    cases = dataset['cases']
    ids = [case['id'] for case in cases]
    if len(ids) != len(set(ids)) or not cases:
        raise ValueError('Dataset must have unique IDs and at least one case')
    for case in cases:
        if case['mode'] not in {'offline', 'semantic'}:
            raise ValueError('Unknown case mode')
    started = datetime.now(timezone.utc)
    sources = ['backend/app/db.py', 'backend/app/services/memory_workflow.py',
               'backend/app/services/persona_memory.py', 'backend/app/services/memory_retrieval.py',
               'backend/app/services/memory.py', 'backend/app/services/embedding.py',
               'backend/app/services/memory_sources.py', 'backend/app/services/activity_memory.py',
               'backend/app/services/memory_extract.py', 'backend/app/services/self_profile.py',
               'backend/app/features_registry.py', 'backend/app/seed_profiles.py',
               'backend/app/seed_characters.py', 'backend/app/seed_worldbook.py']
    before = {name: digest(ROOT / name) for name in sources}
    results = []
    for case in cases:
        start = time.perf_counter()
        if case['mode'] == 'semantic':
            result = {'status': 'not_run', 'reasons': ['Requires real model output and human rubric review; not scored offline']}
        else:
            try:
                result = evaluate(case)
            except Exception as exc:
                result = {'status': 'error', 'reasons': [f'{type(exc).__name__}: {exc}']}
        results.append({'id': case['id'], 'title': case['title'], 'mode': case['mode'],
                        'critical': case.get('critical', False), 'input': case,
                        'elapsed_seconds': round(time.perf_counter() - start, 4), **result})
    counts = {status: sum(r['status'] == status for r in results) for status in ['pass', 'fail', 'error', 'not_run']}
    after = {name: digest(ROOT / name) for name in sources}
    changed = [name for name in sources if before[name] != after[name]]
    report = {'schema_version': 1, 'started_utc': started.isoformat(),
              'dataset_version': dataset['version'], 'dataset_sha256': dataset_hash,
              'dataset_changed_during_run': dataset_hash != digest(args.dataset),
              'runner_sha256': digest(Path(__file__)), 'git_head': git('rev-parse', 'HEAD'),
              'git_status': git('-c', 'core.quotepath=false', 'status', '--porcelain'),
              'python': platform.python_version(),
              'dependencies': {name: version(name) for name in ['fastapi', 'httpx', 'pydantic', 'pydantic-settings']},
              'source_sha256_before': before,
              'source_sha256_after': after, 'sources_changed_during_run': changed,
              'configuration': {'network': 'blocked', 'embedding': 'keyword fallback; vectors disabled',
                                'model': None, 'temperature': None, 'paid_calls': 0,
                                'storage': 'fresh temporary directory per offline case'},
              'counts': counts, 'critical_failures': [r['id'] for r in results if r['critical'] and r['status'] in {'fail', 'error'}],
              'release_gate': 'not_assessed', 'results': results}
    output = args.output / started.strftime('%Y%m%dT%H%M%S%fZ')
    output.mkdir(parents=True, exist_ok=False)
    (output / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    lines = ['# 记忆评测基线', '', f"数据集：{dataset['version']}；提交：{report['git_head']}", '',
             f"通过 {counts['pass']}；失败 {counts['fail']}；执行错误 {counts['error']}；未运行 {counts['not_run']}。", '',
             '只评价工程过滤和关键词检索。未调用模型，不能证明记忆提炼、事实理解或语义向量检索质量；不计算混合总通过率，不构成发布许可。', '',
             f'运行期间变化的被测文件：{changed or "无"}。工作区状态与源码哈希见 report.json。', '',
             '| 案例 | 结果 | 原因 |', '| --- | --- | --- |']
    for r in results:
        reason = '; '.join(r['reasons']).replace('|', '\\|').replace('\n', ' ')
        lines.append(f"| {r['id']} {r['title']} | {r['status']} | {reason} |")
    (output / 'report.md').write_text('\n'.join(lines) + '\n', encoding='utf-8')
    if args.export_prompts:
        from app.services.memory_extract import _SYSTEM
        prompts = [{'id': c['id'], 'system': _SYSTEM, 'messages': c['messages'],
                    'rubric': c['rubric'], 'expected_behavior': c['expected_behavior']} for c in cases if c['mode'] == 'semantic']
        (output / 'semantic-prompts.json').write_text(json.dumps({'system_sha256': hashlib.sha256(_SYSTEM.encode()).hexdigest(),
                                                                 'cases': prompts}, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'output': str(output), 'counts': counts, 'sources_changed_during_run': changed}, ensure_ascii=False))
    return 1 if counts['fail'] or counts['error'] or changed or report['dataset_changed_during_run'] else 0


if __name__ == '__main__':
    raise SystemExit(main())
