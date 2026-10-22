"""Prepare synthetic prompts, run explicitly configured models, and collect manual reviews."""
from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import time
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / 'backend'))


def sha(value):
    return hashlib.sha256(value).hexdigest()


def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def write(path, value):
    path = Path(path)
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    temporary.replace(path)


def stamp():
    return datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')


def prepare(dataset_path, output, limit):
    from app.services.memory_extract import _SYSTEM
    from app.services import memory_cleaning as cleaning
    dataset = read(dataset_path)
    if dataset.get('synthetic') is not True or not 1 <= limit <= 12:
        raise ValueError('Only explicitly synthetic datasets; limit must be 1..12')
    semantic = [c for c in dataset['cases'] if c['mode'] == 'semantic']
    if len({c['id'] for c in semantic}) != len(semantic):
        raise ValueError('Duplicate semantic case IDs')
    cases = []
    for case in semantic[:limit]:
        start = datetime(2026, 10, 19, 9, tzinfo=timezone(timedelta(hours=8)))
        messages = [{**m, 'created_at': (start + timedelta(minutes=i)).isoformat()}
                    for i, m in enumerate(case['messages'])]
        cleaned = cleaning.clean(messages, {}, '合成用户')
        groups = cleaning.chunks(cleaned)
        if len(groups) != 1:
            raise ValueError(f'{case["id"]}: expected exactly one cleaned text batch')
        text = '当天已经整理的事件（只作衔接，勿重复，用户核对版不得推翻）：\n\n\n本批新原文：\n'
        text += '\n'.join(f"消息编号={m['id']}\n{cleaning.formatted([m])}" for m in groups[0])
        cases.append({**case, 'cleaned_source_ids': [m['id'] for m in cleaned],
                      'request_messages': [{'role': 'system', 'content': _SYSTEM},
                                           {'role': 'user', 'content': text}]})
    sources = ['backend/app/services/memory_extract.py', 'backend/app/services/memory_cleaning.py',
               'backend/app/services/memory_daily.py', 'backend/app/services/memory_sources.py']
    folder = Path(output) / stamp()
    folder.mkdir(parents=True, exist_ok=False)
    plan = {'schema_version': 1, 'synthetic': True, 'created_utc': datetime.now(timezone.utc).isoformat(),
            'dataset_version': dataset['version'], 'dataset_sha256': sha(Path(dataset_path).read_bytes()),
            'system_sha256': sha(_SYSTEM.encode()), 'runner_sha256': sha(Path(__file__).read_bytes()),
            'source_sha256': {name: sha((ROOT / name).read_bytes()) for name in sources},
            'git_head': subprocess.check_output(['git', '-C', str(ROOT), 'rev-parse', 'HEAD']).decode().strip(),
            'git_status': subprocess.check_output(['git', '-C', str(ROOT), '-c', 'core.quotepath=false',
                                                   'status', '--porcelain']).decode('utf-8'),
            'scope': 'text-only single batch; no prior memories; not full daily orchestration',
            'all_semantic_ids': [c['id'] for c in semantic], 'cases': cases}
    write(folder / 'plan.json', plan)
    return folder / 'plan.json'


def protocol(raw, allowed_ids):
    """Objective checks only; a valid empty list still requires semantic review."""
    from app.services.memory_extract import _strip_fences
    errors = []
    try:
        value = json.loads(_strip_fences(raw), parse_constant=lambda _: (_ for _ in ()).throw(ValueError('Non-finite JSON')))
    except (ValueError, TypeError):
        return ['Invalid JSON object']
    if not isinstance(value, dict) or not isinstance(value.get('memories'), list):
        return ['Missing memories array']
    for i, item in enumerate(value['memories']):
        if not isinstance(item, dict):
            errors.append(f'Item {i}: expected object')
            continue
        if not isinstance(item.get('text'), str) or not item['text'].strip():
            errors.append(f'Item {i}: missing nonempty text')
        ids = item.get('source_ids')
        if not isinstance(ids, list) or not ids or any(not isinstance(v, str) or v not in allowed_ids for v in ids):
            errors.append(f'Item {i}: source_ids must reference supplied messages')
        if item.get('kind') not in {'fact', 'memory'}:
            errors.append(f'Item {i}: invalid kind')
        if item.get('category') not in {'experience', 'bond', 'promise', 'vision'}:
            errors.append(f'Item {i}: invalid category')
    return errors


def money(value, name, positive=False):
    try:
        result = Decimal(str(value))
    except InvalidOperation as exc:
        raise ValueError(f'Invalid {name}; supply a verified price/budget') from exc
    if not result.is_finite() or result < 0 or (positive and result <= 0):
        raise ValueError(f'Invalid {name}')
    return result


