import unittest
from unittest.mock import patch, AsyncMock
from types import SimpleNamespace
from app.routers.qq_bridge import conversation_tools, QQToolsIn
from app.services.agent_tools import ToolSettings


class QQToolCenterTests(unittest.IsolatedAsyncioTestCase):
    async def test_casual_gate_and_bounded_context(self):
        from app.services.intent_router import Decision
        session = {'persona_id': 'dalaoda', 'session_id': 'qq-group'}
        generate = AsyncMock(return_value=SimpleNamespace(content='事实', status='completed', tool_receipts=[]))
        with patch('app.routers.qq_bridge.qq_conversation.validate', return_value=session), \
             patch('app.services.agent_tools.settings', return_value=ToolSettings(enabled=True)), \
             patch('app.routers.nest._setting', return_value='123'), \
             patch('app.routers.nest._effective_config', return_value={}), \
             patch('app.services.intent_router.classify', return_value=Decision(False, 'chat', 'local_embedding')) as classify, \
             patch('app.routers.qq_bridge.qq_conversation.history', return_value=[
                 {'id': 'prev', 'role': 'user', 'content': 'TOKIMEKI Runners' * 100},
                 {'id': 'now', 'role': 'user', 'content': '读完那个版本'}]) as history, \
             patch('app.services.agent_tools.generate', generate):
            denied = await conversation_tools(QQToolsIn(session={}, actor_id='other', text='嗨'))
            self.assertEqual(denied['status'], 'disabled')
            classify.assert_not_called()
            history.assert_not_called()
            result = await conversation_tools(QQToolsIn(session={}, actor_id='123', text='嗨'))
            self.assertEqual(result['status'], 'not_needed')
            generate.assert_not_awaited()
            classify.return_value = Decision(True, 'uncertain', 'context_required')
            await conversation_tools(QQToolsIn(session={}, actor_id='123', text='读完那个版本', message_ids=['now']))
            history.assert_called_once_with(session, ['now'])
            messages = generate.await_args.args[0]
            self.assertEqual(len(messages[1]['content']), 600)
            self.assertEqual(messages[-1], {'role': 'user', 'content': '读完那个版本'})
            self.assertEqual(len(messages), 3)

    async def test_owner_and_center_permissions_before_generation(self):
        session = {'persona_id': 'dalaoda', 'session_id': 'qq-group', 'selected': 'group'}
        config = ToolSettings(enabled=True)
        generate = AsyncMock(return_value=SimpleNamespace(content='搜索结果', status='completed', tool_receipts=[]))
        with patch('app.routers.qq_bridge.qq_conversation.validate', return_value=session), \
             patch('app.services.agent_tools.settings', return_value=config), \
             patch('app.routers.nest._setting', return_value='123'), \
             patch('app.routers.nest._effective_config', return_value={}), \
             patch('app.services.agent_tools.generate', generate):
            denied = await conversation_tools(QQToolsIn(session={}, actor_id='other', text='搜索'))
            self.assertEqual(denied['status'], 'disabled')
            generate.assert_not_awaited()
            result = await conversation_tools(QQToolsIn(session={}, actor_id='123', text='搜索'))
            self.assertEqual(result['context'], '搜索结果')
            self.assertEqual(generate.await_args.kwargs['feature_id'], 'qq_bridge')
            config.qq_enabled = False
            self.assertEqual((await conversation_tools(QQToolsIn(session={}, actor_id='123', text='搜索')))['status'], 'disabled')
            self.assertEqual(generate.await_count, 1)
