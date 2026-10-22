from __future__ import annotations

import math
import re

from .base import Arguments, Tool


class ToolRegistry:
    def __init__(self):
        self._tools: dict[str, Tool] = {}

    def register(self, tool: Tool) -> None:
        if not re.fullmatch(r"[a-zA-Z_][a-zA-Z0-9_]{0,63}", tool.name):
            raise ValueError("Invalid tool name")
        if tool.name in self._tools:
            raise ValueError(f"Duplicate tool: {tool.name}")
        if tool.risk not in ("read", "proposal", "write"):
            raise ValueError("Unsupported tool risk")
        if tool.risk in ("proposal", "write") and tool.max_attempts != 1:
            raise ValueError("Persisting tools cannot retry automatically")
        if not math.isfinite(tool.timeout_seconds) or not 0 < tool.timeout_seconds <= 60:
            raise ValueError("Tool timeout must be in (0, 60]")
        if tool.max_attempts not in (1, 2, 3):
            raise ValueError("Tool attempts must be in [1, 3]")
        if not issubclass(tool.arguments, Arguments) or not callable(tool.handler):
            raise ValueError("Tool requires typed arguments and a callable")
        self._tools[tool.name] = tool

    def get(self, name: str) -> Tool | None:
        return self._tools.get(name)

    def names(self) -> tuple[str, ...]:
        return tuple(self._tools)

    def schemas(self, names: frozenset[str]) -> list[dict]:
        return [{"type": "function", "function": {
            "name": tool.name, "description": tool.description,
            "parameters": tool.arguments.model_json_schema(),
        }} for tool in self._tools.values() if tool.name in names]
