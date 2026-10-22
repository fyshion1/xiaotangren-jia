import asyncio
import json
import unittest
from unittest.mock import AsyncMock

from pydantic import Field
from xiaotangren_tools import (
    AgentLimits,
    AgentRunner,
    Arguments,
    Tool,
    ToolContext,
    ToolExecutor,
    ToolPolicy,
    ToolRegistry,
)


class ReadArgs(Arguments):
    path: str = Field(min_length=1)


def decision(arguments='{"path":"note.txt"}', name="read", call_id="model-call"):
    return {"content": "", "tool_calls": [{"id": call_id, "type": "function",
            "function": {"name": name, "arguments": arguments}}]}


class AgentTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.calls, self.events = [], []
        self.context = ToolContext("owner", "owner", "session")
        self.registry = ToolRegistry()

        def handler(args, context):
            self.calls.append(args.path)
            return "real result"

        self.registry.register(Tool("read", "read", ReadArgs, handler))
        self.executor = ToolExecutor(self.registry, ToolPolicy(enabled=True, allowed_names={"read"}))

    async def emit(self, event):
        self.events.append(event)

    async def test_native_tool_round_trip(self):
        complete = AsyncMock(side_effect=[decision(), {"content": "final", "finish_reason": "stop"}])
        result = await AgentRunner(self.executor, complete).run([], self.context, self.emit)
        self.assertEqual(result.content, "final")
        self.assertEqual(self.calls, ["note.txt"])
        history = complete.await_args_list[1].args[0]
        self.assertEqual(history[-1]["role"], "tool")
        self.assertEqual(history[-1]["tool_call_id"], history[-2]["tool_calls"][0]["id"])
        self.assertEqual(json.loads(history[-1]["content"])["content"], "real result")
        self.assertEqual([e["type"] for e in self.events], ["agent_status", "tool_start", "tool_result", "agent_status"])

    async def test_web_search_start_event_exposes_bounded_query(self):
        self.registry.register(Tool("web_search", "search", ReadArgs,
            lambda args, context: "search result"))
        self.executor = ToolExecutor(self.registry, ToolPolicy(enabled=True, allowed_names={"web_search"}))
        complete = AsyncMock(side_effect=[decision('{"query":"765PRO Thank You 歌词"}', "web_search"),
                                          {"content": "final", "finish_reason": "stop"}])
        await AgentRunner(self.executor, complete).run([], self.context, self.emit)
        started = next(event for event in self.events if event["type"] == "tool_start")
        self.assertEqual(started["query"], "765PRO Thank You 歌词")

    async def test_duplicate_normalizes_json_and_does_not_execute_again(self):
        complete = AsyncMock(side_effect=[decision(), decision(' { "path" : "note.txt" } ')])
        result = await AgentRunner(self.executor, complete).run([], self.context, self.emit)
        self.assertEqual(result.status, "stopped")
        self.assertEqual(self.calls, ["note.txt"])
        self.assertEqual(self.events[-1]["code"], "duplicate_call")

    async def test_parameter_error_can_be_corrected_once(self):
        complete = AsyncMock(side_effect=[decision('{"path":3}'), decision(), {"content": "final"}])
        result = await AgentRunner(self.executor, complete).run([], self.context, self.emit)
        self.assertEqual(result.status, "completed")
        self.assertEqual(self.calls, ["note.txt"])
        self.assertEqual(self.events[2]["code"], "invalid_arguments")

    async def test_second_invalid_argument_stops(self):
        complete = AsyncMock(side_effect=[decision('{"path":3}'), decision('{"path":4}')])
        result = await AgentRunner(self.executor, complete).run([], self.context, self.emit)
        self.assertEqual(result.status, "stopped")
        self.assertIn("校验", result.content)
        self.assertEqual(self.calls, [])

    async def test_batch_and_total_call_budgets(self):
        batch = decision()
        batch["tool_calls"] *= 4
        complete = AsyncMock(return_value=batch)
        result = await AgentRunner(self.executor, complete).run([], self.context, self.emit)
        self.assertEqual(result.status, "stopped")
        self.assertEqual(self.calls, [])
        complete = AsyncMock(side_effect=[decision(), decision('{"path":"second"}')])
        result = await AgentRunner(self.executor, complete, AgentLimits(tool_calls=1)).run([], self.context, self.emit)
        self.assertEqual(result.status, "stopped")
        self.assertEqual(self.calls, ["note.txt"])

    async def test_model_turn_budget(self):
        complete = AsyncMock(return_value=decision())
        result = await AgentRunner(self.executor, complete, AgentLimits(model_turns=1)).run([], self.context, self.emit)
        self.assertEqual(result.status, "stopped")
        self.assertEqual(complete.await_count, 1)

    async def test_total_timeout_cancels_model_wait(self):
        cancelled = asyncio.Event()

        async def model(history, schemas):
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()

        result = await AgentRunner(self.executor, model, AgentLimits(timeout_seconds=0.01)).run([], self.context, self.emit)
        self.assertEqual(result.status, "stopped")
        self.assertTrue(cancelled.is_set())
        self.assertEqual(self.events[-1]["code"], "timeout")

    async def test_caller_cancellation_propagates(self):
        entered = asyncio.Event()

        async def model(history, schemas):
            entered.set()
            await asyncio.Event().wait()

        task = asyncio.create_task(AgentRunner(self.executor, model).run([], self.context, self.emit))
        await entered.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task

    async def test_invalid_tool_protocol_and_unknown_tool(self):
        complete = AsyncMock(return_value={"tool_calls": ["broken"]})
        result = await AgentRunner(self.executor, complete).run([], self.context, self.emit)
        self.assertEqual(result.status, "stopped")
        complete = AsyncMock(side_effect=[decision(name="shell"), {"content": "cannot execute"}])
        await AgentRunner(self.executor, complete).run([], self.context, self.emit)
        self.assertEqual(self.calls, [])
        self.assertEqual(self.events[-2]["code"], "denied")


if __name__ == "__main__":
    unittest.main()
