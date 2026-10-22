"""One checked call, not an agent loop. No network service or shell execution."""
from __future__ import annotations

import asyncio
import inspect
import json
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass

from pydantic import ValidationError

from .base import ToolContext, ToolDenied, ToolResult, ToolTransientError
from .policy import ToolPolicy
from .registry import ToolRegistry

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ToolAuditEvent:
    name: str
    conversation_id: str
    call_id: str
    code: str
    attempts: int
    elapsed_ms: int
    truncated: bool


def log_audit(event: ToolAuditEvent) -> None:
    # Do not record arguments, file contents, credentials, or arbitrary exceptions.
    logger.info("tool_call %s", json.dumps(event.__dict__, ensure_ascii=True))


class ToolExecutor:
    def __init__(self, registry: ToolRegistry, policy: ToolPolicy,
                 audit: Callable[[ToolAuditEvent], None] = log_audit):
        self.registry, self.policy, self.audit = registry, policy, audit

    def schemas(self, context: ToolContext) -> list[dict]:
        names = set()
        for name in self.registry.names():
            try:
                self.policy.check(name, context)
                if self.registry.get(name).risk == 'proposal' and not self.policy.allow_proposals:
                    continue
                if self.registry.get(name).risk == 'write' and not self.policy.allow_writes:
                    continue
                names.add(name)
            except ToolDenied:
                pass
        return self.registry.schemas(frozenset(names))

    async def execute(self, name: str, arguments: str | dict,
                      context: ToolContext) -> ToolResult:
        started = time.monotonic()
        attempts = 0

        def finish(code: str, content: str) -> ToolResult:
            limit = self.policy.max_output_chars
            truncated = len(content) > limit
            if truncated:
                content = content[:limit - 6] + "\n…（截断）"
            result = ToolResult(code == "ok", code, content, attempts, truncated)
            event = ToolAuditEvent(name[:64], context.conversation_id[:160],
                                   context.call_id[:120], code, attempts,
                                   int((time.monotonic() - started) * 1000), truncated)
            try:
                self.audit(event)
            except Exception:
                logger.warning("Tool audit sink failed")
            return result

        tool = self.registry.get(name)
        try:
            self.policy.check(name, context)
            if tool is None:
                return finish("unknown_tool", "没有这个工具")
            if tool.risk == 'proposal' and not self.policy.allow_proposals:
                raise ToolDenied('未开启待确认操作')
            if tool.risk == 'write' and not self.policy.allow_writes:
                raise ToolDenied('未开启写入操作')
        except ToolDenied as exc:
            return finish("denied", str(exc))

        try:
            raw = arguments if isinstance(arguments, str) else json.dumps(arguments, allow_nan=False)
            if len(raw.encode("utf-8")) > self.policy.max_argument_bytes:
                return finish("invalid_arguments", "工具参数太长")
            args = tool.arguments.model_validate_json(raw, strict=True)
        except (ValidationError, ValueError, TypeError, OverflowError, RecursionError):
            return finish("invalid_arguments", "参数不符合工具声明：请检查 JSON、必填字段和类型")

        async def invoke():
            if inspect.iscoroutinefunction(tool.handler):
                return await tool.handler(args, context)
            result = await asyncio.to_thread(tool.handler, args, context)
            return await result if inspect.isawaitable(result) else result

        # One deadline includes all attempts. A timeout is never retried: a thread
        # may still be running. Only ToolTransientError explicitly allows retries.
        deadline = time.monotonic() + tool.timeout_seconds
        while attempts < tool.max_attempts:
            attempts += 1
            try:
                output = await asyncio.wait_for(invoke(), max(0, deadline - time.monotonic()))
                if not isinstance(output, str):
                    return finish("execution_error", "工具返回了不支持的结果类型")
                return finish("ok", output)
            except asyncio.TimeoutError:
                return finish("timeout", "工具执行超时，已停止等待；未自动重试")
            except asyncio.CancelledError:
                finish("cancelled", "工具调用已取消")
                raise
            except ToolDenied as exc:
                return finish("denied", f"做不了：{exc}")
            except ToolTransientError:
                if attempts == tool.max_attempts:
                    return finish("transient_error", "工具暂时不可用，请稍后再试")
                try:
                    await asyncio.sleep(min(0.05 * attempts, max(0, deadline - time.monotonic())))
                except asyncio.CancelledError:
                    finish("cancelled", "工具调用已取消")
                    raise
            except Exception:
                return finish("execution_error", "工具执行失败，请检查本地环境")
        raise AssertionError("Unreachable")
