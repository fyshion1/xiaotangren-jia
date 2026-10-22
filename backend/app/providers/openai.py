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
import re
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
    # 推理模型（grok-4.x 等）拒绝非默认温度：「field Temperature invalid, only 1 is allowed」
    "temperature invalid",
    # 中转的分组 / 渠道临时空了：「No available channel for model X under group ...」
    # 这条 503 是 New API 在**轮询之前**就挡掉的 —— 同一时刻重发没意义，只能错开等一等。
    "no available channel",
)
# 这些模型**只接受** temperature=1：带着 0.2 去请求会被 400 挡回来（不是上游抖动，重发也一样）。
_FIXED_TEMPERATURE_HINTS = ("temperature invalid", "only 1 is allowed")
# 「没有可用渠道」是渠道池空了，不是限流：退避要拉开，否则三次重试都撞在同一秒。
_CHANNEL_HINT = "no available channel"


def _backoff_seconds(attempt: int, message: str) -> float:
    if _CHANNEL_HINT in message:
        return 3.0 * attempt
    return 0.6 * attempt


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
    temperature: float | None = None,
    response_format: dict | None = None,
    include_usage: bool = False,
    tools: list[dict] | None = None,
) -> AsyncIterator[dict]:
    """流式聊天，逐块产出事件（见模块 docstring）。

    max_tokens：单条回复 token 上限（None = 使用上游默认值）。
    """
    base = base_url.rstrip("/")
    payload = {"model": model, "messages": messages, "stream": True}
    if include_usage:
        payload['stream_options'] = {'include_usage': True}
    if tools:
        payload.update(tools=tools, tool_choice='auto')
    if response_format is not None:
        payload["response_format"] = response_format
    if max_tokens:
        payload["max_tokens"] = max_tokens
    if temperature is not None:
        payload["temperature"] = temperature
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
                if include_usage and isinstance(obj.get('usage'), dict):
                    yield {'type': 'usage', 'usage': obj['usage']}
                choices = obj.get("choices") or []
                if not choices:
                    continue
                delta = choices[0].get("delta") or {}
                if tools and delta.get('tool_calls'):
                    yield {'type': 'tool_calls', 'tool_calls': delta['tool_calls']}
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


async def complete_chat_with_retry(
    messages: list[dict],
    model: str,
    base_url: str,
    api_key: str = "",
    *,
    attempts: int = 2,
    max_tokens: int | None = None,
    temperature: float | None = None,
    on_retry=None,
) -> str:
    """非流式的 `stream_chat_retry`：瞬时错误 / 渠道空了 / 温度被拒不重发一样白等。

    失败抛 RuntimeError，和 `complete_chat` 同一口径 —— 调用方已有的 except 不用改。
    """
    last: Exception | None = None
    dropped_temperature = temperature is None
    for i in range(attempts):
        try:
            return await complete_chat(messages, model, base_url, api_key,
                                       max_tokens=max_tokens, temperature=temperature)
        except RuntimeError as exc:
            last = exc
            message = str(exc).lower()
            retryable = (
                _status_of(str(exc)) in _RETRY_STATUS
                or any(h in message for h in _RETRY_HINTS)
                or any(h in message for h in _FIXED_TEMPERATURE_HINTS)
            )
            if not dropped_temperature and any(h in message for h in _FIXED_TEMPERATURE_HINTS):
                dropped_temperature = True
                temperature = None
                retryable = True
            if not retryable or i == attempts - 1:
                break
            if on_retry is not None:
                on_retry(i + 1, exc)
            await asyncio.sleep(_backoff_seconds(i + 1, message))
    raise last if last else RuntimeError("上游没回话")


def _status_of(message: str) -> int:
    """从 RuntimeError 文案里认回状态码（`上游 503: ...`）；认不出返回 0。"""
    found = re.search(r"上游 (\d{3})", message)
    return int(found.group(1)) if found else 0


