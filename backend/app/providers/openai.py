"""大模型供应商适配层（多路切换）。

统一为「OpenAI 兼容」接口：/chat/completions 支持流式与非流式、
支持多模态图片 content。这样商业 API、第三方无审查中转、本地 Ollama
（OpenAI 兼容端点）都能用同一套代码切换。

阶段 0：只实现 OpenAI 兼容供应商（覆盖绝大多数来源）。
后续可在此目录下新增非 OpenAI 原生的供应商（如 Gemini 原生、Claude 原生）。
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator

import httpx

from ..config import get_settings
from ..services.prompt import build_system_prompt


def _base_url() -> str:
    return get_settings().model_base_url.rstrip("/")


def _headers() -> dict[str, str]:
    key = get_settings().model_api_key
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    return headers


def _messages_with_system(messages: list[dict]) -> list[dict]:
    system = build_system_prompt()
    base: list[dict] = [{"role": "system", "content": system}] if system else []
    return base + messages


async def stream_chat(messages: list[dict], model: str) -> AsyncIterator[str]:
    """流式聊天，逐块产出文本增量（SSE 友好）。"""
    payload = {
        "model": model,
        "messages": _messages_with_system(messages),
        "stream": True,
    }
    async with httpx.AsyncClient(timeout=httpx.Timeout(600.0, connect=30.0)) as client:
        async with client.stream(
            "POST",
            f"{_base_url()}/chat/completions",
            headers=_headers(),
            json=payload,
        ) as resp:
            resp.raise_for_status()
            async for line in resp.aiter_lines():
                if not line or not line.startswith("data:"):
                    continue
                data = line[len("data:") :].strip()
                if data == "[DONE]":
                    break
                try:
                    obj = json.loads(data)
                except json.JSONDecodeError:
                    continue
                delta = obj.get("choices", [{}])[0].get("delta", {})
                text = delta.get("content")
                if text:
                    yield text