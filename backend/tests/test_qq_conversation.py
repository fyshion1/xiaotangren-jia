"""QQ 原始输入、实际送达及一次性表情标注的离线回归。"""
import asyncio
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from PIL import Image

from app import db
from app.routers import qq_bridge
from app.services import attachments, qq_conversation as conv, qq_stickers as stickers


class QqConversationTests(unittest.TestCase):
    def test_stream_plain_dialogue_is_locally_adapted_only_after_completion(self):
        first = self.inbound()
        sent = []
        async def stream(*args, **kwargs):
            self.assertEqual(kwargs['response_format'], {'type': 'json_object'})
            for text in ['诶嘿嘿～', '大老大来啦！']:
                yield {'type': 'text', 'text': text}
                self.assertEqual(sent, [])
            yield {'type': 'done', 'finish_reason': 'stop'}
        async def emit(action):
            sent.append(action)
        with patch.object(conv.openai, 'stream_chat', stream):
            result = asyncio.run(conv.reply(self.session, first['message_ids'], emit_action=emit))
        self.assertEqual(sent, [{'type': 'text', 'speaker': 'dashiyin', 'text': '诶嘿嘿～大老大来啦！'}])
        self.assertEqual(result['actions'], sent)
        self.full_provider.assert_not_awaited()

    def test_plain_compatibility_rejects_structure_reasoning_and_ambiguous_speakers(self):
        session = {'character_ids': ['a', 'b'], 'names': {'a': '甲', 'b': '乙'}}
        for raw in ['诶嘿嘿', '陌生人：你好', '<think>想想</think>你好', '{"actions":', '```python\nprint(1)```', '工具：正在调用']:
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                conv.plain_dialogue_payload(raw, session)
        actions = conv.parse_actions(conv.plain_dialogue_payload('甲：你好\n乙：在呀', session), session, [])
        self.assertEqual([a['speaker'] for a in actions], ['a', 'b'])

    def test_markdown_speaker_names_and_literal_newlines_match_real_upstream(self):
        session = {'character_ids': ['a', 'b', 'c'], 'names': {'a': '大诗音', 'b': '小诗音', 'c': '小白'}}
        for separator in ['\n', r'\n']:
            raw = separator.join(['**大诗音**：诶嘿嘿～', '**小诗音**：在笑什么呀？', '**小白**：小白也来啦～'])
            actions = conv.parse_actions(conv.plain_dialogue_payload(raw, session), session, [])
            self.assertEqual([a['speaker'] for a in actions], ['a', 'b', 'c'])
            self.assertEqual(actions[0]['text'], '诶嘿嘿～')
        with self.assertRaises(ValueError):
            conv.plain_dialogue_payload('**陌生人**：不应该发送', session)
        with self.assertRaises(ValueError):
            conv.plain_dialogue_payload(r'**大诗音**：你好\n**陌生人**：不应该发送', session)

    def test_stream_markdown_multi_role_reply_emits_all_roles_once(self):
        first = self.inbound()
        sent = []
        resolved = {**self.session, 'character_ids': ['dashiyin', 'xiaoshiyin', 'xiaobai'],
                    'names': {'dashiyin': '大诗音', 'xiaoshiyin': '小诗音', 'xiaobai': '小白'}}
        async def stream(*args, **kwargs):
            raw = r'**大诗音**：诶嘿嘿～\n**小诗音**：在笑什么呀？\n**小白**：小白也来啦～'
            for char in raw:
                yield {'type': 'text', 'text': char}
                self.assertEqual(sent, [])
            yield {'type': 'done', 'finish_reason': 'stop'}
        async def emit(action):
            sent.append(action)
        with patch.object(conv, 'validate', return_value=resolved), patch.object(conv.openai, 'stream_chat', stream):
            result = asyncio.run(conv.reply(self.session, first['message_ids'], emit_action=emit))
        self.assertEqual([a['speaker'] for a in sent], resolved['character_ids'])
        self.assertEqual(result['actions'], sent)
        self.full_provider.assert_not_awaited()

    def test_signed_multi_role_paragraphs_keep_continuations_with_their_speaker(self):
        session = {'character_ids': ['a', 'b'], 'names': {'a': '甲', 'b': '乙'}}
        raw = '**甲**：第一段\n（又补一句）第二段\n\n**乙**：接话\n继续说完'
        actions = conv.parse_actions(conv.plain_dialogue_payload(raw, session), session, [])
        self.assertEqual(actions, [
            {'type': 'text', 'speaker': 'a', 'text': '第一段\n（又补一句）第二段'},
            {'type': 'text', 'speaker': 'b', 'text': '接话\n继续说完'}])
        for raw in ['无署名开头\n甲：你好', '甲：你好\n陌生人：不应该发送',
                    '甲：你好\n工具：正在调用']:
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                conv.plain_dialogue_payload(raw, session)

    def test_stream_multiline_signed_dialogue_with_tool_context_needs_no_paid_repair(self):
        first = self.inbound()
        resolved = {**self.session, 'character_ids': ['dashiyin', 'xiaoshiyin'],
                    'names': {'dashiyin': '芳月诗音', 'xiaoshiyin': '小诗音'}}
        raw = '**小诗音**：这回找到候选了。\n（又补一句）只有摘录。\n**芳月诗音**：那先核对版本。\n（点头）按来源来。'
        sent = []
        async def stream(*args, **kwargs):
            for char in raw:
                yield {'type': 'text', 'text': char}
                self.assertEqual(sent, [])
            yield {'type': 'done', 'finish_reason': 'stop'}
        async def emit(action):
            sent.append(action)
        with patch.object(conv, 'validate', return_value=resolved), patch.object(conv.openai, 'stream_chat', stream):
            result = asyncio.run(conv.reply(self.session, first['message_ids'],
                tool_context='已找到候选，只有短摘录及来源。', emit_action=emit))
        self.assertEqual([a['speaker'] for a in sent], ['xiaoshiyin', 'dashiyin'])
        self.assertIn('只有摘录', sent[0]['text'])
        self.assertEqual(result['actions'], sent)
        self.full_provider.assert_not_awaited()

    def test_wrapped_json_is_buffered_and_emitted_once(self):
        first = self.inbound()
        sent = []
        async def stream(*args, **kwargs):
            yield {'type': 'text', 'text': '```json\n' + json.dumps({'actions': [
                {'type': 'text', 'speaker': 'dashiyin', 'text': '在呀'}]}) + '\n```'}
            yield {'type': 'done', 'finish_reason': 'stop'}
        async def emit(action):
            sent.append(action)
        with patch.object(conv.openai, 'stream_chat', stream):
            result = asyncio.run(conv.reply(self.session, first['message_ids'], emit_action=emit))
        self.assertEqual(result['actions'], sent)
        self.assertEqual(len(sent), 1)
        self.full_provider.assert_not_awaited()

    def test_stream_compatibility_never_sends_broken_or_truncated_dialogue(self):
        first = self.inbound()
        async def run(raw, finish):
            sent = []
            async def stream(*args, **kwargs):
                yield {'type': 'text', 'text': raw}
                yield {'type': 'done', 'finish_reason': finish}
            async def emit(action):
                sent.append(action)
            with patch.object(conv.openai, 'stream_chat', stream):
                with self.assertRaises(HTTPException):
                    await conv.reply(self.session, first['message_ids'], emit_action=emit)
            self.assertEqual(sent, [])
        for raw, finish in [('{"actions":', 'stop'), ('<think>思考</think>你好', 'stop'),
                            ('陌生人：你好', 'stop'), ('普通台词', 'length')]:
            asyncio.run(run(raw, finish))
        self.full_provider.assert_not_awaited()

    def test_stream_emits_complete_bubble_before_the_rest_is_generated(self):
        first = self.inbound()
        action = {'type': 'text', 'speaker': 'dashiyin', 'text': '我在呀'}
        sent = []
        async def stream(*args, **kwargs):
            yield {'type': 'text', 'text': '{"actions":[' + json.dumps(action, ensure_ascii=False)}
            self.assertEqual(sent, [action])  # 未结束数组，更未生成摘要，气泡已经回调。
            yield {'type': 'text', 'text': '],"image_summaries":[]}'}
            yield {'type': 'done', 'finish_reason': 'stop'}
        async def emit(value):
            sent.append(value)
        with patch.object(conv.openai, 'stream_chat', stream):
            result = asyncio.run(conv.reply(self.session, first['message_ids'], emit_action=emit))
        self.assertEqual(result['actions'], [action])
        self.full_provider.assert_not_awaited()
        self.assertIn('first_text_seconds', result['timings'])

    def test_stream_failure_preserves_emitted_bubble_and_never_repairs_or_retries(self):
        first = self.inbound()
        sent = []
        async def stream(*args, **kwargs):
            yield {'type': 'text', 'text': '{"actions":[{"type":"text","speaker":"dashiyin","text":"先说一句"},'}
            yield {'type': 'error', 'status': 503}
        async def emit(value):
            sent.append(value)
        with patch.object(conv.openai, 'stream_chat', stream):
            with self.assertRaises(HTTPException):
                asyncio.run(conv.reply(self.session, first['message_ids'], emit_action=emit))
        self.assertEqual(len(sent), 1)
        self.full_provider.assert_not_awaited()

    def test_stream_route_yields_lease_action_and_completion(self):
        first = self.inbound()
        async def stream(*args, **kwargs):
            yield {'type': 'text', 'text': '{"actions":[{"type":"text","speaker":"dashiyin","text":"你好"}]}'}
            yield {'type': 'done', 'finish_reason': 'stop'}
        with patch.object(conv.openai, 'stream_chat', stream):
            response = self.client.post('/api/qq-bridge/reply-stream', json={
                'session': self.session, 'message_ids': first['message_ids']})
        self.assertEqual(response.status_code, 200)
        events = [json.loads(line) for line in response.text.splitlines()]
        self.assertEqual([e['type'] for e in events], ['session', 'action', 'done'])
        self.assertEqual(events[0]['coordination_id'], events[-1]['coordination_id'])

    def test_stream_rejects_unknown_speaker_and_does_not_emit_partial_object(self):
        first = self.inbound()
        async def run(raw):
            sent = []
            async def stream(*args, **kwargs):
                yield {'type': 'text', 'text': raw}
                yield {'type': 'done', 'finish_reason': 'length'}
            async def emit(action):
                sent.append(action)
            with patch.object(conv.openai, 'stream_chat', stream):
                with self.assertRaises(HTTPException):
                    await conv.reply(self.session, first['message_ids'], emit_action=emit)
            self.assertEqual(sent, [])
        asyncio.run(run('{"actions":[{"type":"text","speaker":"unknown","text":"坏角色"}]}'))
        asyncio.run(run('{"actions":[{"type":"text","speaker":"dashiyin","text":"半句'))

    def test_agent_plan_uses_trusted_config_and_counts_nested_requests(self):
        from app.services import exploration_projects as projects, exploration_workspace as workspace, exploration_budget as budget
        project = projects.propose(self.session['persona_id'], 'dashiyin', '工作室实验', '试试小工具')
        request = projects.request_more(project, self.session['persona_id'], 'dashiyin', '想调用agent')
        with patch.object(workspace, 'capability', return_value={'available': True, 'agent_available': True}):
            projects.approve(request, 50000, 2, ['document', 'codex'])
        self.inbound(text='PRIVATE-CHAT-NOT-FOR-AGENT')
        self.provider.return_value = json.dumps({'intent': 'agent', 'body': '做一个小实验'})

        async def execute(run_id, task, *, agent_cfg, agent='codex'):
            self.assertEqual(agent, 'codex')
            self.assertEqual(agent_cfg, self.cfg)
            self.assertEqual(task, '做一个小实验')
            for step in (1, 2):
                call = budget.reserve(run_id, step, [], 600)
                budget.settle(call, {'input_tokens': 100, 'output_tokens': 20})
            return {'output': '实际结果', 'exit_code': 0, 'exported': []}

        with patch.object(workspace, 'execute', side_effect=execute):
            response = self.client.post('/api/qq-bridge/proactive', json={'session': self.session, 'run_id': 'agent-planner'})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()['next_step'], 3)
        self.assertEqual(projects.listing()[0]['grants'][0]['charged'], 370)
        self.assertNotIn('PRIVATE-CHAT-NOT-FOR-AGENT', json.dumps(self.provider.await_args.args[0]))

    def test_project_request_is_persisted_without_a_grant_or_qq_send(self):
        from app.services import exploration_projects as projects
        self.provider.return_value = json.dumps({'intent': 'project', 'title': '鱼鱼观察日记', 'body': '看看AI同人创作'})
        response = self.client.post('/api/qq-bridge/proactive', json={'session': self.session, 'run_id': 'project-run'})
        self.assertEqual(response.status_code, 200, response.text)
        item = projects.listing()[0]
        self.provider.return_value = json.dumps({'intent': 'request_budget', 'project_id': item['id'], 'body': '好想把日记做完呀'})
        response = self.client.post('/api/qq-bridge/proactive', json={'session': self.session, 'run_id': 'project-run', 'step': 1})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(projects.listing()[0]['requests'][0]['state'], 'pending')
        self.assertEqual(projects.listing()[0]['grants'], [])
        self.assertEqual(db.list_messages(self.sid), [])

    def test_approved_project_can_write_only_its_workspace(self):
        from app.services import exploration_projects as projects, exploration_workspace as workspace
        project = projects.propose(self.session['persona_id'], 'dashiyin', '小作品', '写个日记')
        request = projects.request_more(project, self.session['persona_id'], 'dashiyin', '想继续')
        projects.approve(request, 12000, 2, ['document'])
        self.provider.return_value = json.dumps({'intent': 'write_file', 'path': 'notes/diary.md', 'body': '今天有点想大老大'})
        response = self.client.post('/api/qq-bridge/proactive', json={'session': self.session, 'run_id': 'workspace-run'})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(workspace.files(project)[0]['content'], '今天有点想大老大')
        self.assertEqual(projects.listing()[0]['grants'][0]['charged'], 130)

    def test_public_planner_cannot_see_or_create_private_projects(self):
        from app.services import exploration_projects as projects
        projects.propose(self.session['persona_id'], 'dashiyin', 'PRIVATE-PROJECT', 'PRIVATE-GOAL')
        db.set_feature_settings('qq_bridge', {'proactive.qzone': True})
        self.provider.return_value = json.dumps({'intent': 'project', 'title': '不应创建', 'body': '不应创建'})
        response = self.client.post('/api/qq-bridge/proactive', json={'session': self.session, 'channels': ['private', 'qzone']})
        self.assertEqual(response.status_code, 409)
        self.assertNotIn('PRIVATE-PROJECT', json.dumps(self.provider.await_args.args[0]))
        self.assertEqual(len(projects.listing()), 1)

    def test_project_web_read_has_no_private_chat_and_shares_only_actual_source(self):
        from app.services import exploration_projects as projects, exploration_web as web
        self.inbound(text='PRIVATE-CHAT-NOT-FOR-WORKSPACE')
        project = projects.propose(self.session['persona_id'], 'dashiyin', '同人观察', '找点公开创作')
        request = projects.request_more(project, self.session['persona_id'], 'dashiyin', '想继续')
        projects.approve(request, 12000, 2, ['document', 'web_read'])
        self.provider.return_value = json.dumps({'intent': 'web', 'url': 'https://example.com'})
        with patch.object(web, 'fetch', return_value={'url': 'https://example.com/article', 'text': '公开小故事', 'links': []}) as fetch:
            response = self.client.post('/api/qq-bridge/proactive', json={'session': self.session, 'run_id': 'web-project'})
        self.assertEqual(response.status_code, 200, response.text)
        fetch.assert_called_once_with('https://example.com')
        self.assertNotIn('PRIVATE-CHAT-NOT-FOR-WORKSPACE', json.dumps(self.provider.await_args.args[0]))
        self.provider.return_value = json.dumps({'intent': 'say', 'source_step': 0, 'actions': [
            {'type': 'text', 'speaker': 'dashiyin', 'text': '读到个有趣的小故事'}]})
        response = self.client.post('/api/qq-bridge/proactive', json={'session': self.session, 'run_id': 'web-project', 'step': 1})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()['actions'][0]['text'].endswith('https://example.com/article'))

    def test_forged_source_reference_is_not_shareable(self):
        self.provider.return_value = json.dumps({'intent': 'say', 'source_step': 4, 'actions': [
            {'type': 'text', 'speaker': 'dashiyin', 'text': '不应附上假来源'}]})
        response = self.client.post('/api/qq-bridge/proactive', json={'session': self.session})
        self.assertEqual(response.status_code, 502)

    def test_reply_deadline_cancels_generation_and_releases_lease_without_retry(self):
        source = self.inbound()
        entered = asyncio.Event()
        async def slow(*args, **kwargs):
            entered.set()
            await asyncio.sleep(10)
        self.full_provider.side_effect = slow
        original = asyncio.wait_for
        async def short_deadline(coro, timeout):
            self.assertEqual(timeout, 360)
            generation = asyncio.create_task(coro)
            try:
                # 等确实进入模型调用再触发超时，不把磁盘/上下文组装耗时当成模型耗时。
                await original(entered.wait(), 5)
                return await original(generation, .02)
            finally:
                if not generation.done():
                    generation.cancel()
                await asyncio.gather(generation, return_exceptions=True)
        with patch.object(qq_bridge.asyncio, 'wait_for', side_effect=short_deadline):
            response = self.client.post('/api/qq-bridge/reply', json={
                'session': self.session, 'message_ids': source['message_ids']})
        self.assertEqual(response.status_code, 504, response.text)
        self.assertIn('可能已计费', response.text)
        self.assertEqual(self.full_provider.await_count, 1)
        with db._tx() as c:
            self.assertEqual(c.execute('SELECT COUNT(*) FROM chat_leases').fetchone()[0], 0)
        self.assertEqual(len(db.list_messages(self.sid)), 1)

    def test_exploration_document_is_a_draft_and_continues_with_shared_budget(self):
        from app.services import exploration_budget as budget, activity_memory
        self.provider.side_effect = [json.dumps({'intent': 'document', 'title': '想要一个烘焙收藏夹',
            'body': '需求：按甜点分类收藏。边界：只写草稿，不安装插件。'}), json.dumps({'intent': 'skip'})]
        payload = {'session': self.session, 'run_id': 'draft-run'}
        first = self.client.post('/api/qq-bridge/proactive', json=payload)
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(first.json()['intent'], 'continue')
        second = self.client.post('/api/qq-bridge/proactive', json={**payload, 'step': first.json()['next_step']})
        self.assertEqual(second.status_code, 200, second.text)
        self.assertEqual(budget.status()['charged'], 260)
        docs = [a for a in budget.status()['artifacts'] if a['kind'] == 'document']
        self.assertEqual(json.loads(docs[0]['content'])['state'], 'draft')
        self.assertEqual(docs[0]['synced'], 1)
        events = activity_memory.records(self.session['persona_id'], source='qq_bridge')['items']
        self.assertEqual(events[0]['role'], 'activity')
        self.assertEqual(db.list_messages(self.sid), [])

    def test_exploration_consultant_uses_same_model_and_total_budget(self):
        from app.services import exploration_budget as budget
        self.provider.side_effect = [json.dumps({'intent': 'consult', 'question': '怎么整理烘焙收藏夹的需求？'}),
                                     '先列出分类和去重需求。', json.dumps({'intent': 'skip'})]
        first = self.client.post('/api/qq-bridge/proactive', json={'session': self.session, 'run_id': 'consult-run'})
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(first.json()['next_step'], 2)
        second = self.client.post('/api/qq-bridge/proactive', json={'session': self.session, 'run_id': 'consult-run', 'step': 2})
        self.assertEqual(second.status_code, 200, second.text)
        self.assertEqual(budget.status()['charged'], 390)
        self.assertEqual([call.kwargs['max_tokens'] for call in self.provider.await_args_list], [600, 400, 600])
        self.assertTrue(all(call.kwargs['model'] == 'fake' for call in self.provider.await_args_list))
        advisor = self.provider.await_args_list[1]
        self.assertNotIn('tools', advisor.kwargs)

    def test_exploration_unknown_usage_does_not_retry_or_return_a_share(self):
        self.full_provider.side_effect = None
        self.full_provider.return_value = {'content': json.dumps({'intent': 'say', 'actions': [
            {'type': 'text', 'speaker': 'dashiyin', 'text': '来找你玩'}]}), 'finish_reason': 'stop'}
        first = self.client.post('/api/qq-bridge/proactive', json={'session': self.session})
        second = self.client.post('/api/qq-bridge/proactive', json={'session': self.session})
        self.assertEqual(first.status_code, 409)
        self.assertEqual(second.status_code, 409)
        self.assertEqual(self.full_provider.await_count, 1)

    def test_public_share_never_receives_private_chat_or_memory(self):
        self.inbound(text='PRIVATE-CHAT-DO-NOT-PUBLISH')
        db.set_feature_settings('qq_bridge', {'proactive.qzone': True})
        self.provider.return_value = json.dumps({'intent': 'say', 'channel': 'qzone', 'actions': [
            {'type': 'text', 'speaker': 'dashiyin', 'text': '日子偶尔也需要一块小饼干。'}]})
        result = self.client.post('/api/qq-bridge/proactive', json={'session': self.session, 'channels': ['private', 'qzone']})
        self.assertEqual(result.status_code, 200, result.text)
        prompt = json.dumps(self.provider.await_args.args[0], ensure_ascii=False)
        self.assertNotIn('PRIVATE-CHAT-DO-NOT-PUBLISH', prompt)
        evidence = json.loads(self.provider.await_args.args[0][1]['content'].split('：', 1)[1])
        self.assertEqual(evidence['recent_private'], [])
        self.assertEqual(evidence['approved_private_memories'], [])
        self.assertNotIn('about', evidence['card'])

    def test_private_activity_uses_source_filtered_memory_without_embedding(self):
        from app.services import activity_memory, persona_memory
        self.inbound(text='DO-NOT-RECALL-THIS-SOURCE')
        activity_memory.set_policy(self.session['persona_id'], 'qq_bridge', {'recall': False})
        self.provider.return_value = '{"intent":"skip"}'
        with patch.object(persona_memory, 'injectable', return_value=([], set())) as recall:
            result = self.client.post('/api/qq-bridge/proactive', json={'session': self.session})
        self.assertEqual(result.status_code, 200, result.text)
        self.assertNotIn('DO-NOT-RECALL-THIS-SOURCE', json.dumps(self.provider.await_args.args[0]))
        self.assertFalse(recall.call_args.kwargs['allow_embeddings'])

    def test_unconfigured_public_channel_is_rejected(self):
        self.provider.return_value = json.dumps({'intent': 'say', 'channel': 'qzone', 'actions': [
            {'type': 'text', 'speaker': 'dashiyin', 'text': '感想'}]})
        result = self.client.post('/api/qq-bridge/proactive', json={'session': self.session, 'channels': ['private', 'qzone']})
        self.assertEqual(result.status_code, 502)

    def test_paused_memory_source_retains_draft_then_syncs_without_duplicates(self):
        from app.services import activity_memory, exploration_budget as budget
        activity_memory.set_policy(self.session['persona_id'], 'qq_bridge', {'receive': False})
        self.provider.return_value = json.dumps({'intent': 'document', 'title': '小想法', 'body': '想做一个分类表，暂不实现。'})
        result = self.client.post('/api/qq-bridge/proactive', json={'session': self.session, 'run_id': 'pending-draft'})
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(next(a for a in budget.status()['artifacts'] if a['kind'] == 'document')['synced'], 0)
        activity_memory.set_policy(self.session['persona_id'], 'qq_bridge', {'receive': True})
        self.client.get('/api/qq-bridge/exploration')
        self.client.get('/api/qq-bridge/exploration')
        events = activity_memory.records(self.session['persona_id'], source='qq_bridge')['items']
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]['event_id'], 'explore-pending-draft-0-document')

    def test_stopped_activity_can_resume_without_clearing_usage(self):
        self.client.post('/api/qq-bridge/exploration/stop')
        result = self.client.post('/api/qq-bridge/proactive', json={'session': self.session})
        self.assertEqual(result.status_code, 409)
        self.provider.assert_not_awaited()
        self.client.post('/api/qq-bridge/exploration/resume')
        self.provider.return_value = '{"intent":"skip"}'
        result = self.client.post('/api/qq-bridge/proactive', json={'session': self.session})
        self.assertEqual(result.status_code, 200, result.text)
        state = self.client.get('/api/qq-bridge/exploration').json()
        self.assertEqual(state['charged'], 130)

    def test_proactive_short_plan_does_not_create_fake_user_or_assistant(self):
        self.inbound(text='我去忙一会儿')
        self.provider.return_value = json.dumps({'intent': 'say', 'actions': [
            {'type': 'text', 'speaker': 'dashiyin', 'text': '有没有给我留小饼干呀'}]})
        result = self.client.post('/api/qq-bridge/proactive', json={'session': self.session})
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(len(db.list_messages(self.sid)), 1)
        prompt = json.dumps(self.provider.await_args.args[0], ensure_ascii=False)
        # The proactive planner stays focused on its existing activity rules;
        # enthusiasm is covered by QQ replies and the dedicated proactive prompt.
        self.assertIn('最多180字', prompt)
        self.assertEqual(self.provider.await_args.kwargs['max_tokens'], 600)

    def test_proactive_skip_and_browse_do_not_send_anything(self):
        for intent in ('skip', 'browse'):
            self.provider.return_value = json.dumps({'intent': intent})
            result = self.client.post('/api/qq-bridge/proactive', json={'session': self.session, 'can_browse': True})
            self.assertEqual(result.status_code, 200, result.text)
            self.assertEqual(result.json()['actions'], [])
        self.assertEqual(db.list_messages(self.sid), [])

    def test_proactive_video_only_accepts_real_candidate_and_appends_official_link(self):
        self.provider.return_value = json.dumps({'intent': 'say', 'video_id': 'BV1234567890', 'actions': [
            {'type': 'text', 'speaker': 'dashiyin', 'text': '刷到这个，感觉你会喜欢'}]})
        response = self.client.post('/api/qq-bridge/proactive', json={'session': self.session,
            'videos': [{'bvid': 'BV1234567890', 'title': '开源小工具', 'url': 'https://evil.invalid/'}]})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn('https://www.bilibili.com/video/BV1234567890', response.json()['actions'][0]['text'])
        response = self.client.post('/api/qq-bridge/proactive', json={'session': self.session, 'videos': []})
        self.assertEqual(response.status_code, 502)

    def test_proactive_rejects_arbitrary_links_long_text_and_recursive_browse(self):
        for obj in [
            {'intent': 'say', 'actions': [{'type': 'text', 'text': 'https://evil.invalid'}]},
            {'intent': 'say', 'actions': [{'type': 'text', 'text': '长' * 81}]},
            {'intent': 'browse'},
        ]:
            self.provider.return_value = json.dumps(obj)
            result = self.client.post('/api/qq-bridge/proactive', json={'session': self.session, 'videos': []})
            self.assertEqual(result.status_code, 502, result.text)

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        for obj, name, value in [(db, 'DATA_DIR', root), (db, 'DB_PATH', root / 'test.db'),
                                 (attachments, 'ATTACHMENTS_DIR', root / 'attachments')]:
            p = patch.object(obj, name, value); p.start(); self.addCleanup(p.stop)
        p = patch.dict('os.environ', {'PERSONAL_MEMORY_ROOT': str(root / 'memory')})
        p.start(); self.addCleanup(p.stop)
        db.init_db()
        self.session = conv.context('dashiyin')
        self.sid = self.session['session_id']
        image = io.BytesIO(); Image.new('RGB', (16, 16), 'red').save(image, 'PNG')
        self.url = attachments.save_image(self.sid, image.getvalue(), 'image/png')['orig']
        self.cfg = {'base_url': 'http://unused', 'model': 'fake', 'api_key': 'PRIVATE',
                    'needs_vision': True, 'vision_model': 'vision'}
        p = patch('app.routers.nest._effective_config', return_value=self.cfg)
        p.start(); self.addCleanup(p.stop)
        self.provider = AsyncMock(return_value=json.dumps({'actions': [
            {'type': 'text', 'speaker': 'dashiyin', 'text': '我在呀'}]}))
        p = patch.object(conv.openai, 'complete_chat', self.provider)
        p.start(); self.addCleanup(p.stop)
        async def complete_full(*args, **kwargs):
            return {'content': await self.provider(*args, **kwargs), 'finish_reason': 'stop',
                    'usage': {'prompt_tokens': 100, 'completion_tokens': 30, 'total_tokens': 130}}
        self.full_provider = AsyncMock(side_effect=complete_full)
        p = patch.object(conv.openai, 'complete_chat_full', self.full_provider)
        p.start(); self.addCleanup(p.stop)
        self.accessibility = AsyncMock(return_value='上游入口可达，生成通道状态未知')
        p = patch.object(conv, 'upstream_accessibility', self.accessibility)
        p.start(); self.addCleanup(p.stop)
        self.extract = AsyncMock(return_value={})
        p = patch('app.routers.session_chat.memory_extract.extract', self.extract)
        p.start(); self.addCleanup(p.stop)
        app = FastAPI(); app.include_router(qq_bridge.router, prefix='/api')
        self.client = TestClient(app); self.addCleanup(self.client.close)

    def inbound(self, rid='in-1', text='在吗', media=None, session=None):
        return conv.store(session or self.session, rid, 'user', text, media or [])

    def web_message(self, role='user', text='网页消息', image=''):
        return db.append_message(self.sid, role, text, image=image, web_sync=True)

    def test_web_sync_skips_history_qq_origin_and_other_sessions(self):
        from app.services.qq_web_sync import poll
        self.web_message(text='历史不发')
        self.assertIsNone(poll(self.session, 'bot', 'g:1')['item'])
        incoming = self.inbound(text='QQ 原文不回流')
        from app.services.qq_web_sync import enqueue
        with db._tx() as conn:
            enqueue(conn, incoming['message_ids'][0], self.sid)
        conv.store(self.session, 'delivered', 'assistant', 'QQ 已发送', [])
        row = self.web_message(image=self.url)
        assistant = self.web_message('assistant', '网页回复')
        result = poll(self.session, 'bot', 'g:1')['item']
        self.assertEqual(result['id'], row['id'])
        self.assertEqual(result['image'], self.url)
        self.assertEqual(poll(self.session, 'bot', 'g:1')['item'], result)
        next_item = poll(self.session, 'bot', 'g:1', result['sync_seq'])['item']
        self.assertEqual(next_item['id'], assistant['id'])
        self.assertIsNone(poll(self.session, 'bot', 'g:1', next_item['sync_seq'])['item'])
        self.assertIsNone(poll(self.session, 'bot', 'g:1', next_item['sync_seq'])['item'])
        self.assertIsNone(poll(self.session, 'otherbot', 'p:2')['item'])

    def test_web_sync_target_change_and_deleted_messages(self):
        from app.services.qq_web_sync import poll
        poll(self.session, 'bot', 'g:1')
        old = self.web_message()
        self.assertIsNone(poll(self.session, 'bot', 'p:2')['item'])
        deleted = self.web_message()
        db.delete_message(deleted['id'])
        current = self.web_message()
        result = poll(self.session, 'bot', 'p:2')['item']
        self.assertEqual(result['id'], current['id'])
        with self.assertRaises(HTTPException):
            poll(self.session, 'bot', 'p:2', result['sync_seq'] + 100)

    def test_qq_style_is_short_relational_and_does_not_change_web_default(self):
        first = self.inbound()
        asyncio.run(conv.reply(self.session, first['message_ids']))
        prompt = json.dumps(self.provider.await_args.args[0], ensure_ascii=False)
        self.assertNotIn('250～400', prompt)
        self.assertIn('约10～60', prompt)
        self.assertIn('不逐标点机械拆分', prompt)
        self.assertIn('大老大欢迎你自然亲近、热情接话', prompt)
        self.assertIn('避免把‘不吵你’‘算了算了’', prompt)
        self.assertIn('不虚构共同经历', prompt)
        self.assertIn('不要求每位角色都发言', prompt)
        self.assertIn('按内容充分回应', prompt)
        from app.services.prompt.assembler import DEFAULT_REPLY_STYLE
        self.assertIn('250～400', DEFAULT_REPLY_STYLE)
        self.assertGreaterEqual(self.provider.await_args.kwargs['max_tokens'], 4096)

    def test_receipts_are_idempotent_and_content_conflicts_rejected(self):
        first = self.inbound(media=[{'type': 'sticker', 'url': self.url}])
        again = self.inbound(media=[{'type': 'sticker', 'url': self.url}])
        self.assertEqual(first, again)
        rows = db.list_messages(self.sid)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['image'], self.url)
        with self.assertRaises(HTTPException) as error:
            self.inbound(text='另一条')
        self.assertEqual(error.exception.status_code, 409)
        with db._tx() as conn:
            conn.execute('DELETE FROM messages WHERE id=?', (first['message_ids'][0],))
        with self.assertRaises(HTTPException):
            self.inbound(media=[{'type': 'sticker', 'url': self.url}])
        self.assertEqual(db.list_messages(self.sid), [])

    def test_generation_does_not_save_unsent_reply_or_consume_later_input(self):
        first = self.inbound(text='第一段')
        self.inbound('in-2', '后来补充')
        result = asyncio.run(conv.reply(self.session, first['message_ids']))
        self.assertEqual(result['actions'][0]['text'], '我在呀')
        prompt = json.dumps(self.provider.await_args.args[0], ensure_ascii=False)
        self.assertIn('第一段', prompt)
        self.assertNotIn('后来补充', prompt)
        self.assertEqual([r['role'] for r in db.list_messages(self.sid)], ['user', 'user'])

    def test_delivered_image_and_previous_user_image_remain_visible(self):
        self.inbound(media=[{'type': 'image', 'url': self.url}])
        conv.store(self.session, 'out-1', 'assistant', '[表情：比心]',
                   [{'type': 'sticker', 'url': self.url}], speaker='dashiyin')
        last = self.inbound('in-2', '刚才那张是什么意思')
        asyncio.run(conv.reply(self.session, last['message_ids']))
        prompt = self.provider.await_args.args[0]
        rendered = json.dumps(prompt, ensure_ascii=False)
        self.assertIn('助手已经实际发出的表情', rendered)
        images = [part for m in prompt if isinstance(m['content'], list)
                  for part in m['content'] if part['type'] == 'image_url']
        self.assertEqual(len(images), 1)
        self.assertTrue(all(p['image_url']['url'].startswith('data:image/') for p in images))

    def test_unknown_sticker_never_turns_into_random_image(self):
        raw = json.dumps({'actions': [{'type': 'text', 'text': '好呀'},
             {'type': 'sticker', 'sticker_id': 'imaginary'}]})
        actions = conv.parse_actions(raw, self.session, [])
        self.assertEqual(len(actions), 1)
        item = stickers.entry(self.url)
        stickers.save(item['id'], '比心', ['喜欢'])
        candidate = stickers.entry(self.url)
        raw = json.dumps({'actions': [{'type': 'text', 'text': '喜欢你'},
             {'type': 'sticker', 'sticker_id': item['id']}, {'type': 'text', 'text': '嘿嘿'}]})
        actions = conv.parse_actions(raw, self.session, [candidate])
        self.assertEqual([a['type'] for a in actions], ['text', 'sticker', 'text'])
        self.assertEqual(actions[1]['url'], self.url)
        candidate['emotions'] = []
        self.assertEqual(len(conv.parse_actions(raw, self.session, [candidate])), 2)

    def test_bad_model_output_is_not_sent_or_saved(self):
        source = self.inbound()
        self.provider.return_value = 'PRIVATE upstream error, not JSON'
        result = self.client.post('/api/qq-bridge/reply', json={
            'session': self.session, 'message_ids': source['message_ids']})
        self.assertEqual(result.status_code, 502)
        self.assertNotIn('PRIVATE', result.text)
        self.assertIn('JSON', result.json()['detail'])
        self.assertIn('阶段 format_repair', result.json()['detail'])
        self.assertEqual(len(db.list_messages(self.sid)), 1)

    def test_upstream_errors_have_safe_actionable_diagnostics(self):
        source = self.inbound()
        for error, expected in [
            (RuntimeError('上游 401: PRIVATE'), 'API 密钥无效'),
            (RuntimeError('上游 400: PRIVATE PROHIBITED_CONTENT'), '内容审核拦截'),
            (conv.httpx.ReadTimeout('PRIVATE'), '等待上游回复超时'),
            (conv.httpx.ReadError('PRIVATE'), '读取上游回复时连接中断'),
            (conv.httpx.ConnectTimeout('PRIVATE'), '连接上游超时'),
            (conv.httpx.RemoteProtocolError('PRIVATE'), '上游响应连接或协议异常'),
        ]:
            with self.subTest(expected=expected):
                self.provider.side_effect = error
                response = self.client.post('/api/qq-bridge/reply', json={
                    'session': self.session, 'message_ids': source['message_ids']})
                self.assertEqual(response.status_code, 502)
                self.assertIn(expected, response.json()['detail'])
                self.assertIn('阶段 upstream', response.json()['detail'])
                self.assertNotIn('PRIVATE', response.text)
        self.assertEqual(len(db.list_messages(self.sid)), 1)

    def test_truncated_and_filtered_outputs_are_diagnosed(self):
        source = self.inbound()
        self.full_provider.side_effect = None
        for finish, expected in [('length', '长度上限'), ('content_filter', '内容审核拦截'), ('stop', '空正文')]:
            self.full_provider.return_value = {'content': '', 'finish_reason': finish}
            response = self.client.post('/api/qq-bridge/reply', json={
                'session': self.session, 'message_ids': source['message_ids']})
            self.assertEqual(response.status_code, 502)
            self.assertIn(expected, response.json()['detail'])

    def test_group_prompt_has_one_output_format_and_names_are_normalized(self):
        db.set_settings({'group_roster': '["dashiyin","xiaobai"]'})
        session = conv.context('group')
        source = self.inbound(session=session)
        self.provider.return_value = json.dumps({'actions': [
            {'type': 'text', 'speaker': session['names']['dashiyin'], 'text': '在呀'}]})
        result = asyncio.run(conv.reply(session, source['message_ids']))
        self.assertEqual(result['actions'][0]['speaker'], 'dashiyin')
        system = self.provider.await_args.args[0][0]['content']
        self.assertNotIn('先另起一行写「**角色名**：」', system)
        self.assertIn('角色ID与名称', system)
        self.assertIn('欢迎你自然亲近、热情接话', system)
        self.assertIn('避免把‘不吵你’‘算了算了’', system)
        with self.assertRaisesRegex(ValueError, 'speaker'):
            conv.parse_actions(json.dumps({'actions': [
                {'type': 'text', 'speaker': '陌生人', 'text': '在呀'}]}), session, [])

    def test_wrapped_json_is_recovered_without_sending_thinking(self):
        payload = json.dumps({'actions': [{'type': 'text', 'speaker': 'dashiyin', 'text': '我在呀'}]})
        for raw in ['以下是回复：\n```json\n' + payload + '\n```',
                    '<think>内部分析 {"actions":[]}</think>\n' + payload]:
            actions = conv.parse_actions(raw, self.session, [])
            self.assertEqual(actions[0]['text'], '我在呀')
        for raw in ['<think>没有闭合' + payload, payload + '\n' + payload]:
            with self.assertRaises(ValueError):
                conv.parse_actions(raw, self.session, [])

    def test_plain_dialogue_gets_one_validated_format_repair(self):
        source = self.inbound()
        self.full_provider.side_effect = [
            {'content': '**大诗音**：我在呀', 'finish_reason': 'stop'},
            {'content': json.dumps({'actions': [
                {'type': 'text', 'speaker': 'dashiyin', 'text': '我在呀'}]}), 'finish_reason': 'stop'},
        ]
        result = asyncio.run(conv.reply(self.session, source['message_ids']))
        self.assertEqual(result['actions'][0]['text'], '我在呀')
        self.assertEqual(self.full_provider.await_count, 2)
        first, repair = self.full_provider.await_args_list
        self.assertEqual(first.kwargs['response_format'], {'type': 'json_object'})
        self.assertEqual(len(repair.args[0]), 2)
        self.assertIn('格式转换器', repair.args[0][0]['content'])
        self.assertEqual(len(db.list_messages(self.sid)), 1)

    def test_json_mode_unsupported_falls_back_but_auth_errors_do_not(self):
        source = self.inbound()
        self.full_provider.side_effect = [RuntimeError('上游 400: response_format not supported'),
            {'content': '{"actions":[{"type":"text","speaker":"dashiyin","text":"在呀"}]}', 'finish_reason': 'stop'}]
        asyncio.run(conv.reply(self.session, source['message_ids']))
        self.assertNotIn('response_format', self.full_provider.await_args.kwargs)
        self.full_provider.reset_mock()
        self.full_provider.side_effect = RuntimeError('上游 401: PRIVATE')
        with self.assertRaises(HTTPException):
            asyncio.run(conv.reply(self.session, source['message_ids']))
        self.assertEqual(self.full_provider.await_count, 1)

    def test_invalid_repair_is_not_sent_and_does_not_loop(self):
        source = self.inbound()
        self.full_provider.side_effect = [
            {'content': '普通文本', 'finish_reason': 'stop'},
            {'content': '{"actions":[{"type":"text","speaker":"unknown","text":"错误角色"}]}', 'finish_reason': 'stop'}]
        with self.assertRaises(HTTPException) as error:
            asyncio.run(conv.reply(self.session, source['message_ids']))
        self.assertIn('format_repair', error.exception.detail)
        self.assertEqual(self.full_provider.await_count, 2)
        self.assertEqual(len(db.list_messages(self.sid)), 1)

    def test_group_members_switch_and_actual_speaker_is_saved(self):
        db.set_settings({'group_roster': '["dashiyin"]'})
        session = conv.context('group')
        self.assertEqual(session['character_ids'], ['dashiyin'])
        db.set_settings({'group_roster': '["xiaobai"]'})
        with self.assertRaises(HTTPException):
            conv.validate(session)
        # 原阵容已实际说出口的回执仍归原阵容。
        conv.store(session, 'out-1', 'assistant', '我在', [], speaker='dashiyin')
        row = db.list_messages(session['session_id'])[-1]
        self.assertEqual(row['segments'][0]['speaker'], '大诗音')

    def test_follow_active_identity_and_other_session_sources_rejected(self):
        with patch.object(db, 'get_active_persona_id', return_value='another-person'):
            with self.assertRaises(HTTPException):
                conv.validate(self.session)
        source = self.inbound()
        other = conv.context('xiaobai')
        with self.assertRaises(HTTPException):
            conv.history(other, source['message_ids'])

    def test_finish_uses_current_daily_workflow_and_shared_namespace(self):
        self.inbound()
        from app.services import memory_batch
        with patch.object(memory_batch, 'QUIET_SECONDS', 0), patch.object(memory_batch, 'MAX_SECONDS', 0):
            response = self.client.post('/api/qq-bridge/finish', json={'session': self.session})
        self.assertEqual(response.status_code, 200, response.text)
        args = self.extract.await_args.kwargs
        self.assertEqual(args['session_id'], self.sid)
        self.assertEqual(args['persona_id'], self.session['persona_id'])
        self.assertEqual(args['feature_id'], '')
        self.assertEqual(args['character_ids'], ['dashiyin'])

    def test_catalog_deduplicates_content_and_ignores_deleted_images(self):
        rows = stickers.catalog([self.url, self.url, '/api/files/missing/orig/x.png'])
        self.assertEqual(len(rows), 1)
        attachments._resolve_local(self.url).unlink()
        self.assertEqual(stickers.catalog([self.url]), [])

    def test_same_image_across_sessions_and_encodings_has_one_library_entry(self):
        other = io.BytesIO(); Image.new('RGB', (16, 16), 'red').save(other, 'PNG', compress_level=0)
        url = attachments.save_image('other-session', other.getvalue(), 'image/png')['orig']
        self.assertNotEqual(self.url, url)
        self.assertEqual(stickers.deduplicate([self.url, url]), [self.url])
        self.assertEqual(len(stickers.catalog([self.url, url])), 1)

    def test_repeat_upload_reuses_collected_original_across_sessions(self):
        import base64
        db.set_feature_settings('qq_bridge', {'sticker.library': [self.url]})
        raw = attachments._resolve_local(self.url).read_bytes()
        result = self.client.post('/api/qq-bridge/attachments', json={
            'session_id': 'another-session', 'data': base64.b64encode(raw).decode(),
            'mime': 'image/png', 'source': 'sticker'})
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(result.json()['orig'], self.url)
        self.assertTrue(result.json()['deduped'])
        self.assertFalse((attachments.ATTACHMENTS_DIR / 'another-session').exists())

    def test_visual_annotation_once_no_embedding_and_manual_wins(self):
        self.provider.return_value = '{"description":"双手比心，眼睛发亮","emotions":["喜欢","开心"]}'
        with patch('app.services.embedding.embed_text', create=True, side_effect=AssertionError('no embedding')):
            item = asyncio.run(stickers.describe(self.url))
            self.assertEqual(item['emotions'], ['开心', '喜欢'])
            asyncio.run(stickers.describe(self.url))
            self.assertEqual(self.provider.await_count, 1)
            stickers.save(item['id'], '手动修订的比心', ['喜欢'])
            asyncio.run(stickers.describe(self.url, force=True))
            self.assertEqual(stickers.entry(self.url)['description'], '手动修订的比心')
        self.assertEqual(db.list_messages(self.sid), [])

    def test_annotation_failure_is_not_retried_automatically(self):
        self.provider.side_effect = RuntimeError('PRIVATE upstream')
        self.assertEqual(asyncio.run(stickers.describe(self.url))['status'], 'error')
        item = asyncio.run(stickers.describe(self.url))
        self.assertEqual(self.provider.await_count, 1)
        self.assertNotIn('PRIVATE', item['detail'])

    def test_animated_sticker_reads_beginning_middle_end(self):
        frames = [Image.new('RGB', (20, 20), color) for color in ['red', 'green', 'blue']]
        output = io.BytesIO()
        frames[0].save(output, 'GIF', save_all=True, append_images=frames[1:], duration=100, loop=0)
        url = attachments.save_image(self.sid, output.getvalue(), 'image/gif')['orig']
        samples = stickers.keyframes(url)
        self.assertEqual(len(samples), 3)
        self.assertEqual(len(set(samples)), 3)

    def test_visual_history_is_bounded_to_recent_evidence(self):
        for i in range(12):
            last = self.inbound('in-' + str(i), '图片' + str(i), [{'type': 'image', 'url': self.url}])
        asyncio.run(conv.reply(self.session, last['message_ids']))
        images = [part for m in self.provider.await_args.args[0] if isinstance(m['content'], list)
                  for part in m['content'] if part['type'] == 'image_url']
        self.assertEqual(len(images), 1)

    def test_old_image_is_replaced_with_position_hint(self):
        self.inbound(media=[{'type': 'image', 'url': self.url}])
        for i in range(9):
            last = self.inbound('text-' + str(i), '后续文字')
        asyncio.run(conv.reply(self.session, last['message_ids']))
        prompt = self.provider.await_args.args[0]
        self.assertFalse(any(isinstance(m['content'], list) for m in prompt))
        self.assertIn('较早图片未重新附带', json.dumps(prompt, ensure_ascii=False))

    def test_known_sticker_reuses_labels_and_explicit_review_keeps_pixels(self):
        db.set_feature_settings('qq_bridge', {'sticker.library': [self.url]})
        item = stickers.entry(self.url)
        stickers.save(item['id'], '开心地比心', ['喜欢'])
        self.inbound(media=[{'type': 'image', 'url': self.url}])
        last = self.inbound('text-next', '嘿嘿')
        asyncio.run(conv.reply(self.session, last['message_ids']))
        prompt = self.provider.await_args.args[0]
        self.assertFalse(any(isinstance(m['content'], list) for m in prompt))
        self.assertIn('历史表情：开心地比心；情绪：喜欢', json.dumps(prompt, ensure_ascii=False))
        last = self.inbound('image-again', media=[{'type': 'image', 'url': self.url}])
        asyncio.run(conv.reply(self.session, last['message_ids']))
        self.assertFalse(any(isinstance(m['content'], list) for m in self.provider.await_args.args[0]))
        last = self.inbound('review-again', '再看看', media=[{'type': 'image', 'url': self.url}])
        asyncio.run(conv.reply(self.session, last['message_ids']))
        images = [p for m in self.provider.await_args.args[0] if isinstance(m['content'], list)
                  for p in m['content'] if p['type'] == 'image_url']
        self.assertEqual(len(images), 1)

    def test_ten_images_reach_model_and_raw_video_never_does(self):
        video = f'/api/files/{self.sid}/orig/movie.mp4'
        (attachments.ATTACHMENTS_DIR / self.sid / 'orig/movie.mp4').write_bytes(b'original video bytes')
        urls = []
        for i in range(10):
            output = io.BytesIO()
            Image.new('RGB', (16, 16), (i * 20, 30, 60)).save(output, 'PNG')
            urls.append(attachments.save_image(self.sid, output.getvalue(), 'image/png')['orig'])
        result = self.inbound(media=[{'type': 'image', 'url': url} for url in urls] +
            [{'type': 'video', 'url': video, 'frames': []}])
        asyncio.run(conv.reply(self.session, result['message_ids']))
        parts = [p for m in self.provider.await_args.args[0] if isinstance(m['content'], list)
                 for p in m['content'] if p['type'] != 'text']
        self.assertEqual(len(parts), 10)
        self.assertTrue(all(p['type'] == 'image_url' and p['image_url']['url'].startswith('data:image/') for p in parts))
        self.assertNotIn('movie.mp4', json.dumps(self.provider.await_args.args[0]))

    def test_image_summary_is_saved_and_reused_without_extra_model_call(self):
        from app.services import qq_media_context as media_context
        import re
        async def describe(messages, **kwargs):
            ids = list(dict.fromkeys(re.findall(r'img-[a-f0-9]{24}', json.dumps(messages))))
            return json.dumps({'actions': [{'type': 'text', 'speaker': 'dashiyin', 'text': '小猫好可爱'}],
                               'image_summaries': [{'image_id': i, 'summary': '白猫捂脸，显得害羞；无可辨认文字。'} for i in ids]})
        self.provider.side_effect = describe
        first = self.inbound(media=[{'type': 'image', 'url': self.url}])
        result = asyncio.run(conv.reply(self.session, first['message_ids']))
        self.assertEqual(result['media_summaries_saved'], 1)
        self.assertEqual(self.full_provider.await_count, 1)
        key = media_context.digest(self.url)
        # load 打开新数据库连接，不依赖上一轮内存对象。
        self.assertIn('白猫捂脸', media_context.load(self.session)[key])
        last = self.inbound('next', '它好害羞')
        asyncio.run(conv.reply(self.session, last['message_ids']))
        prompt = self.provider.await_args.args[0]
        self.assertFalse(any(isinstance(m['content'], list) for m in prompt))
        self.assertIn('白猫捂脸', json.dumps(prompt, ensure_ascii=False))
        self.assertEqual(self.full_provider.await_count, 2)
        self.assertNotIn(key, media_context.load({**self.session, 'persona_id': 'other-person'}))
        self.assertNotIn(key, media_context.load({**self.session, 'session_id': 'other-session'}))

    def test_explicit_review_resends_even_an_old_image_and_updates_summary(self):
        from app.services import qq_media_context as media_context
        key = media_context.digest(self.url)
        image_id = 'img-' + key[:24]
        self.inbound(media=[{'type': 'image', 'url': self.url}])
        media_context.save(self.session, [{'image_id': image_id, 'summary': '原来的摘要'}], {image_id: key}, 'vision')
        for i in range(9):
            self.inbound('filler-' + str(i), '后续文字')
        last = self.inbound('review', '再看看刚才图片上的文字')
        self.provider.return_value = json.dumps({'actions': [{'type': 'text', 'speaker': 'dashiyin', 'text': '写着你好'}],
            'image_summaries': [{'image_id': image_id, 'summary': '关键文字为“你好”。'}]})
        asyncio.run(conv.reply(self.session, last['message_ids']))
        images = [p for m in self.provider.await_args.args[0] if isinstance(m['content'], list)
                  for p in m['content'] if p['type'] == 'image_url']
        self.assertEqual(len(images), 1)
        self.assertIn('关键文字', media_context.load(self.session)[key])

    def test_missing_or_forged_summary_does_not_trigger_repeated_vision(self):
        from app.services import qq_media_context as media_context
        first = self.inbound(media=[{'type': 'image', 'url': self.url}])
        self.provider.return_value = json.dumps({'actions': [{'type': 'text', 'speaker': 'dashiyin', 'text': '在呢'}],
            'image_summaries': [{'image_id': 'not-an-attached-image', 'summary': '伪造'}]})
        result = asyncio.run(conv.reply(self.session, first['message_ids']))
        self.assertEqual(result['media_summaries_saved'], 0)
        self.assertEqual(list(media_context.load(self.session).values()), [''])
        last = self.inbound('next', '嗯嗯')
        asyncio.run(conv.reply(self.session, last['message_ids']))
        prompt = self.provider.await_args.args[0]
        self.assertFalse(any(isinstance(m['content'], list) for m in prompt))
        self.assertIn('模型未返回画面摘要', json.dumps(prompt, ensure_ascii=False))
        self.assertNotIn('伪造', json.dumps(prompt, ensure_ascii=False))

    def test_summary_survives_failed_review_and_is_deleted_with_last_reference(self):
        from app.services import qq_media_context as media_context, cleanup
        key = media_context.digest(self.url)
        image_id = 'img-' + key[:24]
        first = self.inbound(media=[{'type': 'image', 'url': self.url}])
        second = self.inbound('second', media=[{'type': 'image', 'url': self.url}])
        media_context.save(self.session, [{'image_id': image_id, 'summary': '原摘要'}], {image_id: key}, 'vision')
        media_context.save(self.session, None, {image_id: key}, 'vision')
        self.assertEqual(media_context.load(self.session)[key], '原摘要')
        cleanup.delete_messages(first['message_ids'])
        self.assertIn(key, media_context.load(self.session))
        cleanup.delete_messages(second['message_ids'])
        self.assertNotIn(key, media_context.load(self.session))

    def test_format_repair_cannot_invent_visual_summaries_or_cause_reupload(self):
        from app.services import qq_media_context as media_context
        key = media_context.digest(self.url)
        image_id = 'img-' + key[:24]
        first = self.inbound(media=[{'type': 'image', 'url': self.url}])
        self.provider.side_effect = ['普通文字回复', json.dumps({
            'actions': [{'type': 'text', 'speaker': 'dashiyin', 'text': '普通文字回复'}],
            'image_summaries': [{'image_id': image_id, 'summary': '转换器根本没看过图片，不能采信'}]})]
        asyncio.run(conv.reply(self.session, first['message_ids']))
        self.assertEqual(media_context.load(self.session)[key], '')
        self.provider.side_effect = None
        last = self.inbound('next', '嗯')
        asyncio.run(conv.reply(self.session, last['message_ids']))
        self.assertFalse(any(isinstance(m['content'], list) for m in self.provider.await_args.args[0]))

    def test_identical_bytes_at_different_urls_share_one_visual_and_summary(self):
        from app.services import qq_media_context as media_context
        other = attachments.save_image('another-location', attachments._resolve_local(self.url).read_bytes(), 'image/png')['orig']
        first = self.inbound(media=[{'type': 'image', 'url': self.url}, {'type': 'image', 'url': other}])
        result = asyncio.run(conv.reply(self.session, first['message_ids']))
        self.assertEqual(result['media_images_attached'], 1)
        key = media_context.digest(self.url)
        self.assertEqual(media_context.digest(other), key)
        last = self.inbound('again', media=[{'type': 'image', 'url': other}])
        result = asyncio.run(conv.reply(self.session, last['message_ids']))
        self.assertEqual(result['media_images_attached'], 0)

    def test_edited_sticker_label_overrides_an_older_automatic_summary(self):
        from app.services import qq_media_context as media_context
        key = media_context.digest(self.url)
        media_context.save(self.session, [{'image_id': 'img', 'summary': '旧的自动猜测'}], {'img': key}, 'vision')
        item = stickers.entry(self.url)
        stickers.save(item['id'], '手动校正为开心比心', ['喜欢'])
        first = self.inbound(media=[{'type': 'image', 'url': self.url}])
        asyncio.run(conv.reply(self.session, first['message_ids']))
        prompt = json.dumps(self.provider.await_args.args[0], ensure_ascii=False)
        self.assertIn('手动校正为开心比心', prompt)
        self.assertNotIn('旧的自动猜测', prompt)

    def test_provider_omitting_finish_reason_still_persists_valid_summary(self):
        from app.services import qq_media_context as media_context
        key = media_context.digest(self.url)
        self.full_provider.side_effect = None
        self.full_provider.return_value = {'content': json.dumps({
            'actions': [{'type': 'text', 'speaker': 'dashiyin', 'text': '在呢'}],
            'image_summaries': [{'image_id': 'img-' + key[:24], 'summary': '白猫眯眼笑。'}]})}
        first = self.inbound(media=[{'type': 'image', 'url': self.url}])
        result = asyncio.run(conv.reply(self.session, first['message_ids']))
        self.assertEqual(result['media_summaries_saved'], 1)

    def test_upstream_failure_reports_read_only_accessibility_without_generation_retry(self):
        import httpx
        first = self.inbound()
        self.full_provider.side_effect = httpx.ReadTimeout('PRIVATE')
        with self.assertRaises(HTTPException) as exc:
            asyncio.run(conv.reply(self.session, first['message_ids']))
        self.assertIn('上游入口可达', exc.exception.detail)
        self.assertNotIn('PRIVATE', exc.exception.detail)
        self.accessibility.assert_awaited_once()
        self.assertEqual(self.full_provider.await_count, 1)

    def test_inbound_rejects_more_than_ten_images_or_one_video(self):
        for kind, count in [('image', 11), ('video', 2)]:
            with self.assertRaises(HTTPException) as failure:
                self.inbound(media=[{'type': kind, 'url': self.url}] * count)
            self.assertEqual(failure.exception.status_code, 422)
        self.assertEqual(db.list_messages(self.sid), [])

    def test_multimedia_input_preserves_order_and_video_frames(self):
        result = self.inbound(media=[{'type': 'image', 'url': self.url},
            {'type': 'video', 'url': self.url, 'frames': [self.url]}])
        rows = db.list_messages(self.sid)
        self.assertEqual([r['id'] for r in rows], result['message_ids'])
        self.assertEqual([r['content'] for r in rows], ['在吗', ''])
        self.assertEqual(rows[1]['frames'], [self.url])
        self.assertEqual(rows[1]['image_source'], 'video')


if __name__ == '__main__':
    unittest.main()
