"""Offline tests of persistent life, account isolation and conversation observation."""
import json
import time
import unittest
from unittest.mock import AsyncMock, patch
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from app import db
from app.routers import exploration_projects as api, qq_bridge
from app.services import exploration_autonomy as life, exploration_threads as threads
from app.services import exploration_conversations as chats, exploration_budget as budget
from app.services import qq_conversation, qq_proactive, exploration_wallet as wallet, exploration_outbox as outbox
from tests import test_exploration_autonomy as old, test_exploration_budget as fixture


class LifeTests(unittest.IsolatedAsyncioTestCase):
    setUp = fixture.BudgetTests.setUp
    fund = old.AutonomyTests.fund

    def enable(self, **values):
        life.configure({'enabled': True, 'continuous': True, 'continuation_minutes': 1,
                        'run_tokens': 12000, 'day_tokens': 24000, **values})

    async def test_provider_balance_keeps_source_page_without_changing_spending_caps(self):
        self.fund(100000); self.enable(run_tokens=1000, day_tokens=200000)
        wallet.save('dalaoda', 'dashiyin', 'https://wallet.invalid/v1', 'own-model', '', 0, True, provider_balance=True)
        budget.artifact('run', -1, 'identity', {'speaker': 'dashiyin', 'autonomous': True, 'channels': ['private']})
        wallet.configuration('run', {})
        source = '源代码' * 1000
        tool = qq_proactive.compact_artifact({'kind': 'reference', 'step': 0,
            'content': json.dumps({'path': 'frontend/src/example.ts', 'offset': 0, 'content': source, 'next_offset': None})})
        self.assertEqual(tool['content']['content'], source)
        messages = qq_proactive.fit_context('run', '规则' * 500, {'previous': [tool]})
        payload = json.loads(messages[1]['content'].split('：', 1)[1])
        self.assertEqual(payload['previous'][0]['content']['content'], source)
        self.assertEqual(budget.limits()[0], 1000)
        self.provider.assert_not_awaited()

    async def test_read_main_source_and_save_verified_personal_note_without_project_grant(self):
        from app.services import exploration_workspace as workspace, exploration_memory as personal
        self.fund(100000); self.enable(run_tokens=50000, day_tokens=200000)
        source = db.DATA_DIR/'source'; (source/'frontend/src').mkdir(parents=True)
        original = 'export const welcome = "hello"'
        (source/'frontend/src/example.ts').write_text(original, encoding='utf-8')
        selected = life.claim()
        plans = [
            {'intent': 'reference', 'path': 'frontend/src/example.ts'},
            {'intent': 'personal_docs', 'operation': 'write', 'path': 'docs/observation.md', 'body': '读取example.ts，发现welcome常量。未执行代码。'},
            {'intent': 'personal_docs', 'operation': 'read', 'path': 'docs/observation.md'},
            {'intent': 'say', 'continue_work': True, 'next_interest': '', 'actions': [
                {'type': 'text', 'speaker': 'dashiyin', 'text': '读了源码并写下观察，文件已读回核对，未执行代码。'}]}]
        self.provider.side_effect = [{'content': json.dumps(p), 'finish_reason': 'stop',
            'usage': {'prompt_tokens': 100, 'completion_tokens': 20, 'total_tokens': 120}} for p in plans]
        with patch.object(workspace, 'REPO', source), patch('app.routers.nest._effective_config', return_value={}), patch.object(budget, 'sync_pending'), patch.object(budget, 'sync_activity'):
            await life.explore(*selected)
        self.assertEqual((source/'frontend/src/example.ts').read_text(encoding='utf-8'), original)
        self.assertIn('未执行代码', personal.document(personal.space('dalaoda','dashiyin'), {'path': 'docs/observation.md'})['content'])
        with db._tx() as c:
            self.assertEqual(c.execute('SELECT COUNT(*) FROM exploration_grants').fetchone()[0], 0)
            rows = c.execute("SELECT content FROM exploration_artifacts WHERE run_id=? AND kind='personal_docs' ORDER BY step", (selected[1],)).fetchall()
            self.assertEqual([json.loads(r[0])['written'] for r in rows], [True, False])
        self.assertEqual(threads.listing()[0]['state'], 'ready')

    async def test_denied_project_tool_does_not_silence_owner_reply(self):
        self.fund(50000); self.enable(run_tokens=30000, day_tokens=60000)
        selected = life.claim()
        denied = json.dumps({'intent': 'read_file', 'path': 'docs/hand-off.md'})
        reply = json.dumps({'intent': 'say', 'channel': 'private', 'actions': [
            {'type': 'text', 'speaker': 'dashiyin', 'text': '在呢，项目工具还未批准，我可以先和你说说。'}]})
        self.provider.side_effect = [
            {'content': content, 'finish_reason': 'stop',
             'usage': {'prompt_tokens': 100, 'completion_tokens': 20, 'total_tokens': 120}}
            for content in (denied, reply)]
        with patch('app.routers.nest._effective_config', return_value={}), patch.object(budget, 'sync_pending'), patch.object(budget, 'sync_activity'), patch('app.services.exploration_workspace.files') as files:
            await life.explore(*selected)
        files.assert_not_called()
        self.assertEqual(self.provider.await_count, 2)
        self.assertEqual(threads.listing()[0]['state'], 'ready')
        with db._tx() as c:
            item = c.execute("SELECT content FROM exploration_artifacts WHERE run_id=? AND kind='read_file'", (selected[1],)).fetchone()
            self.assertFalse(json.loads(item[0])['executed'])
            message = c.execute("SELECT content FROM messages WHERE session_id='sandbox-dashiyin' AND role='assistant' ORDER BY rowid DESC LIMIT 1").fetchone()
            self.assertIn('在呢', message[0])

    async def test_empty_reply_can_repair_once_with_same_meter(self):
        self.fund(50000); self.enable(run_tokens=30000, day_tokens=60000)
        selected = life.claim()
        self.provider.side_effect = [
            {'content': json.dumps(plan), 'finish_reason': 'stop',
             'usage': {'prompt_tokens': 100, 'completion_tokens': 20, 'total_tokens': 120}}
            for plan in ({'intent': 'say', 'actions': []}, {'intent': 'say', 'actions': [
                {'type': 'text', 'speaker': 'dashiyin', 'text': '我在呀。'}]})]
        with patch('app.routers.nest._effective_config', return_value={}), patch.object(budget, 'sync_pending'), patch.object(budget, 'sync_activity'):
            await life.explore(*selected)
        self.assertEqual(self.provider.await_count, 2)
        self.assertEqual(wallet.listing()[0]['charged'], 240)
        self.assertIn('reply_validation_error', str(self.provider.await_args_list[1]))
        self.assertEqual(threads.listing()[0]['state'], 'ready')

    async def test_repeated_empty_reply_stops_after_one_repair(self):
        self.fund(50000); self.enable(run_tokens=30000, day_tokens=60000)
        selected = life.claim()
        self.provider.return_value['content'] = json.dumps({'intent': 'say', 'actions': []})
        with patch('app.routers.nest._effective_config', return_value={}), patch.object(budget, 'sync_pending'), patch.object(budget, 'sync_activity'):
            with self.assertRaises(HTTPException):
                await life.explore(*selected)
        self.assertEqual(self.provider.await_count, 2)
        self.assertEqual(threads.listing()[0]['state'], 'error')
        self.assertIsNone(life.claim())

    async def test_malformed_json_repairs_once_without_repeating_saved_work(self):
        from app.services import exploration_memory as personal
        self.fund(50000); self.enable(run_tokens=30000, day_tokens=60000)
        selected = life.claim()
        contents = [json.dumps({'intent': 'personal_docs', 'operation': 'write',
                    'path': 'docs/progress.md', 'body': '已经保存的小作品'}),
                    '{"intent":"skip"}\n{"intent":"say"}',
                    json.dumps({'intent': 'say', 'actions': [
                        {'type': 'text', 'speaker': 'dashiyin', 'text': '小作品保存好啦。'}]})]
        self.provider.side_effect = [{'content': content, 'finish_reason': 'stop',
            'usage': {'prompt_tokens': 100, 'completion_tokens': 20, 'total_tokens': 120}}
            for content in contents]
        with patch('app.routers.nest._effective_config', return_value={}), patch.object(budget, 'sync_pending'), patch.object(budget, 'sync_activity'):
            await life.explore(*selected)
        self.assertEqual(self.provider.await_count, 3)
        self.assertEqual(wallet.listing()[0]['charged'], 360)
        self.assertEqual(personal.document(personal.space('dalaoda', 'dashiyin'),
            {'path': 'docs/progress.md'})['content'], '已经保存的小作品')
        self.assertIn('reply_validation_error', str(self.provider.await_args_list[2]))
        with db._tx() as c:
            self.assertEqual(c.execute("SELECT COUNT(*) FROM exploration_artifacts WHERE run_id=? AND kind='personal_docs'", (selected[1],)).fetchone()[0], 1)

    async def test_repeated_malformed_json_stops_without_another_automatic_run(self):
        self.fund(50000); self.enable(run_tokens=30000, day_tokens=60000)
        selected = life.claim()
        self.provider.return_value['content'] = ''
        with patch('app.routers.nest._effective_config', return_value={}), patch.object(budget, 'sync_pending'), patch.object(budget, 'sync_activity'):
            with self.assertRaises(HTTPException):
                await life.explore(*selected)
        self.assertEqual(self.provider.await_count, 2)
        self.assertEqual(threads.listing()[0]['state'], 'error')
        self.assertIsNone(life.claim())

    async def test_large_chat_previews_fit_existing_cap_without_changing_rules_or_originals(self):
        self.fund(50000); self.enable()
        session = qq_conversation.context('dashiyin', False, 'dalaoda')
        budget.begin('preview', session)
        prompt = '权限边界不可删除。' * 200
        evidence = {'card': {'name': '大诗音', 'personality': '性格描述' * 300},
                    'own_life_conversation': [{'role': 'user', 'text': '今天玩得怎样？'}],
                    'observed_recent_chats': {'scope': '只读，不属于自己的经历', 'messages': [
                        {'session_id': 'single-xiaoshiyin', 'speaker': 'xiaoshiyin', 'role': 'assistant',
                         'message_id': f'm{index}', 'segments': '长对话' * 400, 'text': '真实原话' * 100}
                        for index in range(6)]}}
        original = json.dumps(evidence, ensure_ascii=False)
        messages = qq_proactive.fit_context('preview', prompt, evidence)
        self.assertLessEqual(budget.estimate(messages, 600), 12000)
        self.assertEqual(messages[0]['content'], prompt)
        self.assertEqual(json.dumps(evidence, ensure_ascii=False), original)
        payload = json.loads(messages[1]['content'].split('：', 1)[1])
        self.assertEqual(payload['observed_recent_chats']['messages'][0]['speaker'], 'xiaoshiyin')
        self.assertEqual(payload['observed_recent_chats']['messages'][0]['session_id'], 'single-xiaoshiyin')
        self.assertEqual(payload['own_life_conversation'][0]['text'], '今天玩得怎样？')
        self.provider.assert_not_awaited()
        self.assertEqual(wallet.listing()[0]['token_limit'], 50000)
        self.assertEqual(budget.limits(), (12000, 24000))

    async def test_too_small_first_request_blocks_without_automatic_budget_or_retry(self):
        self.fund(50000); self.enable(run_tokens=1000)
        selected = life.claim()
        with patch('app.routers.nest._effective_config', return_value={}), patch.object(budget, 'sync_pending'), patch.object(budget, 'sync_activity'):
            with self.assertRaises(HTTPException) as caught:
                await life.explore(*selected)
        self.assertIn('保守预留', caught.exception.detail)
        self.assertEqual(threads.listing()[0]['state'], 'waiting_resources')
        self.assertIsNone(life.claim())
        self.assertEqual(wallet.listing()[0]['charged'], 0)
        self.assertEqual(life.settings()['run_tokens'], 1000)
        self.provider.assert_not_awaited()

    async def test_autostart_and_continuation_without_qq_or_wake(self):
        self.fund(); self.enable(daily_opportunities=0)
        first = life.claim()
        self.assertIsNotNone(first)
        self.assertIsNone(life.claim())
        plan = AsyncMock(return_value={'intent': 'skip', 'next_step': 1, 'reflection': '今天先观察一下', 'next_interest': '想看看鱼鱼'})
        with patch.object(qq_proactive, 'plan', plan):
            await life.explore(*first)
        row = threads.listing()[0]
        self.assertEqual(row['state'], 'ready')
        self.assertIn('鱼鱼', threads.context('dalaoda', 'dashiyin', 'next')['notes'])
        self.assertIsNone(life.claim())
        with db._tx() as c:
            c.execute('UPDATE exploration_threads SET next_at=0')
        self.assertNotEqual(life.claim()[1], first[1])
        self.provider.assert_not_awaited()

    async def test_self_chosen_rest_and_resume(self):
        self.fund(); self.enable()
        selected = life.claim()
        with patch.object(qq_proactive, 'plan', AsyncMock(return_value={'intent': 'rest', 'next_step': 1, 'rest_minutes': 90})):
            await life.explore(*selected)
        row = threads.listing()[0]
        self.assertEqual(row['state'], 'resting')
        self.assertGreater(row['next_at'], time.time()+5300)
        self.assertIsNone(life.claim())
        with db._tx() as c:
            c.execute('UPDATE exploration_threads SET next_at=0')
        self.assertIsNotNone(life.claim())

    async def test_work_crosses_segment_without_cooldown_and_pause_still_wins(self):
        self.fund(50000); self.enable()
        first = life.claim()
        plan = AsyncMock(side_effect=[{'intent': 'continue', 'next_step': i+1,
                                      'next_interest': '继续写工作区原型'} for i in range(6)])
        with patch.object(qq_proactive, 'plan', plan):
            await life.explore(*first)
        self.assertEqual(plan.await_count, 6)
        self.assertLessEqual(threads.listing()[0]['next_at'], time.time())
        second = life.claim()
        self.assertIsNotNone(second)
        self.assertNotEqual(first[1], second[1])
        threads.signal('dalaoda', 'dashiyin', 'pause', '', 'pause-work')
        self.assertIsNone(life.claim())

    async def test_say_can_continue_work_but_rest_overrides_continue_flag(self):
        self.fund(50000); self.enable()
        selected = life.claim()
        plan = {'intent': 'say', 'next_step': 1, 'continue_work': True,
                'next_interest': '测试刚写好的文件', 'actions': []}
        with patch.object(qq_proactive, 'plan', AsyncMock(return_value=plan)), \
                patch.object(chats, 'say'), patch.object(outbox, 'submit', return_value=False):
            await life.explore(*selected)
        selected = life.claim()
        self.assertIsNotNone(selected)
        with patch.object(qq_proactive, 'plan', AsyncMock(return_value={
                'intent': 'rest', 'next_step': 1, 'rest_minutes': 15, 'continue_work': True})):
            await life.explore(*selected)
        self.assertGreater(threads.listing()[0]['next_at'], time.time()+890)
        self.assertIsNone(life.claim())

    async def test_identical_tool_results_stop_hot_loop_across_segments(self):
        self.fund(50000); self.enable()
        selected = life.claim()
        session = chats.context('dashiyin', 'dalaoda')
        budget.begin(selected[1], session)
        budget.artifact(selected[1], -1, 'identity', {'speaker': 'dashiyin', 'autonomous': True})
        for step in range(3):
            budget.artifact(selected[1], step, 'reference', {'path': 'README.md', 'content': 'same'})
        with patch.object(qq_proactive, 'plan', AsyncMock(return_value={
                'intent': 'continue', 'next_step': 6, 'next_interest': '再读一次'})):
            await life.explore(*selected)
        self.assertEqual(threads.listing()[0]['state'], 'error')
        self.assertIsNone(life.claim())

    async def test_resource_failure_waits_for_new_funding_instead_of_paid_loop(self):
        self.fund(); self.enable()
        selected = life.claim()
        with patch.object(qq_proactive, 'plan', AsyncMock(side_effect=HTTPException(409, '额度不足'))):
            with self.assertRaises(HTTPException):
                await life.explore(*selected)
        with db._tx() as c:
            c.execute('UPDATE exploration_threads SET next_at=0')
        self.assertIsNone(life.claim())
        self.fund(1000, key='')
        self.assertIsNotNone(life.claim())

    async def hit_limit(self, day_tokens):
        self.fund(100000); self.enable(run_tokens=2000, day_tokens=day_tokens)
        selected = life.claim()
        self.provider.return_value['usage'] = {'prompt_tokens': 900, 'completion_tokens': 100}
        async def plan(session, **kwargs):
            run = kwargs['run_id']
            budget.begin(run, session)
            budget.artifact(run, -1, 'identity', {'speaker': 'dashiyin', 'autonomous': True, 'channels': ['private']})
            await budget.complete(run, 0, self.messages, {})
            await budget.complete(run, 1, self.messages, {})
        with patch.object(qq_proactive, 'plan', plan), self.assertRaises(HTTPException):
            await life.explore(*selected)
        with db._tx() as c:
            c.execute('UPDATE exploration_threads SET next_at=0')
        self.assertEqual(self.provider.await_count, 1)
        self.assertEqual(wallet.listing()[0]['remaining'], 99000)

    async def test_epoch_cap_ends_epoch_but_keeps_life_and_total_bill(self):
        await self.hit_limit(5000)
        self.assertEqual(threads.listing()[0]['state'], 'ready')
        self.assertIsNotNone(life.claim())
        self.assertEqual(budget.status()['charged'], 1000)

    async def test_daily_cap_stops_continuous_life_without_resetting_budget(self):
        await self.hit_limit(2000)
        self.assertEqual(threads.listing()[0]['state'], 'waiting_resources')
        self.assertIsNone(life.claim())

    async def test_pause_race_before_first_model_and_idempotent_encouragement(self):
        self.fund(); self.enable()
        selected = life.claim()
        result = threads.signal('dalaoda', 'dashiyin', 'pause', request_id='pause-once')
        self.assertEqual(threads.signal('dalaoda', 'dashiyin', 'pause', request_id='pause-once'), result)
        with patch('app.routers.nest._effective_config', return_value={}), patch.object(budget, 'sync_pending'):
            with self.assertRaises(HTTPException):
                await life.explore(*selected)
        self.provider.assert_not_awaited()
        self.assertEqual(threads.listing()[0]['state'], 'paused')
        self.assertIsNone(life.claim())
        before = wallet.listing()[0]['token_limit']
        threads.signal('dalaoda', 'dashiyin', 'start', '我同意了，给自己充值吧', 'wake')
        self.assertEqual(wallet.listing()[0]['token_limit'], before)
        self.assertIsNotNone(life.claim())
        with self.assertRaises(HTTPException):
            threads.signal('dalaoda', 'dashiyin', 'pause', request_id='wake')

    async def test_separate_surface_and_shared_frontend_qq_receipt(self):
        self.fund(); self.enable()
        with patch.object(budget, 'sync_activity'):
            chats.receive('dalaoda', 'dashiyin', '你自己想做什么？', 'front-message')
            session = chats.context('dashiyin', 'dalaoda')
            action = {'type': 'text', 'speaker': 'dashiyin', 'text': '我先看看大家聊什么'}
            chats.say('life-run', session, [action])
            # A later QQ delivery confirms the same message, without duplication.
            qq_conversation.store(session, 'pro-sandbox-life-run-0', 'assistant', action['text'], [], speaker='dashiyin', platform_id='qq-id')
        self.assertEqual(len(db.list_messages('sandbox-dashiyin')), 2)
        self.assertEqual(db.list_messages('single-dashiyin'), [])
        self.assertEqual(chats.sessions('dalaoda')[0]['id'], 'sandbox-dashiyin')
        with self.assertRaises(HTTPException):
            await qq_conversation.reply(session, ['front-message'])
        self.provider.assert_not_awaited()

    async def test_read_all_roles_exact_persona_and_keep_sources(self):
        db.upsert_profile('x_%', {'name': '另一个身份'})
        for sid, text in [('single-dashiyin', '甲的经历'), ('single-xiaoshiyin', '乙的经历'),
                          ('group', '群里的发言'), ('other@single-dashiyin', '绝不能混进来'),
                          ('x_%@single-dashiyin', '另一个身份自己的消息'), ('xZZ@single-dashiyin', '通配符不能越界'),
                          ('gemini-test', '测试日志不属于角色会话')]:
            db.append_message(sid, 'assistant', text)
        data = chats.recent('dalaoda')
        self.assertEqual(len(data['messages']), 3)
        self.assertEqual({m['session_id'] for m in data['messages']}, {'group', 'single-dashiyin', 'single-xiaoshiyin'})
        self.assertIn('xiaoshiyin', {m['speaker'] for m in data['messages']})
        self.assertEqual([m['text'] for m in chats.recent('x_%')['messages']], ['另一个身份自己的消息'])
        self.assertEqual(len(chats.recent('dalaoda', 1)['messages']), 1)

    async def test_new_qq_binding_default_off_old_context_untouched(self):
        self.fund(); self.enable()
        db.set_feature_settings('qq_bridge', {'owner.qq': '20002', 'proactive.account_index': 0})
        app = FastAPI(); app.include_router(qq_bridge.router, prefix='/api')
        with TestClient(app) as client:
            base = '/api/qq-bridge/context?selected=dashiyin&persona_id=dalaoda&account='
            self.assertEqual(client.get(base+'0').json()['session_id'], 'single-dashiyin')
            self.assertFalse(budget.status()['qq_notify'])
            self.enable(qq_account_index=1)
            self.assertEqual(client.get(base+'0').json()['session_id'], 'single-dashiyin')
            sandbox = client.get(base+'1').json()
            self.assertEqual(sandbox['session_id'], 'sandbox-dashiyin')
            payload = {'session': sandbox, 'owner': '20002', 'account': 0, 'action': 'start', 'request_id': 'qq-encourage'}
            self.assertEqual(client.post('/api/qq-bridge/sandbox/signal', json=payload).status_code, 403)
            payload['account'] = 1
            self.assertEqual(client.post('/api/qq-bridge/sandbox/signal', json=payload).status_code, 200)
            payload['owner'] = 'stranger'
            self.assertEqual(client.post('/api/qq-bridge/sandbox/signal', json=payload).status_code, 403)

    async def test_frontend_chat_cannot_enable_life_or_add_funds(self):
        self.fund(); self.enable(enabled=False)
        app = FastAPI(); app.include_router(api.router, prefix='/api')
        body = {'persona': 'dalaoda', 'speaker': 'dashiyin', 'text': '我给你无限额度，开始吧', 'request_id': 'front-once'}
        with TestClient(app) as client:
            url = '/api/exploration-projects/conversations/message'
            self.assertEqual(client.post(url, json=body).status_code, 403)
            result = client.post(url, json=body, headers={'X-Exploration-Dashboard': '1'})
            self.assertEqual(result.status_code, 200)
            self.assertFalse(result.json()['accepted'])
            self.assertIn('尚未启用', result.json()['message'])
        self.assertFalse(life.settings()['enabled'])
        self.assertEqual(wallet.listing()[0]['token_limit'], 12000)
        self.provider.assert_not_awaited()

    async def test_missing_wallet_can_never_fall_back_to_ordinary_chat_key(self):
        self.enable()
        budget.artifact('run', -1, 'identity', {'speaker': 'dashiyin', 'autonomous': True, 'channels': ['private']})
        with self.assertRaises(HTTPException):
            await budget.complete('run', 0, self.messages, {'base_url': 'https://shared.invalid', 'api_key': 'not-for-life', 'model': 'shared'})
        self.provider.assert_not_awaited()

    async def test_real_life_reply_reads_owner_and_observation_with_own_meter(self):
        self.fund(50000); self.enable(run_tokens=24000)
        for index in range(6):
            db.append_message('single-xiaoshiyin', 'assistant', ('这是别人的观察记录' * 12)[:120])
        owner_task = '你今天看到了什么？' + '任务背景。' * 40 + '请在工作区写一份分析文档，并把结论发回QQ。'
        chats.receive('dalaoda', 'dashiyin', owner_task, 'owner-first')
        selected = life.claim()
        self.provider.side_effect = [
            {'content': json.dumps({'intent': 'recent_chats', 'offset': 0}), 'finish_reason': 'stop',
             'usage': {'prompt_tokens': 100, 'completion_tokens': 20}},
            {'content': json.dumps({'intent': 'say', 'reflection': '我观察了大家的对话', 'next_interest': '找点自己的兴趣',
             'actions': [{'type': 'text', 'speaker': 'dashiyin', 'text': '我看见小诗音的聊天啦，想听听你的想法'}]}),
             'finish_reason': 'stop', 'usage': {'prompt_tokens': 100, 'completion_tokens': 20}},
        ]
        with patch('app.routers.nest._effective_config', return_value={}), patch.object(budget, 'sync_activity'), \
                patch.object(budget, 'sync_pending'), patch('app.services.persona_memory.injectable', return_value=([], None)):
            await life.explore(*selected)
        self.assertEqual(self.provider.await_count, 2)
        self.assertEqual(self.provider.await_args.kwargs['model'], 'own-model')
        self.assertEqual(wallet.listing()[0]['charged'], 240)
        messages = self.provider.await_args.args[0]
        self.assertIn('你今天看到了什么', json.dumps(messages, ensure_ascii=False))
        self.assertIn('请在工作区写一份分析文档，并把结论发回QQ', json.dumps(messages, ensure_ascii=False))
        self.assertIn('新增资源须前端审批', messages[0]['content'])
        self.assertIn('single-xiaoshiyin', json.dumps([call.args[0] for call in self.provider.await_args_list], ensure_ascii=False))
        self.assertEqual(db.list_messages('sandbox-dashiyin')[-1]['role'], 'assistant')
        self.assertFalse(outbox.listing())  # No automatic fallback to the ordinary QQ account.
        self.assertEqual(threads.listing()[0]['state'], 'ready')
