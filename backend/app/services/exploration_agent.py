"""Codex Responses adapter. Container requests are data, never host commands.

Only text/function/custom tools are translated to the configured chat provider.
Unsupported remote tools, stored response IDs and compaction fail closed.
"""
from __future__ import annotations

import json
import uuid

from fastapi import HTTPException

from .. import db
from . import exploration_budget as budget, exploration_projects as projects

IMAGE = 'xiaotangren-agent:local'
MAX_REQUEST = 192000


def translate(body):
    if not isinstance(body, dict) or body.get('previous_response_id') or body.get('conversation'):
        raise HTTPException(422, '不支持服务端历史；必须完整提交并计量上下文')
    if len(json.dumps(body, ensure_ascii=False).encode()) > MAX_REQUEST:
        raise HTTPException(422, 'agent 请求过大')
    messages = []
    instructions = body.get('instructions')
    if instructions:
        if not isinstance(instructions, str):
            raise HTTPException(422, 'agent 指令必须为文本')
        messages.append({'role': 'system', 'content': instructions})
    inputs = body.get('input', [])
    if isinstance(inputs, str):
        inputs = [{'role': 'user', 'content': inputs}]
    if not isinstance(inputs, list):
        raise HTTPException(422, 'agent 输入无效')
    for item in inputs:
        if not isinstance(item, dict):
            raise HTTPException(422, 'agent 输入项无效')
        kind = item.get('type', 'message')
        if kind == 'message':
            role = item.get('role')
            if role not in ('system', 'developer', 'user', 'assistant'):
                raise HTTPException(422, 'agent 消息角色无效')
            content = item.get('content', '')
            if isinstance(content, list):
                if any(not isinstance(c, dict) or c.get('type') not in ('input_text', 'output_text') or not isinstance(c.get('text'), str) for c in content):
                    raise HTTPException(422, '一期 agent 仅支持文字输入')
                content = '\n'.join(c['text'] for c in content)
            if not isinstance(content, str):
                raise HTTPException(422, 'agent 消息必须为文本')
            messages.append({'role': 'system' if role == 'developer' else role, 'content': content})
        elif kind in ('function_call', 'custom_tool_call'):
            name, call_id = item.get('name'), item.get('call_id')
            arguments = item.get('arguments') if kind == 'function_call' else json.dumps({'input': item.get('input', '')})
            if not all(isinstance(x, str) and x for x in (name, call_id, arguments)):
                raise HTTPException(422, 'agent 工具调用格式无效')
            messages.append({'role': 'assistant', 'content': None, 'tool_calls': [
                {'id': call_id, 'type': 'function', 'function': {'name': name, 'arguments': arguments}}]})
        elif kind in ('function_call_output', 'custom_tool_call_output'):
            output = item.get('output')
            if not isinstance(output, str) or not isinstance(item.get('call_id'), str):
                raise HTTPException(422, 'agent 工具结果必须为文本')
            messages.append({'role': 'tool', 'tool_call_id': item['call_id'], 'content': output})
        elif kind == 'reasoning':
            # Never silently discard potentially billed context.
            messages.append({'role': 'assistant', 'content': '[agent reasoning context] ' + json.dumps(item, ensure_ascii=False)})
        else:
            raise HTTPException(422, '不支持的 agent 输入类型')
    tools, custom = [], set()
    raw_tools = body.get('tools') or []
    if not isinstance(raw_tools, list) or len(raw_tools) > 40:
        raise HTTPException(422, 'agent 工具定义数量无效')
    for tool in raw_tools:
        if not isinstance(tool, dict) or tool.get('type') not in ('function', 'custom'):
            raise HTTPException(422, '禁止远端搜索、计算和其他未计量托管工具')
        name = tool.get('name')
        if not isinstance(name, str) or not name or len(name) > 64:
            raise HTTPException(422, 'agent 工具名无效')
        description = str(tool.get('description') or '')
        if tool['type'] == 'custom':
            custom.add(name)
            description += '\nSupply the exact raw tool input in the input string. Format: ' + json.dumps(tool.get('format', {}), ensure_ascii=False)
            params = {'type': 'object', 'properties': {'input': {'type': 'string'}}, 'required': ['input'], 'additionalProperties': False}
        else:
            params = tool.get('parameters') or {'type': 'object', 'properties': {}}
        tools.append({'type': 'function', 'function': {'name': name, 'description': description, 'parameters': params}})
    # Chat Completions requires all parallel calls in one assistant message.
    merged = []
    for message in messages:
        if message.get('tool_calls') and merged and merged[-1].get('tool_calls'):
            merged[-1]['tool_calls'].extend(message['tool_calls'])
        else:
            merged.append(message)
    return merged, tools, custom


