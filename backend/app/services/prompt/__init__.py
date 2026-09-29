"""Prompt 组装引擎：人设 + 世界书 + 越狱规则 → 最终 system prompt。

阶段 2 现状：
- 人设：从 SQLite 读取在场角色，单角色直接扮演、多角色走「剧场」规则。
- 世界书：关键词扫描最近对话，命中启用条目才注入。
- 越狱：可编辑的全局「规则 / 越狱」文本框（默认空，不填则纯人设）。
- 记忆：三层 RAG（家 / 个人 / 会话）尚未实现（阶段 2 后半段），此处预留。
"""

from .assembler import build_system_prompt

__all__ = ["build_system_prompt"]