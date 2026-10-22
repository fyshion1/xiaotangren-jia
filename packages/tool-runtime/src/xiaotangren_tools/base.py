"""Trusted registrations and typed inputs; model messages never define executables."""
from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from pydantic import BaseModel, ConfigDict


class Arguments(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


@dataclass(frozen=True)
class ToolContext:
    # Supplied by the authenticated transport, never by the model arguments.
    actor_id: str = ""
    owner_id: str = ""
    conversation_id: str = ""
    call_id: str = ""


@dataclass(frozen=True)
class Tool:
    name: str
    description: str
    arguments: type[Arguments]
    handler: Callable[[Arguments, ToolContext], str | Awaitable[str]]
    timeout_seconds: float = 10.0
    # Proposals may persist drafts, but must never activate an external action.
    # Writes require an explicit allow_writes policy and never retry automatically.
    risk: str = "read"
    max_attempts: int = 1


@dataclass(frozen=True)
class ToolResult:
    ok: bool
    code: str
    content: str
    attempts: int = 0
    truncated: bool = False


class ToolDenied(RuntimeError):
    """Safe, user-facing policy or filesystem rejection."""


class ToolTransientError(RuntimeError):
    """An adapter explicitly marks a read failure as safe to retry."""