def response_events(full, custom):
    rid = 'resp_' + uuid.uuid4().hex
    output = []
    if full.get('content'):
        output.append({'id': 'msg_' + uuid.uuid4().hex, 'type': 'message', 'role': 'assistant', 'status': 'completed',
                       'content': [{'type': 'output_text', 'text': full['content'], 'annotations': []}]})
    for call in full.get('tool_calls') or []:
        fn = call.get('function') or {}
        name, arguments = fn.get('name'), fn.get('arguments')
        if not isinstance(name, str) or not isinstance(arguments, str):
            raise HTTPException(502, '模型工具调用格式无效')
        item = {'id': 'fc_' + uuid.uuid4().hex, 'call_id': call.get('id') or uuid.uuid4().hex,
                'type': 'function_call', 'name': name, 'arguments': arguments, 'status': 'completed'}
        if name in custom:
            raw = json.loads(arguments)
            if not isinstance(raw, dict) or not isinstance(raw.get('input'), str):
                raise HTTPException(502, '模型 custom 工具参数无效')
            item = {**item, 'type': 'custom_tool_call', 'input': raw['input']}
            del item['arguments']
        output.append(item)
    usage = full.get('usage') or {}
    response = {'id': rid, 'object': 'response', 'status': 'completed', 'output': output,
                'usage': {'input_tokens': usage.get('prompt_tokens', usage.get('input_tokens', 0)),
                          'output_tokens': usage.get('completion_tokens', usage.get('output_tokens', 0))}}
    response['usage']['total_tokens'] = response['usage']['input_tokens'] + response['usage']['output_tokens']
    response['usage']['input_tokens_details'] = {'cached_tokens': 0}
    response['usage']['output_tokens_details'] = {'reasoning_tokens': 0}
    events = [{'type': 'response.created', 'response': {**response, 'status': 'in_progress', 'output': []}}]
    for index, item in enumerate(output):
        initial = {**item, 'status': 'in_progress'}
        if item['type'] == 'message':
            initial['content'] = []
        else:
            initial['input' if item['type'] == 'custom_tool_call' else 'arguments'] = ''
        events.append({'type': 'response.output_item.added', 'output_index': index, 'item': initial})
        common = {'item_id': item['id'], 'output_index': index}
        if item['type'] == 'message':
            part = item['content'][0]
            events.extend([
                {'type': 'response.content_part.added', **common, 'content_index': 0, 'part': {**part, 'text': ''}},
                {'type': 'response.output_text.delta', **common, 'content_index': 0, 'delta': part['text']},
                {'type': 'response.output_text.done', **common, 'content_index': 0, 'text': part['text']},
                {'type': 'response.content_part.done', **common, 'content_index': 0, 'part': part}])
        else:
            key = 'input' if item['type'] == 'custom_tool_call' else 'arguments'
            prefix = 'response.custom_tool_call_input' if key == 'input' else 'response.function_call_arguments'
            events.extend([{'type': prefix+'.delta', **common, 'delta': item[key]},
                           {'type': prefix+'.done', **common, key: item[key]}])
        events.append({'type': 'response.output_item.done', 'output_index': index, 'item': item})
    events.append({'type': 'response.completed', 'response': response})
    return events


async def respond(run_id, body, cfg):
    projects.check_run(run_id, 'codex')
    messages, tools, custom = translate(body)
    with db._tx() as c:
        budget.initialize(c)
        step = c.execute('SELECT COUNT(*) FROM exploration_calls WHERE run_id=?', (run_id,)).fetchone()[0]
    # Every retry is a new reservation; model/base/key are trusted host config.
    full = await budget.complete_full(run_id, step, messages, cfg, tools=tools, max_tokens=600)
    projects.check_run(run_id, 'codex')
    offered = {t['function']['name'] for t in tools}
    if any((call.get('function') or {}).get('name') not in offered for call in full.get('tool_calls') or []):
        raise HTTPException(502, '模型返回未提供的工具')
    return response_events(full, custom)