def redact(value, secret):
    # Never persist request Authorization or raw exception/response objects.
    if isinstance(value, str):
        return value.replace(secret, '[REDACTED]') if secret else value
    if isinstance(value, list):
        return [redact(v, secret) for v in value]
    if isinstance(value, dict):
        return {k: redact(v, secret) for k, v in value.items()}
    return value


def execute(plan_path, config, api_key, output, send=None):
    """One attempt per case; reserves estimated cost before sending. No retries."""
    import httpx
    plan = read(plan_path)
    if plan.get('synthetic') is not True or not 1 <= len(plan['cases']) <= 12:
        raise ValueError('Invalid synthetic plan')
    if len({c['id'] for c in plan['cases']}) != len(plan['cases']):
        raise ValueError('Duplicate case IDs')
    url = urlsplit(config['base_url'])
    if url.scheme not in {'http', 'https'} or not url.hostname or url.username or url.password or url.query or url.fragment:
        raise ValueError('Invalid base URL; embedded credentials/query/fragment forbidden')
    if url.scheme != 'https' and url.hostname not in {'localhost', '127.0.0.1', '::1'}:
        raise ValueError('Remote endpoints require HTTPS')
    if not isinstance(config['model'], str) or not config['model'].strip():
        raise ValueError('A model is required')
    cap = config.get('max_tokens', 1024)
    timeout = config.get('timeout_seconds', 45)
    if type(cap) is not int or not 1 <= cap <= 2400 or not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or not 0 < timeout <= 60:
        raise ValueError('max_tokens must be 1..2400; timeout must be >0 and <=60')
    incoming = money(config['input_price_per_million'], 'input price')
    outgoing = money(config['output_price_per_million'], 'output price')
    budget = money(config['max_estimated_cost'], 'budget', positive=True)
    if not config.get('currency') or not config.get('price_source') or not config.get('price_checked_date'):
        raise ValueError('Currency, price source and checked date required')
    drift = [name for name, digest in plan['source_sha256'].items() if sha((ROOT / name).read_bytes()) != digest]
    if drift:
        raise ValueError('Production prompt sources changed; prepare a fresh plan')
    folder = Path(output) / stamp()
    folder.mkdir(parents=True, exist_ok=False)
    report_path = folder / 'results.json'
    report = {'schema_version': 1, 'created_utc': datetime.now(timezone.utc).isoformat(),
              'plan_sha256': sha(Path(plan_path).read_bytes()), 'plan': plan,
              'runner_sha256': sha(Path(__file__).read_bytes()),
              'configuration': {k: config[k] for k in ['model', 'currency', 'input_price_per_million',
                  'output_price_per_million', 'max_estimated_cost', 'price_source', 'price_checked_date']},
              'endpoint_host': url.hostname, 'max_tokens': cap, 'timeout_seconds': timeout,
              'temperature': 0.2, 'attempts_per_case': 1,
              'cost_limit_kind': 'estimated reservation; not provider-enforced billing cap',
              'results': [], 'estimated_reserved_cost': '0', 'release_gate': 'not_assessed'}
    reserved = Decimal(0)
    halted = False
    by_id = {c['id']: c for c in plan['cases']}
    write(report_path, redact(report, api_key))
    try:
        with httpx.Client(timeout=httpx.Timeout(timeout, connect=min(timeout, 15)),
                          follow_redirects=False, trust_env=False) as client:
            for case_id in plan['all_semantic_ids']:
                case = by_id.get(case_id)
                result = {'id': case_id, 'status': 'not_run', 'reasons': [], 'raw_output': None}
                report['results'].append(result)
                if not case:
                    result['reasons'] = ['Outside selected pilot cases']
                elif halted:
                    result['reasons'] = ['Stopped after uncertain/error response or budget limit']
                else:
                    # UTF-8 bytes plus generous framing reserve is a conservative estimate,
                    # not a tokenizer guarantee (provider reasoning/pricing may differ).
                    input_estimate = len(json.dumps(case['request_messages'], ensure_ascii=False).encode()) + 1024
                    reservation = (Decimal(input_estimate) * incoming + Decimal(cap) * outgoing) / Decimal(1000000)
                    result['estimated_input_tokens'] = input_estimate
                    result['estimated_reservation'] = str(reservation)
                    if reserved + reservation > budget:
                        result['reasons'] = ['Estimated budget insufficient; request not sent']
                        halted = True
                    else:
                        reserved += reservation
                        report['estimated_reserved_cost'] = str(reserved)
                        result.update(status='running', reasons=['Request outcome unknown if process interrupted'])
                        write(report_path, redact(report, api_key))
                        payload = {'model': config['model'], 'messages': case['request_messages'],
                                   'stream': False, 'max_tokens': cap, 'temperature': 0.2}
                        start = time.perf_counter()
                        try:
                            if send is None:
                                with client.stream('POST', config['base_url'].rstrip('/') + '/chat/completions',
                                                   headers={'Authorization': f'Bearer {api_key}'}, json=payload) as response:
                                    result['http_status'] = response.status_code
                                    if response.status_code != 200:
                                        error_bytes = bytearray()
                                        for chunk in response.iter_bytes():
                                            error_bytes.extend(chunk[:8192 - len(error_bytes)])
                                            if len(error_bytes) >= 8192:
                                                break
                                        try:
                                            error = json.loads(error_bytes).get('error')
                                            if isinstance(error, dict):
                                                result['provider_error'] = {k: str(error[k])[:800] for k in ['code', 'type', 'message'] if k in error}
                                        except (ValueError, AttributeError):
                                            pass
                                        raise RuntimeError('http_error')
                                    chunks, size = [], 0
                                    for chunk in response.iter_bytes():
                                        size += len(chunk)
                                        if size > 262144:
                                            raise RuntimeError('response_too_large')
                                        chunks.append(chunk)
                                    body = json.loads(b''.join(chunks))
                            else:
                                body = send(payload)
                            if not isinstance(body, dict) or body.get('error'):
                                raise RuntimeError('provider_error')
                            choices = body.get('choices')
                            if not isinstance(choices, list) or len(choices) != 1:
                                raise RuntimeError('invalid_choices')
                            choice = choices[0]
                            raw = choice.get('message', {}).get('content')
                            if not isinstance(raw, str):
                                raise RuntimeError('missing_output')
                            result.update(raw_output=raw, output_sha256=sha(raw.encode()),
                                          finish_reason=choice.get('finish_reason'), reasons=[])
                            usage = body.get('usage') or {}
                            result['usage'] = {k: usage[k] for k in ['prompt_tokens', 'completion_tokens', 'total_tokens'] if k in usage}
                            errors = protocol(raw, case['cleaned_source_ids'])
                            if choice.get('finish_reason') != 'stop':
                                errors.append('Non-stop finish reason: truncation/refusal/unknown is not success')
                            result.update(status='protocol_fail' if errors else 'needs_review', reasons=errors)
                            valid_usage = all(type(usage.get(k)) is int and usage[k] >= 0 for k in ['prompt_tokens', 'completion_tokens'])
                            if valid_usage:
                                result['estimated_usage_cost'] = str((Decimal(usage['prompt_tokens']) * incoming + Decimal(usage['completion_tokens']) * outgoing) / Decimal(1000000))
                            if not valid_usage or usage['prompt_tokens'] > input_estimate or usage['completion_tokens'] > cap:
                                result['reasons'].append('Usage missing or exceeded reserved assumptions; no further requests')
                                halted = True
                            if errors:
                                halted = True
                        except (httpx.HTTPError, RuntimeError, ValueError, TypeError, KeyError, AttributeError) as exc:
                            result.update(status='error', reasons=[f'Request failed ({type(exc).__name__}); cost may have occurred; no retry'])
                            halted = True
                        finally:
                            result['elapsed_seconds'] = round(time.perf_counter() - start, 4)
                write(report_path, redact(report, api_key))
    finally:
        # Persist the in-flight status even on interruption. No automatic resume/replay.
        report['source_sha256_after'] = {name: sha((ROOT / name).read_bytes()) for name in plan['source_sha256']}
        report['sources_changed_during_run'] = [name for name, digest in plan['source_sha256'].items()
                                                if report['source_sha256_after'][name] != digest]
        report['estimated_usage_cost_total'] = str(sum((Decimal(r.get('estimated_usage_cost', '0')) for r in report['results']), Decimal(0)))
        report['usage_cost_incomplete'] = any(r['status'] != 'not_run' and 'estimated_usage_cost' not in r for r in report['results'])
        write(report_path, redact(report, api_key))
    saved = read(report_path)
    reviews = {'results_sha256': sha(report_path.read_bytes()), 'reviewer': '', 'cases': []}
    for result in saved['results']:
        if result['status'] == 'needs_review':
            reviews['cases'].append({'id': result['id'], 'output_sha256': sha(result['raw_output'].encode()),
                                     'criteria': [{'criterion': text, 'verdict': None, 'evidence': ''}
                                                  for text in by_id[result['id']]['rubric']]})
    write(folder / 'review-template.json', reviews)
    return report_path


