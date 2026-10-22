"""Offline wallet, independent clock, self-observation and notify-before-grant checks."""
import asyncio
import json
import os
import time
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from app import db
from app.routers import exploration_projects as router, qq_bridge
from app.services import exploration_budget as budget, exploration_wallet as wallet
from app.services import exploration_autonomy as autonomy, exploration_outbox as outbox
from app.services import exploration_projects as projects, qq_conversation, qq_proactive
from app.services.exploration_observation import observe
from tests import test_exploration_budget


class AutonomyTests(unittest.IsolatedAsyncioTestCase):
    setUp = test_exploration_budget.BudgetTests.setUp

    def fund(self, tokens=12000, speaker='dashiyin', enabled=True, key='test-private-wallet-key'):
        return wallet.save('dalaoda', speaker, 'https://wallet.invalid/v1', 'own-model', key, tokens, enabled)

    async def test_provider_balance_mode_ignores_local_caps_and_estimates_completed_usage(self):
        self.enable()
        wallet.save('dalaoda', 'dashiyin', 'https://wallet.invalid/v1', 'own-model', 'test-key', 0, True, provider_balance=True)
        autonomy.configure({**autonomy.settings(), 'run_tokens': 1, 'day_tokens': 1})
        self.identity(autonomous=True)
        self.provider.return_value['usage'] = {'prompt_tokens': 10, 'completion_tokens': 5, 'total_tokens': 1}
        await budget.complete('run', 0, self.messages, {})
        await budget.complete('run', 1, self.messages, {})
        self.assertEqual(self.provider.await_count, 2)
        self.assertGreater(wallet.listing()[0]['charged'], 1)
        self.assertEqual(wallet.listing()[0]['token_limit'], 0)
        self.assertFalse(budget.status()['uncertain'])
        with db._tx() as c:
            self.assertEqual([r[0] for r in c.execute('SELECT state FROM exploration_calls')], ['estimated', 'estimated'])

    async def test_provider_reported_total_preserves_raw_counts_without_full_reservation_charge(self):
        self.enable()
        wallet.save('dalaoda', 'dashiyin', 'https://wallet.invalid/v1', 'own-model', 'test-key', 0, True, provider_balance=True)
        self.identity(autonomous=True)
        self.provider.return_value['usage'] = {'prompt_tokens':3521, 'completion_tokens':1396, 'total_tokens':4976}
        # Make the preflight reservation larger than the returned report.
        await budget.complete('run', 0, [{'role':'user','content':'背景资料'*2000}], {})
        status=budget.status()
        self.assertEqual(status['charged'],4976)
        self.assertEqual(status['input'],3521)
        self.assertEqual(status['output'],1396)
        receipt=next(json.loads(a['content']) for a in status['artifacts'] if a['kind']=='usage_receipt')
        self.assertEqual(receipt['discrepancy'],59)
        self.assertEqual(receipt['accounting_basis'],'reported_max')
        self.assertGreater(receipt['reserved'],4976)
        self.assertFalse(status['uncertain'])

    async def test_provider_balance_mode_still_stops_on_network_failure_without_retry(self):
        self.enable()
        wallet.save('dalaoda', 'dashiyin', 'https://wallet.invalid/v1', 'own-model', 'test-key', 0, True, provider_balance=True)
        self.identity(autonomous=True)
        self.provider.side_effect = TimeoutError()
        with self.assertRaises(TimeoutError):
            await budget.complete('run', 0, self.messages, {})
        self.assertFalse(budget.status()['uncertain'])
        self.assertEqual(budget.status()['unconfirmed_calls'], 1)
        self.assertEqual(self.provider.await_count, 1)
        with self.assertRaises(HTTPException):
            await budget.complete('run', 1, self.messages, {})
        self.assertEqual(self.provider.await_count, 1)
        # A new owner message can start a fresh run without deleting the old bill.
        from app.services import exploration_conversations as chats
        reply = chats.receive('dalaoda', 'dashiyin', '继续分析这个问题', 'after-timeout')
        self.assertTrue(reply['accepted'])
        session = qq_conversation.context('dashiyin', False, 'dalaoda')
        budget.begin('fresh', session)
        self.identity(run='fresh', autonomous=True)
        self.provider.side_effect = None
        await budget.complete('fresh', 0, self.messages, {})
        self.assertEqual(self.provider.await_count, 2)
        db.set_feature_settings('qq_bridge', {'owner.qq': '20002'})
        budget.finish('fresh')
        plan = {'channel': 'private', 'actions': [{'type': 'text', 'speaker': 'dashiyin', 'text': '新的分析结果'}]}
        self.assertTrue(outbox.submit('fresh', session, plan))
        self.assertEqual(outbox.claim(session, '20002', 0)['run_id'], 'fresh')
        with db._tx() as c:
            self.assertEqual(c.execute("SELECT state FROM exploration_calls WHERE id='run:0'").fetchone()[0], 'unknown')
            self.assertGreater(c.execute("SELECT reserved FROM exploration_calls WHERE id='run:0'").fetchone()[0], 0)
        budget.stop()
        reply = chats.receive('dalaoda', 'dashiyin', '继续', 'after-explicit-pause')
        self.assertFalse(reply['accepted'])

    def identity(self, run='run', speaker='dashiyin', autonomous=False):
        budget.artifact(run, -1, 'identity', {'speaker': speaker, 'channels': ['private'], 'autonomous': autonomous})

    def enable(self):
        autonomy.configure({'enabled': True, 'continuous': False, 'qq_account_index': 0, 'min_minutes': 5, 'max_minutes': 5,
                            'daily_opportunities': 6, 'run_tokens': 12000, 'day_tokens': 24000})

    def queue(self):
        self.enable()
        db.set_feature_settings('qq_bridge', {'owner.qq': '20002', 'proactive.enabled': False})
        session = qq_conversation.context('dashiyin', False, 'dalaoda')
        plan = {'run_id': 'run', 'intent': 'say', 'channel': 'private', 'actions': [
            {'type': 'text', 'speaker': 'dashiyin', 'text': '这个项目好想做完呀，去前端给我点预算嘛'}]}
        self.identity()
        budget.finish('run')
        self.assertTrue(outbox.submit('run', session, plan))
        return session, plan

    @unittest.skipUnless(os.name == 'nt', 'Windows DPAPI')
    async def test_dpapi_roundtrip_and_no_plaintext_in_database_or_metadata(self):
        secret = 'private-test-only-key'
        cipher = wallet.crypt(secret)
        self.assertNotIn(secret, cipher)
        self.assertEqual(wallet.crypt(cipher, decrypt=True), secret)
        self.fund(key=secret)
        with db._tx() as c:
            stored = c.execute('SELECT secret FROM exploration_wallets').fetchone()[0]
        self.assertNotIn(secret, stored)
        self.assertNotIn(secret, json.dumps(wallet.listing()))

    async def test_wallet_uses_own_provider_without_shared_config(self):
        self.fund(); self.identity()
        await budget.complete('run', 0, self.messages, {})
        self.assertEqual(self.provider.await_args.kwargs['model'], 'own-model')
        self.assertEqual(self.provider.await_args.kwargs['api_key'], 'test-private-wallet-key')
        self.assertEqual(wallet.listing()[0]['charged'], 120)

    async def test_wallet_topup_replay_does_not_add_twice(self):
        args = ('dalaoda', 'dashiyin', 'https://wallet.invalid', 'own', 'test-key', 12000, True)
        ident = wallet.save(*args, operation_id='save-once')
        self.assertEqual(wallet.save(*args, operation_id='save-once'), ident)
        self.assertEqual(wallet.listing()[0]['token_limit'], 12000)
        with self.assertRaises(HTTPException):
            wallet.save(*args[:-2], 24000, True, operation_id='save-once')

    async def test_unknown_usage_keeps_wallet_reservation_and_does_not_borrow_other_wallet(self):
        self.fund(12000); self.fund(12000, speaker='xiaoshiyin'); self.identity()
        self.provider.return_value.pop('usage')
        with self.assertRaises(HTTPException):
            await budget.complete('run', 0, self.messages, {})
        own = next(w for w in wallet.listing() if w['speaker'] == 'dashiyin')
        other = next(w for w in wallet.listing() if w['speaker'] == 'xiaoshiyin')
        self.assertGreater(own['charged'], 600)
        self.assertEqual(other['charged'], 0)
        self.assertTrue(budget.status()['uncertain'])

    async def test_allowance_is_cumulative_and_topup_does_not_reset_usage(self):
        self.fund(1300); self.identity()
        await budget.complete('run', 0, self.messages, self.cfg)
        with self.assertRaises(HTTPException):
            await budget.complete('run', 1, self.messages, self.cfg, max_tokens=700)
        self.fund(1000, key='')
        self.assertEqual(wallet.listing()[0]['charged'], 120)
        await budget.complete('run', 1, self.messages, self.cfg)
        self.assertEqual(wallet.listing()[0]['remaining'], 2060)

    async def test_rotation_disable_and_reenable_cannot_revive_old_run(self):
        self.fund(); self.identity()
        await budget.complete('run', 0, self.messages, self.cfg)
        self.fund(0, key='', enabled=False)
        self.assertFalse(budget.active('run'))
        self.fund(0, key='', enabled=True)
        with self.assertRaises(HTTPException):
            await budget.complete('run', 1, self.messages, self.cfg)
        self.assertEqual(self.provider.await_count, 1)

    async def test_missing_key_or_invalid_endpoint_is_rejected(self):
        with self.assertRaises(HTTPException):
            self.fund(key='')
        with self.assertRaises(HTTPException) as exc:
            wallet.save('dalaoda', 'dashiyin', 'https://example.com:bad', 'm', '', 0, False)
        self.assertEqual(exc.exception.status_code, 422)

    async def test_wallet_money_cannot_replace_project_permission(self):
        self.fund(200000); self.identity()
        await budget.complete('run', 0, self.messages, self.cfg)
        with self.assertRaises(HTTPException):
            projects.check_run('run', 'codex')

    async def test_own_observation_does_not_contain_keys_or_other_role_projects(self):
        self.fund(); self.identity()
        projects.propose('dalaoda', 'dashiyin', '自己的观察', '只读')
        projects.propose('dalaoda', 'xiaoshiyin', 'OTHER-PRIVATE-PROJECT', 'private')
        result = observe('run', 'dalaoda', 'dashiyin')
        text = json.dumps(result)
        self.assertNotIn('test-private-wallet-key', text)
        self.assertNotIn('wallet.invalid', text)
        self.assertNotIn('OTHER-PRIVATE-PROJECT', text)
        with self.assertRaises(HTTPException):
            observe('run', 'dalaoda', 'xiaoshiyin')

    async def test_clock_ignores_bridge_enabled_frequency_and_chat_state(self):
        self.enable(); self.fund()
        db.set_feature_settings('qq_bridge', {'proactive.enabled': False, 'proactive.day_tokens': 0,
                                            'proactive.min_minutes': 1440, 'proactive.daily_limit': 0})
        self.assertIsNone(autonomy.claim())
        with db._tx() as c:
            c.execute('UPDATE exploration_clock SET next_at=?', (time.time()-1,))
        selected = autonomy.claim()
        self.assertEqual(selected[0]['speaker'], 'dashiyin')
        self.assertIsNone(autonomy.claim())  # one persisted lease, not concurrent play
        self.assertEqual(budget.limits(), (12000, 24000))

    async def test_no_wallet_no_paid_clock_and_no_restart_catchup(self):
        self.enable()
        self.assertIsNone(autonomy.claim())
        self.fund(); self.assertIsNone(autonomy.claim())
        with db._tx() as c:
            c.execute('UPDATE exploration_clock SET next_at=?', (time.time()-601,))
        self.assertIsNone(autonomy.claim())
        self.assertEqual(autonomy.status()['clock']['count'], 0)

    async def test_global_pause_and_disable_stop_independent_execution(self):
        self.enable(); self.identity(autonomous=True)
        self.fund()
        await budget.complete('run', 0, self.messages, {})
        autonomy.configure({**autonomy.settings(), 'enabled': False})
        self.assertFalse(budget.active('run'))
        with self.assertRaises(HTTPException):
            await budget.complete('run', 1, self.messages, {})

    async def test_notify_budget_wish_before_any_project_grant_once(self):
        session, plan = self.queue()
        project = projects.propose('dalaoda', 'dashiyin', '好想捏桌宠', '只在工作区玩')
        projects.request_more(project, 'dalaoda', 'dashiyin', '想继续')
        item = outbox.claim(session, '20002', 0)
        self.assertEqual(item['plan'], plan)
        self.assertEqual(outbox.claim(session, '20002', 0), {})
        self.assertEqual(projects.listing()[0]['requests'][0]['state'], 'pending')
        self.assertIsNone(projects.attach('run', 'dalaoda', 'dashiyin'))
        outbox.acknowledge('run', True)
        self.assertEqual(outbox.listing()[0]['state'], 'sent')

    async def test_expiry_owner_change_and_unknown_delivery_never_resend(self):
        session, _ = self.queue()
        db.set_feature_settings('qq_bridge', {'owner.qq': '30003'})
        self.assertEqual(outbox.claim(session, '30003', 0), {})
        self.assertEqual(outbox.listing()[0]['state'], 'cancelled')

    async def test_expired_and_paused_notifications_are_cancelled(self):
        session, _ = self.queue()
        with db._tx() as c:
            c.execute('UPDATE exploration_outbox SET expires=?', (time.time()-1,))
        self.assertEqual(outbox.claim(session, '20002', 0), {})
        self.assertEqual(outbox.listing()[0]['state'], 'cancelled')

    async def test_real_planner_reflects_then_queues_message_with_own_model_no_qq_process(self):
        self.fund(50000); self.enable()
        autonomy.configure({**autonomy.settings(), 'run_tokens': 30000, 'day_tokens': 60000})
        db.set_feature_settings('qq_bridge', {'owner.qq': '20002', 'proactive.enabled': False})
        responses = [json.dumps({'intent': 'self_observe'}), json.dumps({'intent': 'say', 'actions': [
            {'type': 'text', 'speaker': 'dashiyin', 'text': '我看了自己的权限，好想在工作区捏个小东西呀'}]})]
        self.provider.side_effect = [{'content': text, 'finish_reason': 'stop',
            'usage': {'prompt_tokens': 100, 'completion_tokens': 20}} for text in responses]
        with patch('app.routers.nest._effective_config', return_value={}), patch.object(budget, 'sync_activity'), \
                patch.object(budget, 'sync_pending'), patch('app.services.persona_memory.injectable', return_value=([], None)):
            await autonomy.explore(wallet.listing()[0], 'independent-test')
        self.assertEqual(self.provider.await_count, 2)
        self.assertEqual(self.provider.await_args.kwargs['model'], 'own-model')
        self.assertEqual(outbox.listing()[0]['state'], 'pending')
        self.assertTrue(any(a['kind'] == 'self_observe' for a in budget.status()['artifacts']))

    async def test_delivery_past_execution_deadline_is_not_extra_model_authority(self):
        session, _ = self.queue()
        with db._tx() as c:
            c.execute('UPDATE exploration_runs SET created=? WHERE id=?', (time.time()-650, 'run'))
        self.assertTrue(outbox.claim(session, '20002', 0))
        self.assertIn('run', budget.status()['publishable_runs'])
        with self.assertRaises(HTTPException):
            budget.reserve('run', 0, self.messages, 600)
        outbox.acknowledge('run', False)
        self.assertEqual(outbox.listing()[0]['state'], 'unknown')
        self.assertEqual(outbox.claim(session, '20002', 0), {})

    async def test_dashboard_only_wallet_and_clock_mutations(self):
        app = FastAPI(); app.include_router(router.router, prefix='/api'); app.include_router(qq_bridge.router, prefix='/api')
        with TestClient(app) as client:
            payload = {'persona': 'dalaoda', 'speaker': 'dashiyin', 'base_url': 'https://wallet.invalid',
                       'model': 'own', 'api_key': 'test-private-wallet-key', 'add_tokens': 12000, 'enabled': True}
            self.assertEqual(client.put('/api/exploration-projects/wallets', json=payload).status_code, 403)
            self.assertEqual(client.put('/api/exploration-projects/wallets', json=payload,
                             headers={'X-Exploration-Dashboard': '1'}).status_code, 200)
            response = client.get('/api/exploration-projects/wallets', headers={'X-Exploration-Dashboard': '1'})
            self.assertNotIn(payload['api_key'], response.text)
            self.assertEqual(client.put('/api/exploration-projects/autonomy', json={'enabled': True}).status_code, 403)
            self.assertEqual(client.post('/api/qq-bridge/exploration-outbox/claim', json={'session': {}, 'owner': '20002', 'account': 0},
                             headers={'Origin': 'https://evil.invalid'}).status_code, 403)


if __name__ == '__main__':
    unittest.main()
