"""自我档案 prompt 注入插件（§23）。

被 backend/app/services/prompt/assembler.py 调用，插入位置在「用户身份」块之后、世界书之前。
"""

from __future__ import annotations

from .. import self_profile as sp

# 总 token 上限（按中文约 1 字 ≈ 1 token，2000 字 ≈ 2000 token）
DEFAULT_MAX_CHARS = 2000

# inject 块的标题
_BLOCK_HEADER = "【用户档案 · 她们了解你的片段】"


def inject_self_profile(persona: dict, character_ids: list[str]) -> str:
    """返回注入块字符串；如果没有可注入内容则返回空字符串。"""
    persona_id = persona.get("id") or ""
    if not persona_id:
        return ""

    blocks = sp.get_injectable_texts(persona_id, character_ids)
    if not blocks:
        return ""

    parts: list[str] = [_BLOCK_HEADER, ""]

    # 按标题分节
    for block in blocks:
        title = (block.get("title") or "").strip()
        content = (block.get("content") or "").strip()
        if not content:
            continue
        if title:
            parts.append(f"--- {title} ---")
        parts.append(content)
        parts.append("")

    text = "\n".join(parts).strip()
    if not text:
        return ""

    # 超长截断（按优先级：精确命中 > all，先建 > 后建）
    return _truncate(text, DEFAULT_MAX_CHARS)


def _truncate(text: str, max_chars: int) -> str:
    if len(text) <= max_chars:
        return text
    return text[: max_chars - 3] + "…"
