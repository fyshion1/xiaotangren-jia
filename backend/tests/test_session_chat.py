import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import db
from app.routers import session_chat as chat
from app.routers.chat import _to_openai_messages as real_prompt
from app.services import memory, memory_workflow as work


class SessionChatTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        for name, value in [('DATA_DIR', Path(tmp.name)), ('DB_PATH', Path(tmp.name) / 'test.db')]:
            p = patch.object(db, name, value); p.start(); self.addCleanup(p.stop)
        env = patch.dict('os.environ', {'PERSONAL_MEMORY_ROOT': str(Path(tmp.name) / 'memory')})
        env.start(); self.addCleanup(env.stop)
        db.init_db()
        db.set_brain_default({'base_url': 'http://brain.test/v1', 'model': 'brain-model', 'api_key': 'BRAIN-KEY'})
        self.char = 'dashiyin'
        self.calls = []
        self.routes = []
        self.provider_fail = False
        async def stream(messages, model, base_url, api_key, **kwargs):
            self.calls.append(messages)
            self.routes.append((model, base_url, api_key))
            if self.provider_fail:
                yield {'type': 'error', 'message': 'private upstream detail'}
            else:
                yield {'type': 'text', 'text': '**大诗音**：我在，记得你说过的事。'}
                yield {'type': 'done'}
        def prompt(messages, ids, **kwargs):
            return [{'role': m.role, 'content': m.content} for m in messages]
        self.memory = AsyncMock(return_value={})
        # 此套测试验证记忆内容与身份；合批时间行为由独立测试覆盖。
        from app.services import memory_batch
        for name in ('QUIET_SECONDS', 'MAX_SECONDS'):
            batch = patch.object(memory_batch, name, 0); batch.start(); self.addCleanup(batch.stop)
        diagnostic = patch.object(chat, 'upstream_accessibility', AsyncMock(return_value='上游入口可达，生成通道状态未知'))
        diagnostic.start(); self.addCleanup(diagnostic.stop)
        for target, value in [('_effective_config', lambda _: {'base_url': 'http://unused', 'model': 'test', 'api_key': 'SECRET'}),
                              ('_to_openai_messages', prompt), ('_turn_lock', asyncio.Lock())]:
            p = patch.object(chat, target, value); p.start(); self.addCleanup(p.stop)
        for obj, name, value in [(chat.agent_tools, 'available', lambda *args, **kwargs: False), (chat.openai, 'stream_chat_retry', stream), (chat.memory_extract, 'extract', self.memory)]:
            p = patch.object(obj, name, value); p.start(); self.addCleanup(p.stop)
        from app.routers.qq_bridge import router as qq_router
        app = FastAPI(); app.include_router(chat.router, prefix='/api'); app.include_router(qq_router, prefix='/api')
        self.client = TestClient(app); self.addCleanup(self.client.close)

    def turn(self, **overrides):
        body = {'character_id': self.char, 'mode': 'single', 'session_id': f'single-{self.char}',
                'text': '记住我喜欢草莓', 'request_id': 'request-0001'}
        return self.client.post('/api/chat/session/turn', json={**body, **overrides})

    def test_web_reply_suggestions_share_generation_and_replay(self):
        import json
        from app.services import reply_suggestions
        async def stream(messages, *args, **kwargs):
            self.calls.append(messages)
            raw = '回复正文' + reply_suggestions.START + '["那明天呢", "好呀", "好呀"]' + reply_suggestions.END
            for char in raw:
                yield {'type': 'text', 'text': char}
            yield {'type': 'done', 'finish_reason': 'stop'}
        body = {'character_id': self.char, 'session_id': f'single-{self.char}', 'text': '明天一起散步吗',
                'request_id': 'suggestion-001', 'reply_suggestions': True, 'auto_memory': False}
        with patch.object(chat.openai, 'stream_chat_retry', stream), patch.object(chat.agent_tools, 'available', return_value=False):
            response = self.client.post('/api/chat/session/web-stream', json=body)
            self.assertEqual(response.status_code, 200)
            tokens = [json.loads(block.split('data: ', 1)[1])['text'] for block in response.text.split('\n\n') if block.startswith('event: token')]
            self.assertEqual(''.join(tokens), '回复正文')
            done = json.loads(next(block.split('data: ', 1)[1] for block in response.text.split('\n\n') if block.startswith('event: done')))
            self.assertEqual(done['reply_suggestions'], ['那明天呢', '好呀'])
            self.assertEqual(done['assistant']['content'], '回复正文')
            again = self.client.post('/api/chat/session/web-stream', json=body)
            self.assertIn('那明天呢', again.text)
        self.assertEqual(len(self.calls), 1)
        self.assertIn(reply_suggestions.START, self.calls[0][0]['content'])
        self.assertFalse(any(reply_suggestions.START in row['content'] for row in db.list_messages(f'single-{self.char}')))

    def test_collapsed_suggestions_do_not_add_prompt_or_call_again(self):
        body = {'character_id': self.char, 'session_id': f'single-{self.char}', 'text': '你好',
                'request_id': 'suggestion-off', 'reply_suggestions': False, 'auto_memory': False}
        self.client.post('/api/chat/session/web-stream', json=body)
        self.assertEqual(len(self.calls), 1)
        self.assertFalse(any('<reply_suggestions>' in str(message['content']) for message in self.calls[0]))

    def test_tool_answer_extracts_candidates_without_fallback_request(self):
        from types import SimpleNamespace
        result = SimpleNamespace(content='工具回复<reply_suggestions>["再查一下"]</reply_suggestions>', finish_reason='stop')
        generate = AsyncMock(return_value=result)
        with patch.object(chat.agent_tools, 'available', return_value=True), patch.object(chat.agent_tools, 'generate', generate):
            response = self.turn(feature_id='core', reply_suggestions=True, auto_memory=False)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()['assistant']['content'], '工具回复')
        self.assertEqual(response.json()['reply_suggestions'], ['再查一下'])
        generate.assert_awaited_once()
        self.assertEqual(self.calls, [])

    def test_core_ignores_browser_overrides_and_uses_latest_brain(self):
        response = self.turn(feature_id='core', model='stale-browser-model', base_url='http://stale.test', api_key='OLD', auto_memory=False)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.routes[-1], ('brain-model', 'http://brain.test/v1', 'BRAIN-KEY'))
        db.set_brain_default({'base_url': 'http://new-brain.test/v1', 'model': 'new-brain', 'api_key': 'NEW'})
        response = self.turn(feature_id='core', request_id='request-new-brain', auto_memory=False)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.routes[-1], ('new-brain', 'http://new-brain.test/v1', 'NEW'))

    def test_core_without_brain_does_not_fall_back_to_env_or_browser(self):
        db.set_brain_default({'base_url': '', 'model': '', 'api_key': ''})
        response = self.turn(feature_id='core', base_url='http://stale.test', model='old', api_key='OLD')
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.routes, [])

    def test_brain_vision_route_and_prompt_preview_ignore_browser(self):
        from app.routers.chat import _brain_route, ChatRequest, chat_preview
        db.set_brain_default({'vision_base_url': 'http://vision.test/v1', 'vision_model': 'vision-model', 'vision_api_key': 'VISION'})
        self.assertEqual(_brain_route(True), {'base_url': 'http://vision.test/v1', 'model': 'vision-model', 'api_key': 'VISION'})
        with patch('app.routers.chat._to_openai_messages', return_value=[]):
            result = asyncio.run(chat_preview(ChatRequest(messages=[], model='old', base_url='http://old.test')))
        self.assertEqual(result['model'], 'brain-model')
        self.assertEqual(result['base_url'], 'http://brain.test/v1')

    def test_imported_card_chat_mode_reaches_the_model(self):
        db.set_settings({'tavern_mode': 'true'})
        db.upsert_character(self.char, {**db.get_character(self.char), 'imported': True})
        response = self.turn(card_display_mode='chat', auto_memory=False)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn('像朋友发消息一样', self.calls[0][0]['content'])
        self.assertIn('不输出 HTML', self.calls[0][0]['content'])
        changed = self.turn(card_display_mode='html', auto_memory=False)
        self.assertEqual(changed.status_code, 409)

    def test_imported_card_html_mode_and_native_chat_are_separate(self):
        db.set_settings({'tavern_mode': 'true'})
        db.upsert_character(self.char, {**db.get_character(self.char), 'imported': True})
        response = self.turn(card_display_mode='html', auto_memory=False)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn('HTML 渲染模式', self.calls[0][0]['content'])
        db.upsert_character(self.char, {**db.get_character(self.char), 'imported': False})
        response = self.turn(card_display_mode='chat', request_id='request-native', auto_memory=False)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertFalse(any('本轮使用仅聊天模式' in str(m['content']) for m in self.calls[-1]))

    def test_shared_history_and_memory_and_safe_retry(self):
        sid = f'single-{self.char}'
        db.append_message(sid, 'assistant', '网页上以前的聊天')
        first = self.turn()
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(self.calls[0][0]['content'], '网页上以前的聊天')
        self.assertEqual(len(db.list_messages(sid)), 3)
        again = self.turn()
        self.assertTrue(again.json()['replayed'])
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(len(db.list_messages(sid)), 3)
        self.assertEqual(self.memory.await_args.kwargs['feature_id'], '')
        self.assertEqual(self.memory.await_args.kwargs['session_kind'], 'single')
        state = self.client.get('/api/chat/session', params={'character_id': self.char})
        self.assertNotIn('SECRET', state.text)
        self.assertEqual(state.json()['items'][-1]['id'], first.json()['assistant']['id'])

    def test_failed_turn_retry_keeps_one_user_message(self):
        self.provider_fail = True
        failed = self.turn()
        self.assertEqual(failed.status_code, 502)
        self.assertNotIn('private upstream', failed.text)
        self.assertEqual(len(db.list_messages(f'single-{self.char}')), 1)
        self.provider_fail = False
        self.assertEqual(self.turn().status_code, 200)
        self.assertEqual(len(db.list_messages(f'single-{self.char}')), 2)
        self.assertEqual(self.turn(text='另一句话').status_code, 409)

    def test_web_turn_queues_both_sides_once_and_excludes_feature_turns(self):
        from app.services.qq_web_sync import poll
        from app.services.qq_conversation import context
        session = context(self.char)
        poll(session, 'bot', 'p:1')
        first = self.turn(feature_id='core')
        self.assertEqual(first.status_code, 200, first.text)
        self.assertTrue(self.turn(feature_id='core').json()['replayed'])
        user = poll(session, 'bot', 'p:1')['item']
        self.assertEqual(user['id'], first.json()['user']['id'])
        assistant = poll(session, 'bot', 'p:1', user['sync_seq'])['item']
        self.assertEqual(assistant['id'], first.json()['assistant']['id'])
        self.assertIsNone(poll(session, 'bot', 'p:1', assistant['sync_seq'])['item'])
        self.assertEqual(self.turn(request_id='feature-turn', feature_id='qq_bridge').status_code, 200)
        self.assertIsNone(poll(session, 'bot', 'p:1')['item'])

    def test_desktop_pet_group_turn_queues_both_sides_once(self):
        from app.services.qq_web_sync import poll
        from app.services.qq_conversation import context
        session = context('group')
        poll(session, 'bot', 'p:1')
        first = self.turn(feature_id='desktop_pet', mode='group', session_id='group')
        self.assertEqual(first.status_code, 200, first.text)
        self.assertTrue(self.turn(feature_id='desktop_pet', mode='group', session_id='group').json()['replayed'])
        user = poll(session, 'bot', 'p:1')['item']
        self.assertEqual(user['id'], first.json()['user']['id'])
        assistant = poll(session, 'bot', 'p:1', user['sync_seq'])['item']
        self.assertEqual(assistant['id'], first.json()['assistant']['id'])
        self.assertTrue(assistant['segments'])
        self.assertIsNone(poll(session, 'bot', 'p:1', assistant['sync_seq'])['item'])

    def test_changed_identity_wrong_session_and_invalid_input_do_not_write(self):
        self.assertEqual(self.turn(session_id='group').status_code, 409)
        self.assertEqual(self.turn(text='  ').status_code, 422)
        self.assertEqual(self.turn(character_id='unknown').status_code, 404)
        self.assertEqual(self.turn(mode='wrong').status_code, 422)
        self.assertEqual(db.list_messages(f'single-{self.char}'), [])
        profiles = [p for p in db.list_profiles() if p['id'] != 'dalaoda']
        if profiles:
            with patch.object(db, 'get_active_persona_id', return_value=profiles[0]['id']):
                self.assertEqual(self.turn().status_code, 409)
                state = chat.resolve_session(self.char, 'single')
                self.assertEqual(state['session_id'], f"{profiles[0]['id']}@single-{self.char}")

    def test_group_roster_reply_segments_and_shared_memory(self):
        db.set_settings({'group_roster': '["dashiyin"]'})
        r = self.turn(mode='group', session_id='group')
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()['character_ids'], [self.char])
        row = db.list_messages('group')[-1]
        self.assertEqual(row['kind'], 'groups')
        self.assertEqual(row['segments'][0]['speaker'], '大诗音')
        self.assertEqual(self.memory.await_args.kwargs['feature_id'], '')
        self.assertEqual(self.memory.await_args.kwargs['session_kind'], 'group')

    def test_character_prompt_uses_custom_fields_and_signature_with_legacy_kana(self):
        from app.services.prompt.assembler import _persona_block
        profile = db.get_character(self.char)
        profile.update({'signature':'Kahoruzuki Shion', 'customFields':[{'label':'兴趣','value':'做点心'}]})
        prompt = _persona_block(profile)
        self.assertIn('英文 / 罗马音签名：Kahoruzuki Shion', prompt)
        self.assertIn('兴趣：做点心', prompt)

    def test_character_visibility_preferences_are_persisted(self):
        profile = db.get_character(self.char)
        profile.update({'hiddenInProfiles': True, 'hiddenFields':['likes'],
                        'customFields':[{'label':'兴趣','value':'做点心'}]})
        db.upsert_character(self.char, profile)
        saved = db.get_character(self.char)
        self.assertTrue(saved['hiddenInProfiles'])
        self.assertEqual(saved['hiddenFields'], ['likes'])
        self.assertEqual(saved['customFields'][0]['value'], '做点心')

    def test_qq_group_context_tracks_current_roster(self):
        db.set_settings({'group_roster': '["dashiyin"]'})
        first = self.client.get('/api/qq-bridge/group-session')
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(first.json()['character_ids'], ['dashiyin'])
        db.set_settings({'group_roster': '["xiaobai"]'})
        second = self.client.get('/api/qq-bridge/group-session').json()
        self.assertEqual(second['character_ids'], ['xiaobai'])
        self.assertEqual(second['session_id'], 'group')

    def test_qq_group_uses_daily_memory_session_and_saved_media(self):
        db.set_settings({'group_roster': '["dashiyin"]'})
        image = '/api/files/group/orig/test.png'
        result = self.turn(feature_id='qq_bridge', mode='group', session_id='group', images=[image])
        self.assertEqual(result.status_code, 200, result.text)
        rows = db.list_messages('group')
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]['frames'], [image])
        self.assertEqual(self.memory.await_args.kwargs['persona_id'], 'dalaoda')
        self.assertEqual(self.memory.await_args.kwargs['session_id'], 'group')
        self.assertEqual(self.memory.await_args.kwargs['character_ids'], ['dashiyin'])
        self.assertEqual(self.memory.await_args.kwargs['feature_id'], '')
        self.assertEqual(self.turn(images=['https://example.org/a.png']).status_code, 422)

    def test_qq_video_original_and_frames_are_preserved(self):
        video = '/api/files/group/orig/test.mp4'
        frame = '/api/files/group/orig/frame.png'
        result = self.turn(feature_id='qq_bridge', mode='group', session_id='group',
                           images=[frame], attachment=video)
        self.assertEqual(result.status_code, 200, result.text)
        row = db.list_messages('group')[0]
        self.assertEqual(row['image'], video)
        self.assertEqual(row['frames'], [frame])

    def test_qq_explicit_identity_matches_archive_and_memory(self):
        with patch.object(db, 'get_active_persona_id', return_value='not-the-selected-persona'):
            context = self.client.get('/api/qq-bridge/group-session', params={'persona_id': 'dalaoda'})
            self.assertEqual(context.status_code, 200, context.text)
            self.assertEqual(context.json()['session_id'], 'group')
            result = self.turn(feature_id='qq_bridge', mode='group', session_id='group', persona_id='dalaoda')
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(self.memory.await_args.kwargs['persona_id'], 'dalaoda')
        self.assertEqual(self.memory.await_args.kwargs['session_id'], 'group')

    def test_qq_group_prompt_filters_absent_character_memories(self):
        db.set_settings({'group_roster': '["dashiyin"]'})
        for cid, text in [('dashiyin', '在场角色草莓记忆'), ('xiaobai', '离场角色保密记忆')]:
            item = work.propose(text, 'dalaoda', [cid], scope='personal')
            work.review(item['id'], 'dalaoda', 'approve', {'core': True}, item['revision'])
        with patch.object(chat, '_to_openai_messages', real_prompt), patch.object(memory.emb, 'embed_texts', return_value=[]):
            result = self.turn(feature_id='qq_bridge', mode='group', session_id='group', auto_memory=False)
        self.assertEqual(result.status_code, 200, result.text)
        prompt = self.calls[0][0]['content']
        self.assertIn('在场角色草莓记忆', prompt)
        self.assertNotIn('离场角色保密记忆', prompt)

    def test_real_prompt_recalls_normal_home_and_private_memories_only(self):
        for text, scope in [('家里一起烤过草莓饼干', 'shared'), ('大诗音私聊说好的草莓牛奶', 'personal')]:
            item = work.propose(text, 'dalaoda', [self.char], scope=scope)
            work.review(item['id'], 'dalaoda', 'approve', {'core': True}, item['revision'])
        db.add_memory('personal', '别人的私密测试标记', char_id='xiaobai', fingerprint='other')
        db.add_memory('home', '外设隔离测试标记', game_id='some_game', fingerprint='game')
        with patch.object(chat, '_to_openai_messages', real_prompt), patch.object(memory.emb, 'embed_texts', return_value=[]):
            result = self.turn(auto_memory=False)
        self.assertEqual(result.status_code, 200, result.text)
        prompt = self.calls[0][0]['content']
        self.assertIn('家里一起烤过草莓饼干', prompt)
        self.assertIn('大诗音私聊说好的草莓牛奶', prompt)
        self.assertNotIn('别人的私密测试标记', prompt)
        self.assertNotIn('外设隔离测试标记', prompt)

    def test_shared_session_preserves_image_for_followup(self):
        import io
        from PIL import Image
        from app.services import attachments
        output = io.BytesIO()
        Image.new('RGB', (16, 16), 'red').save(output, format='PNG')
        image = attachments.to_data_url(output.getvalue())
        db.append_message(f'single-{self.char}', 'user', '看这张图', image=image)
        with patch.object(chat, '_to_openai_messages', real_prompt):
            result = self.turn(text='图里是什么？', auto_memory=False)
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(self.calls[0][1]['content'][1]['image_url']['url'], attachments.image_for_model(image))

    def test_stream_deltas_final_retry_and_error(self):
        import json
        body = {'character_id': self.char, 'session_id': f'single-{self.char}', 'text': '你好', 'request_id': 'stream-001', 'auto_memory': False}
        response = self.client.post('/api/chat/session/stream', json=body)
        events = [json.loads(line) for line in response.text.splitlines()]
        self.assertEqual(events[0]['type'], 'delta')
        self.assertEqual(events[-1]['type'], 'done')
        self.assertEqual(events[-1]['result']['assistant']['content'], events[0]['text'])
        again = self.client.post('/api/chat/session/stream', json=body)
        self.assertTrue(json.loads(again.text)['result']['replayed'])
        self.assertEqual(len(self.calls), 1)
        self.provider_fail = True
        failed = self.client.post('/api/chat/session/stream', json={**body, 'request_id': 'stream-002'})
        self.assertEqual(json.loads(failed.text)['type'], 'error')
        self.assertNotIn('private upstream', failed.text)




    def test_media_summary_is_shared_persistent_and_rechecks_only_on_request(self):
        import io, json, re
        from PIL import Image
        from app.services import attachments, media_context
        image_root = Path(db.DATA_DIR) / 'attachments'
        with patch.object(attachments, 'ATTACHMENTS_DIR', image_root):
            data = io.BytesIO(); Image.new('RGB', (16, 16), 'red').save(data, 'PNG')
            url = attachments.save_image('single-dashiyin', data.getvalue(), 'image/png')['orig']
            async def stream(messages, *args, **kwargs):
                self.assertEqual(kwargs['attempts'], 1)
                self.calls.append(messages)
                ids = list(set(re.findall(r'img-[a-f0-9]{24}', json.dumps(messages))))
                text = '你好，这是图片中的猫。'
                if ids:
                    text += media_context.START + json.dumps({'image_summaries': [{'image_id': i, 'summary': '白猫眯眼。'} for i in ids]}, ensure_ascii=False) + media_context.END
                for char in text:
                    yield {'type': 'text', 'text': char}
                yield {'type': 'done', 'finish_reason': 'stop'}
            with patch.object(chat.openai, 'stream_chat_retry', stream), patch.object(chat, '_to_openai_messages', real_prompt):
                first = self.turn(text='看看猫', images=[url], auto_memory=False)
                self.assertEqual(first.status_code, 200, first.text)
                self.assertNotIn('media_summaries', first.json()['assistant']['content'])
                from app.services import qq_media_context
                session = {'persona_id': 'dalaoda', 'session_id': 'single-dashiyin'}
                self.assertIs(qq_media_context, media_context)
                self.assertIn('白猫眯眼', str(qq_media_context.load(session)))
                again = self.turn(text='它可爱吗', request_id='request-0002', auto_memory=False)
                self.assertEqual(again.status_code, 200, again.text)
                self.assertFalse(any(isinstance(m['content'], list) for m in self.calls[-1]))
                self.assertIn('白猫眯眼', json.dumps(self.calls[-1], ensure_ascii=False))
                review = self.turn(text='重看图片，识别文字', request_id='request-0003', auto_memory=False)
                self.assertEqual(review.status_code, 200, review.text)
                self.assertTrue(any(isinstance(m['content'], list) for m in self.calls[-1]))
                self.assertEqual(len(self.calls), 3)
                self.assertEqual(media_context.load({**session, 'persona_id': 'other'}), {})
                with db._tx() as conn:
                    stages = [r['stage'] for r in conn.execute('SELECT stage FROM conversation_events')]
                self.assertIn('received', stages); self.assertIn('generated', stages); self.assertIn('persisted', stages)
                self.assertNotIn('delivered', stages)

    def test_failure_is_diagnosed_once_and_not_retried(self):
        self.provider_fail = True
        result = self.turn(auto_memory=False)
        self.assertEqual(result.status_code, 502)
        self.assertEqual(len(self.calls), 1)
        self.assertIn('generation', result.text)
        self.assertIn('已确认发送 0 条', result.text)
        self.assertNotIn('private upstream', result.text)

    def test_stream_progress_reaches_both_transport_formats(self):
        from app.services import conversation_runtime
        async def slow_stream(*args, **kwargs):
            await asyncio.sleep(.035)
            yield {'type': 'text', 'text': '回答'}
            yield {'type': 'done', 'finish_reason': 'stop'}
        body = {'character_id': self.char, 'session_id': 'single-dashiyin', 'text': '慢一点',
                'request_id': 'progress-001', 'auto_memory': False}
        with patch.object(conversation_runtime, 'WAIT_INTERVAL', .01), patch.object(chat.openai, 'stream_chat_retry', slow_stream):
            ndjson = self.client.post('/api/chat/session/stream', json=body)
            self.assertIn('"type": "status"', ndjson.text)
            body['request_id'] = 'progress-002'
            sse = self.client.post('/api/chat/session/web-stream', json=body)
            self.assertIn('event: status', sse.text)
            self.assertIn('elapsed_seconds', sse.text)
            self.assertIn('event: done', sse.text)
