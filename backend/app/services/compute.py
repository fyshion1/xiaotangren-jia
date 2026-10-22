"""Optional stateless compute worker. The primary keeps all durable state.

Only allowlisted tasks are sent; never replay uncertain/failed jobs locally.
"""
from __future__ import annotations

import base64
import threading
import time
from typing import Literal
from urllib.parse import urlsplit

import httpx
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

PROTOCOL = 1
MAX_RESPONSE = 32 * 1024 * 1024
KEY = "compute_delegation"


class ComputeUnavailable(RuntimeError):
    pass


class ComputeConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mode: Literal["native", "delegated"] = "native"
    worker_url: str = Field(default="", max_length=2048)
    token: str = Field(default="", max_length=4096)

    @field_validator("worker_url")
    @classmethod
    def valid_url(cls, value: str) -> str:
        value = value.strip().rstrip("/")
        if not value:
            return value
        parsed = urlsplit(value)
        if (parsed.scheme not in {"http", "https"} or not parsed.hostname
                or parsed.username or parsed.password or parsed.query or parsed.fragment):
            raise ValueError("请填写不含账号密码、查询参数的 HTTP(S) 算力端地址")
        # Force invalid port syntax through validation as well.
        _ = parsed.port
        return value

    @model_validator(mode="after")
    def complete(self):
        if self.mode == "delegated" and (not self.worker_url or not self.token.strip()):
            raise ValueError("委托模式需要算力端地址和访问密钥")
        return self


def configuration() -> ComputeConfig:
    from .. import db
    from ..config import get_settings
    s = get_settings()
    saved = db.get_feature_settings(KEY).get("data") or {}
    return ComputeConfig.model_validate({
        "mode": saved.get("mode", s.compute_mode),
        "worker_url": saved.get("worker_url", s.compute_worker_url),
        "token": saved.get("token", s.compute_worker_token),
    })


_lock = threading.Lock()
_failures: dict[tuple[str, str], float] = {}


def _key(cfg: ComputeConfig) -> tuple[str, str]:
    return cfg.worker_url, cfg.token


def _check(cfg: ComputeConfig):
    if cfg.mode != "delegated":
        raise ComputeUnavailable("当前使用原生模式")
    with _lock:
        if time.monotonic() < _failures.get(_key(cfg), 0):
            raise ComputeUnavailable("算力端暂不可用；基础聊天、搜索和关键词记忆仍可使用")


def _failed(cfg: ComputeConfig):
    with _lock:
        # Bound failures even if the user repeatedly changes addresses.
        if len(_failures) > 32:
            _failures.clear()
        _failures[_key(cfg)] = time.monotonic() + 10


def _validated(response: httpx.Response, data: bytes) -> dict:
    if response.status_code != 200:
        raise ComputeUnavailable(f"算力端 HTTP {response.status_code}；基础功能继续运行")
    import json
    try:
        result = json.loads(data)
        if not isinstance(result, dict) or result.get("protocol") != PROTOCOL:
            raise ValueError()
        return result
    except (ValueError, TypeError) as exc:
        raise ComputeUnavailable("算力端协议或返回格式不兼容") from exc


def _timeout(task: bool) -> httpx.Timeout:
    from ..config import get_settings
    s = get_settings()
    return httpx.Timeout(max(1, s.compute_task_timeout) if task else 3,
                         connect=max(0.2, s.compute_connect_timeout))


def request_sync(task: str, body: dict) -> dict:
    cfg = configuration()
    _check(cfg)
    try:
        # Memory recall must not wait for an unresponsive worker for minutes.
        with httpx.Client(timeout=httpx.Timeout(15, connect=_timeout(True).connect),
                          trust_env=False, follow_redirects=False) as client:
            with client.stream("POST", f"{cfg.worker_url}/v1/compute/{task}",
                               json=body, headers={"Authorization": f"Bearer {cfg.token}"}) as response:
                data = bytearray()
                for chunk in response.iter_bytes():
                    data.extend(chunk)
                    if len(data) > MAX_RESPONSE:
                        raise ComputeUnavailable("算力端结果超过大小限制")
                return _validated(response, bytes(data))
    except (httpx.HTTPError, ComputeUnavailable) as exc:
        _failed(cfg)
        raise ComputeUnavailable("算力端不可用；已保留基础聊天、搜索和关键词记忆") from exc


async def request_async(task: str, body: dict | None = None) -> dict:
    cfg = configuration()
    if body is not None:
        _check(cfg)
    try:
        async with httpx.AsyncClient(timeout=_timeout(body is not None), trust_env=False,
                                     follow_redirects=False) as client:
            async with client.stream("GET" if body is None else "POST",
                                     f"{cfg.worker_url}/v1/compute/{task}",
                                     json=body, headers={"Authorization": f"Bearer {cfg.token}"}) as response:
                data = bytearray()
                async for chunk in response.aiter_bytes():
                    data.extend(chunk)
                    if len(data) > MAX_RESPONSE:
                        raise ComputeUnavailable("算力端结果超过大小限制")
                result = _validated(response, bytes(data))
        with _lock:
            _failures.pop(_key(cfg), None)
        return result
    except (httpx.HTTPError, ComputeUnavailable) as exc:
        _failed(cfg)
        raise ComputeUnavailable("算力端连接失败、认证失败或协议不兼容；基础功能继续运行") from exc


async def image_bytes(body: dict) -> list[tuple[bytes, str]]:
    result = await request_async("images", body)
    try:
        items = result["images"]
        if not isinstance(items, list) or not 1 <= len(items) <= 4:
            raise ValueError()
        out = []
        for item in items:
            mime = item["mime"]
            if mime not in {"image/png", "image/jpeg", "image/webp"}:
                raise ValueError()
            raw = base64.b64decode(item["data"], validate=True)
            if not raw:
                raise ValueError()
            out.append((raw, mime))
        return out
    except (ValueError, TypeError, KeyError) as exc:
        raise ComputeUnavailable("算力端图片格式无效") from exc


async def status() -> dict:
    from ..config import get_settings
    cfg = configuration()
    result = {"mode": cfg.mode, "worker_url": cfg.worker_url,
              "has_token": bool(cfg.token), "profile": get_settings().runtime_profile,
              "online": False, "capabilities": [], "detail": "原生模式"}
    if cfg.mode == "delegated":
        try:
            remote = await request_async("health")
            result.update(online=True, capabilities=remote.get("capabilities", []),
                          detail="算力端已连接", embedding_model=remote.get("embedding_model", ""))
        except ComputeUnavailable as exc:
            result["detail"] = str(exc)
    return result