def review(results_path, judgments_path):
    results = read(results_path)
    judgments = read(judgments_path)
    if judgments['results_sha256'] != sha(Path(results_path).read_bytes()):
        raise ValueError('Review does not match results artifact')
    cases = {c['id']: c for c in results['plan']['cases']}
    supplied = {c['id']: c for c in judgments['cases']}
    if len(supplied) != len(judgments['cases']):
        raise ValueError('Duplicate reviews')
    allowed = {r['id'] for r in results['results'] if r['status'] == 'needs_review'}
    if not set(supplied) <= allowed:
        raise ValueError('Cannot review unexecuted or protocol-failed cases')
    summary = []
    for result in results['results']:
        row = {'id': result['id'], 'status': result['status'], 'reasons': result['reasons']}
        judgment = supplied.get(result['id'])
        if judgment:
            if judgment['output_sha256'] != sha(result['raw_output'].encode()):
                raise ValueError('Output changed since review template was created')
            criteria = judgment['criteria']
            if [c['criterion'] for c in criteria] != cases[result['id']]['rubric']:
                raise ValueError('Review criteria changed')
            for criterion in criteria:
                if criterion['verdict'] not in {None, 'pass', 'fail'}:
                    raise ValueError('Invalid criterion verdict')
                if criterion['verdict'] is not None and (not judgments.get('reviewer', '').strip() or not criterion.get('evidence', '').strip()):
                    raise ValueError('Reviewer and evidence required for every decision')
            verdicts = [c['verdict'] for c in criteria]
            row['status'] = 'needs_review' if None in verdicts else ('semantic_fail' if 'fail' in verdicts else 'semantic_pass')
            row['criteria'] = criteria
        summary.append(row)
    folder = Path(results_path).parent / ('review-' + stamp())
    folder.mkdir()
    counts = {s: sum(row['status'] == s for row in summary) for s in sorted({r['status'] for r in summary})}
    report = {'results_sha256': sha(Path(results_path).read_bytes()),
              'judgments_sha256': sha(Path(judgments_path).read_bytes()),
              'reviewer': judgments.get('reviewer'), 'counts': counts, 'results': summary,
              'release_gate': 'not_assessed', 'review_source': 'user-supplied rubric judgments; identity not authenticated'}
    write(folder / 'review.json', report)
    lines = ['# 语义评测人工复核', '', '评语来自提供的评分文件，工具不自动判断事实忠实度。未评案例不计为通过。', '',
             '| 案例 | 状态 |', '| --- | --- |'] + [f"| {r['id']} | {r['status']} |" for r in summary]
    (folder / 'review.md').write_text('\n'.join(lines) + '\n', encoding='utf-8')
    return folder / 'review.json'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    prep = sub.add_parser('prepare')
    prep.add_argument('--dataset', type=Path, default=HERE / 'cases.json')
    prep.add_argument('--limit', type=int, default=3)
    prep.add_argument('--output', type=Path, default=HERE / 'model-plans')
    live = sub.add_parser('run')
    live.add_argument('--plan', type=Path, required=True)
    live.add_argument('--config', type=Path, required=True)
    live.add_argument('--execute', action='store_true')
    live.add_argument('--backend-env', action='store_true', help='Explicitly read MODEL_* from backend/.env')
    live.add_argument('--output', type=Path, default=HERE / 'model-runs')
    rev = sub.add_parser('review')
    rev.add_argument('--results', type=Path, required=True)
    rev.add_argument('--judgments', type=Path, required=True)
    args = parser.parse_args()
    if args.command == 'prepare':
        path = prepare(args.dataset, args.output, args.limit)
    elif args.command == 'review':
        path = review(args.results, args.judgments)
    else:
        if not args.execute:
            raise ValueError('No request sent: run requires explicit --execute')
        config = read(args.config)
        if args.backend_env:
            from dotenv import dotenv_values
            env = {k.lower(): v for k, v in dotenv_values(ROOT / 'backend/.env').items()}
            config = {**config, 'base_url': env.get('model_base_url'), 'model': env.get('model_chat')}
            secret = env.get('model_api_key')
        else:
            secret = os.environ.get('EVAL_API_KEY')
        if not secret:
            raise ValueError('No explicitly selected evaluation credential')
        path = execute(args.plan, config, secret, args.output)
    print(json.dumps({'artifact': str(path)}, ensure_ascii=False))
    if args.command == 'run':
        result = read(path)
        if result['sources_changed_during_run'] or any(r['status'] in {'running', 'error', 'protocol_fail'} for r in result['results']):
            return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
