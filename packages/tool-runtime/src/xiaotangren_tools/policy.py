from dataclasses import dataclass

from .base import ToolContext, ToolDenied


@dataclass(frozen=True)
class ToolPolicy:
    enabled: bool = False
    allowed_names: frozenset[str] = frozenset()
    require_owner: bool = True
    owner_tools_enabled: bool = True
    max_output_chars: int = 8000
    max_argument_bytes: int = 16384
    allow_proposals: bool = False
    allow_writes: bool = False

    def __post_init__(self):
        object.__setattr__(self, "allowed_names", frozenset(self.allowed_names))
        if type(self.max_output_chars) is not int or not 100 <= self.max_output_chars <= 60000:
            raise ValueError("max_output_chars must be in [100, 60000]")
        if type(self.max_argument_bytes) is not int or not 100 <= self.max_argument_bytes <= 65536:
            raise ValueError("max_argument_bytes must be in [100, 65536]")

    def check(self, name: str, context: ToolContext) -> None:
        if not self.enabled:
            raise ToolDenied("本地小工具没打开")
        if name not in self.allowed_names:
            raise ToolDenied("这个工具没被允许用")
        if self.require_owner and (
            not self.owner_tools_enabled or not context.owner_id
            or context.actor_id != context.owner_id
        ):
            raise ToolDenied("只有已配置的大老大能使用工具")
