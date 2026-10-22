"""离线检查累计用量、并发预留、故障恢复和停止；不调用付费服务。"""
import tempfile
import json
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

from app import db
from app.services import exploration_budget as budget


class BudgetTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        for name, value in [('DATA_DIR', Path(tmp.name)), ('DB_PATH', Path(tmp.name)/'test.db')]:
            p = patch.object(db, name, value); p.start(); self.addCleanup(p.stop)
        db.init_db()
        self.session = {'persona_id': 'dalaoda', 'character_ids': ['dashiyin']}
        self.messages = [{'role': 'user', 'content': 'hello'}]
        self.cfg = {'model': 'fake', 'base_url': 'https://unused.invalid'}
        self.provider = AsyncMock(return_value={'content': 'ok', 'finish_reason': 'stop',
            'usage': {'prompt_tokens': 100, 'completion_tokens': 20, 'total_tokens': 120}})
        p = patch.object(budget.openai, 'complete_chat_full', self.provider); p.start(); self.addCleanup(p.stop)
        budget.begin('run', self.session)

    async def test_input_plus_output_accumulate_and_budget_is_persistent(self):
        await budget.complete('run', 0, self.messages, self.cfg)
        await budget.complete('run', 1, self.messages, self.cfg)
        self.assertTrue(all(call.kwargs['stream'] for call in self.provider.await_args_list))
        state = budget.status()
        self.assertEqual((state['input'], state['output'], state['charged']), (200, 40, 240))
        db.set_feature_settings('qq_bridge', {'proactive.day_tokens': 240})
        with self.assertRaises(HTTPException):
            await budget.complete('run', 2, self.messages, self.cfg)
        self.assertEqual(self.provider.await_count, 2)

    async def test_repeated_context_and_output_are_reserved_before_call(self):
        db.set_feature_settings('qq_bridge', {'proactive.run_tokens': 1000})
        with self.assertRaises(HTTPException):
            await budget.complete('run', 0, self.messages, self.cfg)
        self.provider.assert_not_awaited()

    async def test_unknown_usage_stops_all_characters_for_today(self):
        self.provider.return_value.pop('usage')
        with self.assertRaises(HTTPException):
            await budget.complete('run', 0, self.messages, self.cfg)
        budget.begin('other', {**self.session, 'character_ids': ['xiaoshiyin']})
        with self.assertRaises(HTTPException):
            await budget.complete('other', 0, self.messages, self.cfg)
        self.assertEqual(self.provider.await_count, 1)
        self.assertTrue(budget.status()['uncertain'])
        self.assertGreater(budget.status()['charged'], 600)
        budget.resume()
        self.assertTrue(budget.status()['uncertain'])

    async def test_timeout_charges_reservation_without_retry(self):
        self.provider.side_effect = TimeoutError()
        with self.assertRaises(TimeoutError):
            await budget.complete('run', 0, self.messages, self.cfg)
        self.assertEqual(self.provider.await_count, 1)
        self.assertTrue(budget.status()['uncertain'])

    async def test_nested_reasoning_and_cache_not_double_counted(self):
        self.provider.return_value['usage'] = {'prompt_tokens': 100, 'completion_tokens': 20,
            'prompt_tokens_details': {'cached_tokens': 80}, 'completion_tokens_details': {'reasoning_tokens': 15}}
        await budget.complete('run', 0, self.messages, self.cfg)
        self.assertEqual(budget.status()['charged'], 120)

    async def test_cancel_during_generation_settles_but_returns_no_action(self):
        async def generate(*args, **kwargs):
            budget.stop()
            return {'content': 'should not send', 'finish_reason': 'stop',
                    'usage': {'input_tokens': 11, 'output_tokens': 7}}
        self.provider.side_effect = generate
        with self.assertRaises(HTTPException):
            await budget.complete('run', 0, self.messages, self.cfg)
        self.assertEqual(budget.status()['charged'], 18)
        self.assertTrue(budget.status()['stopped'])

    async def test_concurrent_reservations_have_one_winner(self):
        budget.begin('other', self.session)
        def reserve(run):
            try:
                return budget.reserve(run, 0, self.messages, 600)
            except HTTPException:
                return None
        with ThreadPoolExecutor(2) as executor:
            results = list(executor.map(reserve, ['run', 'other']))
        self.assertEqual(sum(r is not None for r in results), 1)

    async def test_crashed_pending_call_is_conservatively_recovered(self):
        call = budget.reserve('run', 0, self.messages, 600)
        with db._tx() as c:
            c.execute('UPDATE exploration_calls SET created=? WHERE id=?', (time.time()-200, call))
        self.assertTrue(budget.status()['uncertain'])
        with self.assertRaises(HTTPException):
            await budget.complete('run', 1, self.messages, self.cfg)
        self.provider.assert_not_awaited()

    async def test_step_replay_and_identity_change_do_not_buy_another_call(self):
        await budget.complete('run', 0, self.messages, self.cfg)
        with self.assertRaises(HTTPException):
            await budget.complete('run', 0, self.messages, self.cfg)
        with self.assertRaises(HTTPException):
            budget.begin('run', {**self.session, 'persona_id': 'other'})
        self.assertEqual(self.provider.await_count, 1)

    async def test_actual_overrun_is_recorded_and_stops_day(self):
        self.provider.return_value['usage'] = {'prompt_tokens': 9000, 'completion_tokens': 1000}
        with self.assertRaises(HTTPException):
            await budget.complete('run', 0, self.messages, self.cfg)
        self.assertEqual(budget.status()['charged'], 10000)
        self.assertTrue(budget.status()['uncertain'])

    async def test_invalid_usage_is_not_treated_as_zero(self):
        call = budget.reserve('run', 0, self.messages, 600)
        self.assertFalse(budget.settle(call, {'prompt_tokens': True, 'completion_tokens': 1}))
        self.assertTrue(budget.status()['uncertain'])

    async def test_inconsistent_total_is_conservatively_rejected(self):
        call = budget.reserve('run', 0, self.messages, 600)
        self.assertFalse(budget.settle(call, {'prompt_tokens': 10, 'completion_tokens': 5, 'total_tokens': 1}))
        self.assertTrue(budget.status()['uncertain'])
        receipt = next(json.loads(a['content']) for a in budget.status()['artifacts'] if a['kind'] == 'usage_receipt')
        self.assertIn('不一致', receipt['reason'])
        self.assertEqual(receipt['total_tokens'], 1)

    async def test_date_rollover_allows_new_budget_without_reopening_old_run(self):
        await budget.complete('run', 0, self.messages, self.cfg)
        with patch.object(budget, 'day', return_value='2099-01-02'):
            with self.assertRaises(HTTPException):
                await budget.complete('run', 1, self.messages, self.cfg)
            self.assertEqual(budget.status()['charged'], 0)
            budget.begin('new-day', self.session)
            await budget.complete('new-day', 0, self.messages, self.cfg)
            self.assertEqual(budget.status()['charged'], 120)

    async def test_expired_run_cannot_continue(self):
        with db._tx() as c:
            c.execute('UPDATE exploration_runs SET created=? WHERE id=?', (time.time()-601, 'run'))
        with self.assertRaises(HTTPException):
            await budget.complete('run', 0, self.messages, self.cfg)
        self.provider.assert_not_awaited()

    async def test_keyword_recall_never_calls_embedding_model(self):
        from app.services import memory_retrieval
        with patch.object(memory_retrieval, '_embed', side_effect=AssertionError('unmetered model call')):
            result = memory_retrieval.rank([{'id': 'm', 'text': '烘焙 收藏 小饼干'}], '烘焙', allow_embeddings=False)
        self.assertEqual(result[0]['injection_reason'], 'keyword')


if __name__ == '__main__':
    unittest.main()
