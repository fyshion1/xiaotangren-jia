"""大模型供应商适配层（多路切换）。

统一为「OpenAI 兼容」接口：/chat/completions 支持流式与非流式、
支持多模态图片 content；/images/generations 支持生图。这样商业 API、
第三方无审查中转、本地 Ollama（OpenAI 兼容端点）都能用同一套代码切换。

低耦合约定：本层只暴露 stream_chat() / stream_chat_retry() / complete_chat() /
generate_images() 四个能力，调用方传入显式的 base_url / api_key / model；不读取全局配置，
保持无状态、可测试。

stream_chat() 产出「事件 dict」而非纯文本增量，事件类型：
- {"type": "text", "text": ...}                   正文增量
- {"type": "error", "message": ..., "status": int} 上游错误（透出真实响应体）
  400/403/404 等致命错误与 429/502/503 等瞬时错误都在这里；
  调用方（stream_chat_retry）据此决定是否重试。
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator

import httpx

# 可重试的瞬时错误：中转通道没就绪 / 限流 / 网关抖动。重试能救回来。
_RETRY_STATUS = {429, 500, 502, 503, 504}
_RETRY_HINTS = (
    "no upstream available",
    "channel",
    "overloaded",
    "rate limit",
    "too many",
    "temporarily",
    "upstream_error",
)


def _headers(api_key: str) -> dict[str, str]:
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    return headers


def _extract_error(obj) -> str | None:
    """从 New API / OpenAI 的错误对象里抠出 message 字段。"""
    if isinstance(obj, dict):
        return obj.get("message")
    return str(obj) if obj else None


def _error_text(status: int, body: bytes) -> str:
    """把上游错误体转成前端可读的一行话（尽量只留 message，去掉无用 JSON）。"""
    text = body.decode("utf-8", errors="replace")
    try:
        obj = json.loads(text)
        msg = _extract_error(obj.get("error"))
        if not msg:
            msg = obj.get("message")
        if msg:
            return str(msg)
    except Exception:
        pass
    return text[:800] or f"上游 {status}（无响应体）"


async def stream_chat(
    messages: list[dict],
    model: str,
    base_url: str,
    api_key: str = "",
    max_tokens: int | None = None,
    timeout: float = 600.0,
) -> AsyncIterator[dict]:
    """流式聊天，逐块产出事件（见模块 docstring）。

    max_tokens：单条回复 token 上限（None = 使用上游默认值）。
    """
    base = base_url.rstrip("/")
    payload = {"model": model, "messages": messages, "stream": True}
    if max_tokens:
        payload["max_tokens"] = max_tokens
    async with httpx.AsyncClient(timeout=httpx.Timeout(timeout, connect=30.0)) as client:
        async with client.stream(
            "POST", f"{base}/chat/completions", headers=_headers(api_key), json=payload
        ) as resp:
            if resp.status_code >= 400:
                body = await resp.aread()
                yield {
                    "type": "error",
                    "message": f"上游 {resp.status_code}: {_error_text(resp.status_code, body)}",
                    "status": resp.status_code,
                }
                return
            finish_reason = None
            async for line in resp.aiter_lines():
                if not line or not line.startswith("data:"):
                    continue
                data = line[len("data:"):].strip()
                if data == "[DONE]":
                    yield {"type": "done", "finish_reason": finish_reason}
                    return
                try:
                    obj = json.loads(data)
                except json.JSONDecodeError:
                    continue
                # 部分中转会在 200 的流里塞一个 error 对象（无 choices）——照实透出，
                # 否则会「静默结束、前端什么都不显示」。
                if obj.get("error") and not (obj.get("choices") or []):
                    msg = _extract_error(obj["error"]) or json.dumps(obj["error"], ensure_ascii=False)
                    yield {"type": "error", "message": f"上游: {msg}", "status": 200}
                    return
                choices = obj.get("choices") or []
                if not choices:
                    continue
                delta = choices[0].get("delta") or {}
                text = delta.get("content")
                if text:
                    yield {"type": "text", "text": text}
                # 结束原因不能丢：length / content_filter 都可能只留下半句话。
                finish_reason = choices[0].get("finish_reason") or finish_reason
                if delta.get("refusal"):
                    yield {"type": "text", "text": delta["refusal"]}
                    finish_reason = "refusal"
            if finish_reason:
                yield {"type": "done", "finish_reason": finish_reason}
            else:
                yield {"type": "error", "message": "上游连接提前结束，回复可能不完整。", "status": 502}


async def complete_chat(
    messages: list[dict],
    model: str,
    base_url: str,
    api_key: str = "",
    max_tokens: int | None = None,
    temperature: float | None = None,
) -> str:
    """非流式补全，一次性拿完整文本。给「记忆提炼」这类后台小任务用（§9.3）。

    复用同一套 OpenAI 兼容口子；出错抛 RuntimeError（透出上游真实错误体）。
    """
    full = await complete_chat_full(messages, model, base_url, api_key,
                                    max_tokens=max_tokens, temperature=temperature)
    return full["content"]


async def complete_chat_full(
    messages: list[dict],
    model: str,
    base_url: str,
    api_key: str = "",
    max_tokens: int | None = None,
    temperature: float | None = None,
    tools: list[dict] | None = None,
) -> dict:
    """非流式补全，返回 `{content, tool_calls, finish_reason}`（工具调用的原始形态）。

    **工具只是「转发 + 原样带回」，这一层不执行任何动作**：功能项目声明它有哪些工具
    （OpenAI function calling 的 schema），模型决定调哪个，功能自己判断能不能执行。
    大脑在这里只当一个「会说工具话」的模型客户端 —— 动作白名单永远是功能的责任
    （见 docs/nest-integration.md「功能自己提供动作白名单与执行」）。
    """
    base = base_url.rstrip("/")
    payload: dict = {"model": model, "messages": messages, "stream": False}
    if max_tokens:
        payload["max_tokens"] = max_tokens
    if temperature is not None:
        payload["temperature"] = temperature
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"
    async with httpx.AsyncClient(timeout=httpx.Timeout(180.0, connect=30.0)) as client:
        resp = await client.post(
            f"{base}/chat/completions", headers=_headers(api_key), json=payload
        )
    if resp.status_code >= 400:
        raise RuntimeError(f"上游 {resp.status_code}: {_error_text(resp.status_code, resp.content)}")
    obj = resp.json()
    if obj.get("error") and not (obj.get("choices") or []):
        raise RuntimeError(f"上游: {_extract_error(obj['error'])}")
    choices = obj.get("choices") or []
    if not choices:
        return {"content": "", "tool_calls": [], "finish_reason": ""}
    message = choices[0].get("message") or {}
    return {
        "content": message.get("content") or "",
        "tool_calls": message.get("tool_calls") or [],
        "finish_reason": choices[0].get("finish_reason") or "",
    }


async def stream_chat_retry(
    messages: list[dict],
    model: str,
    base_url: str,
    api_key: str = "",
    attempts: int = 3,
    max_tokens: int | None = None,
    timeout: float = 600.0,
) -> AsyncIterator[dict]:
    """带瞬时错误重试的流式聊天；致命错误（模型名错 / key 错）直接透出，不空转。"""
    for i in range(attempts):
        error: dict | None = None
        emitted_text = False
        async for ev in stream_chat(messages, model, base_url, api_key, max_tokens=max_tokens, timeout=timeout):
            if ev["type"] == "error":
                error = ev
                break
            emitted_text = emitted_text or ev["type"] == "text"
            yield ev
        if error is None:
            return
        retryable = error.get("status") in _RETRY_STATUS or any(
            h in str(error.get("message", "")).lower() for h in _RETRY_HINTS
        )
        # 已经输出过正文时重试会将第二次回复拼在半句话后面。
        if emitted_text or not retryable or i == attempts - 1:
            yield error
            return
        await asyncio.sleep(0.6 * (i + 1))


def _parse_generation_result(payload: dict) -> list[dict]:
    """把不同中转站 /images/generations 的返回统一成 [{"url":..}|{"b64":..}]。"""
    out: list[dict] = []
    data = payload.get("data")
    if isinstance(data, list):
        for item in data:
            if isinstance(item, dict):
                if item.get("url"):
                    out.append({"url": item["url"]})
                elif item.get("b64_json"):
                    out.append({"b64": item["b64_json"]})
    for key in ("images", "choices"):
        arr = payload.get(key)
        if not isinstance(arr, list):
            continue
        for item in arr:
            if not isinstance(item, dict):
                continue
            url = item.get("url") or (item.get("image") if isinstance(item.get("image"), str) else None)
            b64 = item.get("b64_json") or item.get("b64")
            if url:
                out.append({"url": url})
            elif b64:
                out.append({"b64": b64})
    return out


async def generate_images(
    prompt: str,
    model: str,
    base_url: str,
    api_key: str = "",
    size: str = "1024x1024",
    n: int = 1,
) -> list[dict]:
    """调用 OpenAI 兼容 /images/generations，返回统一后的图片列表。"""
    base = base_url.rstrip("/")
    payload = {"model": model, "prompt": prompt, "n": n, "size": size}
    async with httpx.AsyncClient(timeout=httpx.Timeout(300.0, connect=30.0)) as client:
        resp = await client.post(
            f"{base}/images/generations", headers=_headers(api_key), json=payload
        )
    if resp.status_code >= 400:
        raise RuntimeError(f"上游 {resp.status_code}: {_error_text(resp.status_code, resp.content)}")
    return _parse_generation_result(resp.json())