async def complete_chat_full(
    messages: list[dict],
    model: str,
    base_url: str,
    api_key: str = "",
    max_tokens: int | None = None,
    temperature: float | None = None,
    tools: list[dict] | None = None,
    response_format: dict | None = None,
    timeout: float = 180.0,
    stream: bool = False,
) -> dict:
    """完整补全，返回 content/tool_calls/finish_reason/usage；stream=True复用SSE收集。

    **工具只是「转发 + 原样带回」，这一层不执行任何动作**：功能项目声明它有哪些工具
    （OpenAI function calling 的 schema），模型决定调哪个，功能自己判断能不能执行。
    大脑在这里只当一个「会说工具话」的模型客户端 —— 动作白名单永远是功能的责任
    （见 docs/nest-integration.md「功能自己提供动作白名单与执行」）。
    """
    if stream:
        return await collect_chat_stream(messages, model, base_url, api_key, max_tokens=max_tokens,
            temperature=temperature, tools=tools, response_format=response_format, timeout=timeout)
    base = base_url.rstrip("/")
    payload: dict = {"model": model, "messages": messages, "stream": False}
    if max_tokens:
        payload["max_tokens"] = max_tokens
    if temperature is not None:
        payload["temperature"] = temperature
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"
    if response_format is not None:
        payload["response_format"] = response_format
    async with httpx.AsyncClient(timeout=httpx.Timeout(timeout, connect=30.0)) as client:
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
        return {"content": "", "tool_calls": [], "finish_reason": "", "usage": obj.get("usage")}
    message = choices[0].get("message") or {}
    return {
        "content": message.get("content") or "",
        "tool_calls": message.get("tool_calls") or [],
        "finish_reason": choices[0].get("finish_reason") or "",
        "usage": obj.get("usage"),
    }


async def collect_chat_stream(messages, model, base_url, api_key='', **options):
    """Reuse the SSE transport, retaining final usage and tool argument deltas.

    Collection never executes tools or retries a failed/partial request.
    """
    chunks, calls, usage, finish, size = [], {}, None, None, 0
    events = stream_chat(messages, model, base_url, api_key, include_usage=True, **options)
    try:
        async for event in events:
            kind = event['type']
            if kind == 'error':
                raise RuntimeError(event.get('message') or '上游流式请求失败')
            if kind == 'text':
                chunks.append(event['text'])
                size += len(event['text'])
            elif kind == 'usage':
                usage = event['usage']
            elif kind == 'tool_calls':
                for delta in event['tool_calls']:
                    index = delta.get('index')
                    if type(index) is not int or not 0 <= index < 64:
                        raise ValueError('流式工具序号无效')
                    call = calls.setdefault(index, {'id': '', 'type': 'function',
                                                   'function': {'name': '', 'arguments': ''}})
                    for key in ('id',):
                        if delta.get(key):
                            call[key] += delta[key]
                            size += len(delta[key])
                    for key in ('name', 'arguments'):
                        value = (delta.get('function') or {}).get(key) or ''
                        call['function'][key] += value
                        size += len(value)
            elif kind == 'done':
                finish = event.get('finish_reason')
            if size > 200000:
                raise ValueError('流式回复过长')
        if not finish:
            raise RuntimeError('上游流式回复未完整结束')
        return {'content': ''.join(chunks), 'tool_calls': [calls[i] for i in sorted(calls)],
                'usage': usage, 'finish_reason': finish}
    finally:
        await events.aclose()


async def stream_chat_retry(
    messages: list[dict],
    model: str,
    base_url: str,
    api_key: str = "",
    attempts: int = 3,
    max_tokens: int | None = None,
    timeout: float = 600.0,
    temperature: float | None = None,
    on_retry=None,
) -> AsyncIterator[dict]:
    """带瞬时错误重试的流式聊天；致命错误（模型名错 / key 错）直接透出，不空转。

    `on_retry(下一次是第几次, 错误事件)`：可选的同步回调，调用方拿它给前端报「正在重试」。

    「这个模型不接受这个温度」的 400 不算抖动，但**值得救一次**：去掉 temperature 原样重发，
    否则换到 grok 这类模型时整个流一开头就死（2026-10-18 实测）。
    """
    dropped_temperature = False
    for i in range(attempts):
        error: dict | None = None
        emitted_text = False
        async for ev in stream_chat(messages, model, base_url, api_key, max_tokens=max_tokens,
                                    timeout=timeout, temperature=temperature):
            if ev["type"] == "error":
                error = ev
                break
            emitted_text = emitted_text or ev["type"] == "text"
            yield ev
        if error is None:
            return
        message = str(error.get("message", "")).lower()
        retryable = error.get("status") in _RETRY_STATUS or any(h in message for h in _RETRY_HINTS)
        if (
            temperature is not None
            and not dropped_temperature
            and not emitted_text
            and any(h in message for h in _FIXED_TEMPERATURE_HINTS)
        ):
            dropped_temperature = True
            temperature = None
            retryable = True
        # 已经输出过正文时重试会将第二次回复拼在半句话后面。
        if emitted_text or not retryable or i == attempts - 1:
            yield error
            return
        if on_retry is not None:
            on_retry(i + 1, error)
        await asyncio.sleep(_backoff_seconds(i + 1, message))


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
