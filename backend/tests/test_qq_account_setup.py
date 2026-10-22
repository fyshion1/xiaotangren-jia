import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.services import qq_account_setup as setup
from app.services.snowluma import SnowLumaError
from app.routers import qq_bridge


class AccountSetupTests(unittest.TestCase):
    def test_multi_account_start_does_not_unload_other_accounts(self):
        from app.routers.nest import _auto_swap_bot
        with patch('app.routers.nest._setting', return_value=[{'self_id': '11111'}]), patch('app.services.snowluma.ensure_bot_account') as exclusive:
            self.assertTrue(_auto_swap_bot('qq_bridge', {})['ok'])
            exclusive.assert_not_called()

    def test_only_selected_gateway_config_changes_and_ports_are_isolated(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory) / 'config'
            folder.mkdir()
            config = {'networks': {'httpServers': [{'port': 3000}], 'wsServers': [
                {'port': 3001, 'host': '127.0.0.1', 'accessToken': 'test-secret'}]}}
            other = folder / 'onebot_22222.json'
            other.write_text(json.dumps(config))
            original = other.read_bytes()
            gateway = MagicMock()
            gateway.config.return_value = copy.deepcopy(config)
            with patch.object(setup, 'client') as client, patch.object(setup, 'logged_in', return_value={'11111': 1}), patch('app.routers.nest._gateway_spec', return_value={'folder': directory}):
                client.return_value.__enter__.return_value = gateway
                result = setup.prepare('11111')
            self.assertNotIn(':3001', result['ws_url'])
            self.assertEqual(result['access_token'], 'test-secret')
            self.assertEqual(other.read_bytes(), original)
            self.assertEqual(gateway.save_config.call_args.args[0], '11111')
            saved = gateway.save_config.call_args.args[1]
            ports = [saved['networks']['httpServers'][0]['port'], saved['networks']['wsServers'][0]['port'], result['listen_port']]
            self.assertEqual(len(set(ports)), 3)
            gateway.unload.assert_not_called()

    def test_logged_out_account_never_changes_config(self):
        with patch.object(setup, 'client') as client, patch.object(setup, 'logged_in', return_value={}):
            with self.assertRaises(SnowLumaError):
                setup.prepare('11111')
            client.return_value.__enter__.return_value.save_config.assert_not_called()

    def test_dashboard_guard_and_partial_failure(self):
        app = FastAPI()
        app.include_router(qq_bridge.router, prefix='/api')
        with TestClient(app) as client:
            self.assertEqual(client.get('/api/qq-bridge/setup/accounts').status_code, 403)
            headers = {'X-Exploration-Dashboard': '1'}
            self.assertEqual(client.post('/api/qq-bridge/setup/prepare', headers=headers, json={'self_id': '../other'}).status_code, 422)
            connection = {'self_id': '11111', 'ws_url': 'ws://127.0.0.1:3100/', 'access_token': '', 'listen_port': 3101}
            with patch.object(setup, 'prepare', return_value=connection), patch.object(setup, 'contacts', new=AsyncMock(side_effect=TimeoutError)):
                response = client.post('/api/qq-bridge/setup/prepare', headers=headers, json={'self_id': '11111'})
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()['connection'], connection)
                self.assertNotIn('groups', response.json())
                self.assertIn('warning', response.json())
            self.assertEqual(client.get('/api/qq-bridge/setup/accounts', headers={**headers, 'Origin': 'https://evil.example'}).status_code, 403)


class ContactTests(unittest.IsolatedAsyncioTestCase):
    async def test_choices_use_enabled_order_and_do_not_expose_credentials(self):
        values = {'accounts': [
            {'self_id': '11111', 'name': '普通号', 'enabled': False},
            {'self_id': '22222', 'name': '独立号', 'access_token': 'private-test-token'}],
            'onebot.ws_url': 'ws://127.0.0.1:3001/', 'onebot.access_token': 'fallback-test-token'}
        with patch('app.routers.nest._setting', side_effect=lambda feature, key, default=None: values.get(key, default)), patch.object(setup, 'login_identity', new=AsyncMock(return_value={'self_id': '22222', 'nickname': 'QQ昵称'})):
            items = await setup.choices()
        self.assertEqual(items, [{'index': 0, 'self_id': '22222', 'name': '独立号', 'nickname': 'QQ昵称', 'status': 'connected'}])
        self.assertNotIn('token', json.dumps(items))

    async def test_offline_default_account_remains_selectable(self):
        with patch('app.routers.nest._setting', side_effect=lambda feature, key, default=None: {'onebot.self_id': '11111'}.get(key, default)), patch.object(setup, 'login_identity', new=AsyncMock(side_effect=TimeoutError)):
            items = await setup.choices()
        self.assertEqual(items[0]['index'], 0)
        self.assertEqual(items[0]['self_id'], '11111')
        self.assertEqual(items[0]['status'], 'unavailable')

    async def test_nickname_lookup_rejects_nonlocal_gateway(self):
        with self.assertRaises(SnowLumaError):
            await setup.login_identity({'ws_url': 'ws://example.org:3001/', 'access_token': 'never-send'})

    async def test_only_reads_lists_after_matching_identity(self):
        ws = AsyncMock()
        sent = []
        async def send(payload):
            sent.append(json.loads(payload))
        async def recv():
            data = {'get_login_info': {'user_id': 11111}, 'get_group_list': [{'group_id': 33333, 'group_name': '群'}],
                    'get_friend_list': [{'user_id': 44444, 'nickname': '昵称', 'remark': '备注'}]}
            return json.dumps({'echo': sent[-1]['echo'], 'retcode': 0, 'data': data[sent[-1]['action']]})
        ws.send.side_effect = send
        ws.recv.side_effect = recv
        manager = MagicMock()
        manager.__aenter__ = AsyncMock(return_value=ws)
        manager.__aexit__ = AsyncMock(return_value=False)
        with patch('websockets.asyncio.client.connect', return_value=manager):
            result = await setup.contacts({'self_id': '11111', 'ws_url': 'ws://127.0.0.1:3100/', 'access_token': ''})
        self.assertEqual(result, {'groups': [{'id': '33333', 'name': '群'}], 'private': [{'id': '44444', 'name': '备注'}]})
        self.assertEqual([x['action'] for x in sent], ['get_login_info', 'get_group_list', 'get_friend_list'])

    async def test_identity_mismatch_stops_before_contact_reads(self):
        ws = AsyncMock()
        sent = []
        async def send(payload):
            sent.append(json.loads(payload))
        async def recv():
            return json.dumps({'echo': sent[-1]['echo'], 'retcode': 0, 'data': {'user_id': 22222}})
        ws.send.side_effect = send
        ws.recv.side_effect = recv
        manager = MagicMock()
        manager.__aenter__ = AsyncMock(return_value=ws)
        manager.__aexit__ = AsyncMock(return_value=False)
        with patch('websockets.asyncio.client.connect', return_value=manager):
            with self.assertRaises(SnowLumaError):
                await setup.contacts({'self_id': '11111', 'ws_url': 'ws://127.0.0.1:3100/', 'access_token': 'test'})
        self.assertEqual([x['action'] for x in sent], ['get_login_info'])
