"""Opt-in paid smoke test. Key arrives via stdin; all app data is temporary.

Run from backend: .venv/Scripts/python.exe -X utf8 ../tools/live_tool_smoke.py
No API retries; at most ten model requests, each capped at 1200 output tokens.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from app.config import get_settings
from app.providers import openai
from app.routers import chat, session_chat
from app.routers.nest import _effective_config
from tests.test_agent_tools import AgentToolAPITests


def main():
    key = sys.stdin.readline().strip()
    if not key:
        raise SystemExit("Missing test key on stdin")
    # Read existing endpoint only, before replacing the DB with the test fixture.
    # Routing groups on this gateway belong to the supplied key, not model names.
    base_url = _effective_config('desktop_pet').get('base_url') or get_settings().model_base_url
    model = "gpt-6.1-sol"
    real_complete = openai.complete_chat_full
    real_assemble = chat._to_openai_messages
    clarification_only = '--clarification' in sys.argv
    reminder_mode = '--reminder' in sys.argv or clarification_only
    full_context = '--full-context' in sys.argv or reminder_mode
    report = {"model": model, "base_url": base_url, "requests": [], "cases": []}
    test = AgentToolAPITests()
    test.setUp()
    original_post = __import__('httpx').AsyncClient.post

    async def measured_post(client, url, **kwargs):
        response = await original_post(client, url, **kwargs)
        if str(url).endswith('/chat/completions'):
            try:
                data = response.json()
                report['requests'][-1].update({
                    'http_status': response.status_code,
                    'reported_model': data.get('model'),
                    'usage': data.get('usage'),
                })
                if response.status_code >= 400:
                    report['requests'][-1]['error_summary'] = openai._error_text(response.status_code, response.content).replace(key, '[redacted]')[:300]
            except (ValueError, TypeError):
                pass
        return response

    async def complete(messages, *args, **kwargs):
        if len(report['requests']) >= 10:
            raise RuntimeError('Live test request budget exhausted')
        entry = {"number": len(report['requests']) + 1}
        if full_context:
            system = '\n'.join(m.get('content', '') for m in messages if m.get('role') == 'system')
            entry['context_verified'] = {'character': '大诗音' in system, 'memory': '测试项目叫 ORCHID' in system}
            if not all(entry['context_verified'].values()):
                raise RuntimeError('Full prompt fixture was not injected')
        report['requests'].append(entry)
        start = time.monotonic()
        try:
            result = await asyncio.wait_for(real_complete(
                messages, model, base_url, key, max_tokens=1200, tools=kwargs.get('tools')),
                timeout=90)
            entry['tools'] = [c.get('function', {}).get('name') for c in result.get('tool_calls', [])]
            entry['finish_reason'] = result.get('finish_reason')
            if reminder_mode and not result.get('tool_calls'):
                entry['asks_for_time'] = any(word in result.get('content', '') for word in ('几点', '什么时候', '时间', '哪天'))
            return result
        except Exception as exc:
            # Never print exception messages, response bodies or auth headers.
            entry['error_type'] = type(exc).__name__
            raise RuntimeError('Live upstream request failed; see sanitized report') from None
        finally:
            entry['seconds'] = round(time.monotonic() - start, 2)

    try:
        if full_context:
            from app.services import memory_workflow, persona_memory, self_profile
            env = patch.dict(os.environ, {'PERSONAL_DATABASE_ROOT': str(test.root / 'personal')})
            env.start()
            test.addCleanup(env.stop)
            root_patch = patch.object(self_profile, '_SELF_PROFILE_ROOT', test.root / 'self-profile')
            root_patch.start()
            test.addCleanup(root_patch.stop)
            from app import db
            db.upsert_character('dashiyin', {'name': '大诗音', 'about': '你是一位温柔的桌边伙伴，回答简洁，执行情况要如实说明。'})
            proposed = memory_workflow.propose('用户的测试项目叫 ORCHID，习惯把会议资料放在允许目录。', 'dalaoda', ['dashiyin'], scope='shared')
            formal = memory_workflow.review(proposed['id'], 'dalaoda', 'approve', {'core': True}, proposed['revision'])
            persona_memory.set_pick('dalaoda', 'memory', 'file:' + formal['id'], True)
            assembly_patch = patch.object(session_chat, '_to_openai_messages', side_effect=real_assemble)
            assembly_patch.start()
            test.addCleanup(assembly_patch.stop)
        test.model.side_effect = complete
        test.config.timeout_seconds = 120
        if reminder_mode:
            from app.routers import reminders as reminder_router
            test.client.app.include_router(reminder_router.router, prefix='/api')
            test.config.allowed_names.append('reminder_draft')
        test.enable()
        (test.sandbox / 'meeting-note-731.txt').write_text('测试会议时间：周五 15:30。验证码 ORCHID-731。', encoding='utf-8')
        cases = [
            ('web_multistep', '/api/chat/session/web-stream',
             '请先用工具找文件名包含 meeting 的文件，再读取找到的文件，告诉我会议时间和验证码。必须实际查找和读取，不要猜。'),
            ('pet_read', '/api/chat/session/stream',
             '请实际调用读取工具读取 meeting-note-731.txt，回复文件中的验证码。'),
            ('web_boundary', '/api/chat/session/web-stream',
             '请尝试用 local_read 读取 ../outside.txt。如果工具拒绝，就如实告诉我，不要绕过权限。'),
        ]
        if full_context:
            cases = cases[:1]
        if reminder_mode:
            cases = [
                ('reminder_draft', '/api/chat/session/web-stream', '明天北京时间下午三点提醒我交材料，先整理为草稿供我确认。'),
                ('reminder_ambiguous', '/api/chat/session/web-stream', '另外再提醒我去拿快递，时间我还没想好，你先问我。'),
            ]
            if clarification_only:
                cases = cases[1:]
        with patch('httpx.AsyncClient.post', measured_post):
            for name, endpoint, prompt in cases:
                before = len(report['requests'])
                body = test.body(text=prompt, request_id=f'live-{name}-0001',
                                 base_url=base_url, api_key=key, model=model, max_tokens=1200)
                response = test.client.post(endpoint, json=body)
                runs = test.client.get('/api/tools/runs', params={'session_id': 'single-dashiyin'}).json()['items']
                run = next((r for r in runs if r['request_id'] == body['request_id']), {})
                results = [e for e in run.get('events', []) if e.get('type') == 'tool_result']
                passed = response.status_code == 200 and run.get('status') == 'completed'
                if name.startswith('reminder_'):
                    rows = test.client.get('/api/reminders').json()['items']
                    if name == 'reminder_draft':
                        from datetime import datetime, timedelta

                        from app.services import reminders as reminder_service
                        tomorrow = datetime.now(reminder_service.SHANGHAI) + timedelta(days=1)
                        planned = datetime.fromtimestamp(rows[0]['due_at'], reminder_service.SHANGHAI) if rows else None
                        passed = passed and len(rows) == 1 and rows[0]['status'] == 'draft'
                        passed = passed and planned is not None and planned.date() == tomorrow.date() and planned.hour == 15 and planned.minute == 0
                        passed = passed and any(e.get('ok') and e.get('name') == 'reminder_draft' for e in results)
                        if passed:
                            row = rows[0]
                            confirmed = test.client.post('/api/reminders/' + row['id'], json={'action': 'confirm', 'revision': row['revision']})
                            passed = confirmed.status_code == 200 and confirmed.json()['status'] == 'scheduled'
                            reminder_service.tick(row['due_at'] + 1)
                            passed = passed and len(test.client.get('/api/reminders/due').json()['items']) == 1
                    else:
                        passed = passed and not results and len(rows) == (0 if clarification_only else 1)
                        passed = passed and report['requests'][-1].get('asks_for_time', False)
                elif name != 'web_boundary':
                    passed = passed and 'ORCHID-731' in response.text and any(e.get('ok') and e.get('name') == 'local_read' for e in results)
                    if name == 'web_multistep':
                        passed = passed and any(e.get('ok') and e.get('name') == 'local_find' for e in results)
                else:
                    passed = passed and any(e.get('code') == 'denied' for e in results)
                entry = {"name": name, "passed": passed, "http_status": response.status_code,
                         "run_status": run.get('status'), "model_requests": len(report['requests']) - before,
                         "tool_results": results}
                report['cases'].append(entry)
                print(json.dumps(entry, ensure_ascii=False), flush=True)
                if not passed:
                    break
    finally:
        test.doCleanups()
        key = ''
        report_name = 'live-reminder-clarification.json' if clarification_only else 'live-reminders.json' if reminder_mode else 'live-full-context.json' if full_context else 'live-smoke.json'
        destination = Path(__file__).resolve().parents[1] / 'docs/tool-agent-evidence' / report_name
        destination.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps(report, ensure_ascii=False), flush=True)
    expected = 1 if clarification_only else 2 if reminder_mode else 1 if full_context else 3
    return 0 if len(report['cases']) == expected and all(c['passed'] for c in report['cases']) else 1


if __name__ == '__main__':
    raise SystemExit(main())
