"""Controlled counterexamples for topic drift. No network, no real private data."""
from pathlib import Path
import argparse

import semantic
import workflow


def main():
    parser = argparse.ArgumentParser(description='Controlled topic-drift replay using authorized local results.')
    parser.add_argument('--results', type=Path, required=True, help='Local results.json containing synthetic case S06')
    source = parser.parse_args().results
    archived = semantic.read(source)
    case = next(c for c in archived['plan']['cases'] if c['id'] == 'S06')
    raw = next(r['raw_output'] for r in archived['results'] if r['id'] == 'S06')
    names = ['memory_daily.py', 'memory_workflow.py', 'persona_memory.py', 'memory_cleaning.py']
    before = {name: semantic.sha((semantic.ROOT / 'backend/app/services' / name).read_bytes()) for name in names}
    rows = []
    for label, drift, incremental in [('same-topic-control', False, False),
                                       ('renamed-topic-same-evidence', True, False),
                                       ('renamed-topic-incremental-correction', True, True)]:
        try:
            result = workflow.run_case(case, raw, topic_drift=drift, incremental=incremental)
        except Exception as exc:
            result = {'status': 'error', 'error': f'{type(exc).__name__}: {exc}'}
        rows.append({'scenario': label, 'topic_drift': drift, 'incremental': incremental, **result})
    after = {name: semantic.sha((semantic.ROOT / 'backend/app/services' / name).read_bytes()) for name in names}
    folder = semantic.HERE / 'topic-drift-runs' / semantic.stamp()
    folder.mkdir(parents=True)
    report = {'mode': 'controlled model-output counterexamples, not measured live-model failure frequency',
              'paid_calls': 0, 'source_sha256_before': before, 'source_sha256_after': after,
              'sources_changed_during_run': [name for name in before if before[name] != after[name]],
              'archive_sha256': semantic.sha(source.read_bytes()),
              'runner_sha256': semantic.sha(Path(__file__).read_bytes()),
              'workflow_sha256': semantic.sha(Path(workflow.__file__).read_bytes()),
              'results': rows, 'release_gate': 'not_assessed'}
    semantic.write(folder / 'report.json', report)
    lines = ['# 事件主题漂移反例', '', '受控模型输出；不是实际模型失败概率。', '',
             '| 场景 | 状态 | 失败检查 |', '| --- | --- | --- |']
    for row in rows:
        failures = '；'.join(c['name'] for c in row.get('checks', []) if c['status'] == 'fail')
        lines.append(f"| {row['scenario']} | {row['status']} | {failures} |")
    (folder / 'report.md').write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print(folder / 'report.json')
    for row in rows:
        print(row['scenario'], row['status'], [c['name'] for c in row.get('checks', []) if c['status'] == 'fail'])
    return 1 if any(r['status'] != 'pass' for r in rows) or before != after else 0


if __name__ == '__main__':
    raise SystemExit(main())
