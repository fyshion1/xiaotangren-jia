"""大模型供应商适配层（多路切换）。

统一为「OpenAI 兼容」接口：/chat/completions 支持流式与非流式、
支持多模态图片 content。这样商业 API、第三方无审查中转、本地 Ollama
（OpenAI 兼容端点）都能用同一套代码切换。

阶段 0：只实现 OpenAI 兼容供应商（覆盖绝大多数来源）。
后续可在此目录下新增非 OpenAI 原生的供应商（如 Gemini 原生、Claude 原生）。

低耦合约定：本层只暴露 stream_chat() 一个能力，调用方传入显式的
base_url / api_key / model；不读取全局配置，保持无状态、可测试。
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator

import httpx


async def stream_chat(
    messages: list[dict],
    model: str,
    base_url: str,
    api_key: str = "",
) -> AsyncIterator[str]:
    """流式聊天，逐块产出文本增量（SSE 友好）。"""
    base = base_url.rstrip("/")
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    payload = {
        "model": model,
        "messages": messages,
        "stream": True,
    }
    async with httpx.AsyncClient(timeout=httpx.Timeout(600.0, connect=30.0)) as client:
        async with client.stream(
            "POST",
            f"{base}/chat/completions",
            headers=headers,
            json=payload,
        ) as resp:
            if resp.status_code >= 400:
                # 上游报错时把真实响应体带上，方便定位（模型名/余额/限流等）。
                body = await resp.aread()
                raise httpx.HTTPStatusError(
                    f"上游 {resp.status_code}: {body.decode('utf-8', errors='replace')[:500]}",
                    request=resp.request,
                    response=resp,
                )
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
                choices = obj.get("choices") or []
                if not choices:
                    continue
                delta = choices[0].get("delta") or {}
                text = delta.get("content")
                if text:
                    yield text