"""Independent OpenAI-compatible latency probe; no application state or retries."""
import asyncio
import json
import time

import httpx

PROMPT = '请用中文写三句简短、自然的日常聊天，每句约十五字。不要思考过程，不要解释任务。'


async def probe(base_url, api_key, model, *, stream=True, timeout=45, max_tokens=512, transport=None):
    started = time.perf_counter()
    result = {'model': model, 'stream': stream, 'ok': False, 'headers_seconds': None,
              'first_text_seconds': None, 'total_seconds': None, 'output_chars': 0,
              'usage': None, 'finish_reason': None}
    headers = {'Authorization': 'Bearer ' + api_key} if api_key else {}
    payload = {'model': model, 'messages': [{'role': 'user', 'content': PROMPT}],
               'stream': stream, 'max_tokens': max_tokens}
    if stream:
        payload['stream_options'] = {'include_usage': True}
    terminal = False
    async def request():
        nonlocal terminal
        async with httpx.AsyncClient(timeout=httpx.Timeout(timeout, connect=min(10, timeout)),
                                     transport=transport, follow_redirects=False) as client:
            async with client.stream('POST', base_url.rstrip('/') + '/chat/completions',
                                     headers=headers, json=payload) as response:
                result['headers_seconds'] = round(time.perf_counter() - started, 3)
                result['http_status'] = response.status_code
                if response.status_code != 200:
                    result['error'] = 'http_' + str(response.status_code)
                    return
                if not stream:
                    body = json.loads(await response.aread())
                    choice = (body.get('choices') or [{}])[0]
                    text = (choice.get('message') or {}).get('content') or ''
                    result['output_chars'] = len(text)
                    result['usage'] = _usage(body.get('usage'))
                    result['finish_reason'] = choice.get('finish_reason')
                    terminal = bool(result['finish_reason'])
                else:
                    async for line in response.aiter_lines():
                        if not line.startswith('data:'):
                            continue
                        data = line[5:].strip()
                        if data == '[DONE]':
                            terminal = True
                            break
                        obj = json.loads(data)
                        if obj.get('error'):
                            result['error'] = 'upstream_stream_error'
                            return
                        if obj.get('usage'):
                            result['usage'] = _usage(obj['usage'])
                        for choice in obj.get('choices') or []:
                            text = (choice.get('delta') or {}).get('content')
                            if text:
                                if result['first_text_seconds'] is None:
                                    result['first_text_seconds'] = round(time.perf_counter() - started, 3)
                                result['output_chars'] += len(text)
                            if choice.get('finish_reason'):
                                result['finish_reason'] = choice['finish_reason']
                                terminal = True
                result['ok'] = terminal and result['output_chars'] > 0 and result['finish_reason'] not in ('length', 'content_filter', 'safety')
                if not result['ok']:
                    result['error'] = 'incomplete_or_empty_output'
    try:
        await asyncio.wait_for(request(), timeout)
    except (httpx.HTTPError, TimeoutError, ValueError, TypeError, KeyError) as exc:
        result['error'] = type(exc).__name__  # Never expose provider bodies/credentials.
    result['total_seconds'] = round(time.perf_counter() - started, 3)
    usage = result['usage'] or {}
    tokens = usage.get('completion_tokens')
    result['requested_max_tokens'] = max_tokens
    result['reported_budget_exceeded'] = bool(tokens and tokens > max_tokens)
    result['output_tokens_per_second'] = round(tokens / result['total_seconds'], 2) if tokens and result['total_seconds'] else None
    return result


def _usage(value):
    if not isinstance(value, dict):
        return None
    result = {k: v for k, v in value.items() if k in
              ('prompt_tokens', 'completion_tokens', 'total_tokens') and isinstance(v, int)}
    details = value.get('completion_tokens_details')
    if isinstance(details, dict) and isinstance(details.get('reasoning_tokens'), int):
        result['reasoning_tokens'] = details['reasoning_tokens']
    return result
