import asyncio
import json
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient
from xiaotangren_tools import ToolContext, ToolExecutor, ToolPolicy, ToolRegistry

from app.services import agent_tools, project_costs
from app.routers import project_costs as gateway


class ProjectCostsToolsTests(unittest.TestCase):
    def test_daily_record_defaults_to_beijing_period_and_preserves_explicit_time(self):
        async def check():
            response = httpx.Response(200, json={'content': '骑车'})
            context = ToolContext('owner', 'owner', 'chat', 'daily-call')
            fixed = datetime(2026, 10, 20, 20, 15, tzinfo=timezone(timedelta(hours=8)))
            with patch('xiaotangren_tools.project_tools.datetime') as clock, patch.object(project_costs, 'request', AsyncMock(return_value=response)) as request:
                clock.now.return_value = fixed
                await project_costs.daily_record(project_costs.DailyInput(kind='exercise', content='骑车'), context)
                payload = json.loads(request.await_args.kwargs['content'])
                self.assertEqual(payload, dict(occurred_on='2026-10-20', period='晚上', kind='exercise', content='骑车'))
                self.assertEqual(request.await_args.kwargs['request_key'], 'daily-call')
                await project_costs.daily_record(project_costs.DailyInput(kind='diet', content='牛肉面', occurred_on='2026-10-19', period='下午'), context)
                self.assertEqual(json.loads(request.await_args.kwargs['content'])['period'], '下午')
                await project_costs.daily_record(project_costs.DailyInput(kind='diet', content='午饭', period='中午'), context)
                self.assertEqual(json.loads(request.await_args.kwargs['content'])['period'], '中午')
                clock.now.return_value = fixed.replace(hour=12)
                await project_costs.daily_record(project_costs.DailyInput(kind='diet', content='午饭'), context)
                self.assertEqual(json.loads(request.await_args.kwargs['content'])['period'], '中午')
            registry = ToolRegistry()
            for tool in project_costs.tools():
                registry.register(tool)
            executor = ToolExecutor(registry, ToolPolicy(enabled=True, allow_writes=True, allowed_names={'daily_life_record'}))
            with patch.object(project_costs, 'request', AsyncMock(side_effect=httpx.ConnectError('offline'))):
                result = await executor.execute('daily_life_record', {'kind': 'exercise', 'content': '骑车'}, context)
                self.assertFalse(result.ok)
                self.assertIn('不要声称已记录', result.content)
            denied = await executor.execute('daily_life_record', {'kind': 'exercise', 'content': '骑车'}, ToolContext('other', 'owner'))
            self.assertEqual(denied.code, 'denied')
        asyncio.run(check())

    def test_gateway_preserves_binary_upload_and_uses_active_identity(self):
        app = FastAPI()
        app.include_router(gateway.router)
        payload = b'\x00\xff\xd0\xcf\x11\xe0binary'
        response = httpx.Response(200, json={'added': 1})
        with TestClient(app) as client, patch.object(gateway.db, 'get_active_persona_id', return_value='active'), patch.object(project_costs, 'request', AsyncMock(return_value=response)) as request:
            result = client.post('/project-costs/imports', content=payload, headers={'Content-Type': 'multipart/form-data; boundary=test', 'X-Costs-Persona': 'spoofed'})
            self.assertEqual(result.status_code, 200)
            self.assertEqual(request.await_args.args, ('POST', 'imports', 'active'))
            self.assertEqual(request.await_args.kwargs['content'], payload)
            self.assertEqual(client.get('/project-costs/../private').status_code, 404)

    def test_new_tools_are_opt_in_and_existing_settings_remain_valid(self):
        settings = agent_tools.ToolSettings()
        self.assertNotIn('project_cost_record', settings.allowed_names)
        all_names = [item['name'] for item in agent_tools.CAPABILITIES]
        self.assertEqual(agent_tools.ToolSettings(allowed_names=all_names).allowed_names, all_names)

    def test_write_success_owner_boundary_and_offline_failure(self):
        async def check():
            registry = ToolRegistry()
            for tool in project_costs.tools():
                registry.register(tool)
            executor = ToolExecutor(registry, ToolPolicy(enabled=True, allow_writes=True, allowed_names={'project_cost_record'}))
            arguments = {'occurred_on': '2026-10-20', 'amount': '100.00', 'merchant': 'API平台'}
            owner = ToolContext('owner', 'owner', 'chat', 'call-1')
            response = httpx.Response(200, json={'id': 'entry', 'amount_cents': 10000})
            with patch.object(project_costs, 'request', AsyncMock(return_value=response)) as request:
                result = await executor.execute('project_cost_record', arguments, owner)
                self.assertTrue(result.ok)
                self.assertTrue(json.loads(result.content)['saved'])
                self.assertEqual(request.await_args.kwargs['request_key'], 'call-1')
                denied = await executor.execute('project_cost_record', arguments, ToolContext('other', 'owner'))
                self.assertEqual(denied.code, 'denied')
                self.assertEqual(request.await_count, 1)
            with patch.object(project_costs, 'request', AsyncMock(side_effect=httpx.ConnectError('offline'))):
                result = await executor.execute('project_cost_record', arguments, owner)
                self.assertFalse(result.ok)
                self.assertIn('不要声称已保存', result.content)
        asyncio.run(check())
