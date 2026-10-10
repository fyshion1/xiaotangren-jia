from __future__ import annotations

import secrets
from typing import Literal
from urllib.parse import urlparse

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel, Field

from ..services import gemini_sync as service

router = APIRouter(prefix="/gemini-sync", tags=["gemini-sync"])


class SourceMessage(BaseModel):
    id: str = Field(min_length=1, max_length=200)
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=100000)
    complete: bool = False


class SyncIn(BaseModel):
    conversation_id: str = Field(min_length=1, max_length=200, pattern=r"^[a-zA-Z0-9_-]+$")
    messages: list[SourceMessage] = Field(min_length=1, max_length=100)


@router.get("/pairing")
async def pairing(request: Request) -> dict:
    # 此凭证只能由本机界面读取，不允许 Gemini 页面/外部 Origin 获取。
    if not request.client or request.client.host not in {"127.0.0.1", "::1", "testclient"}:
        raise HTTPException(403, "请在电脑本机界面获取同步凭证")
    if request.url.hostname not in {"localhost", "127.0.0.1", "::1", "testserver"}:
        raise HTTPException(403, "请使用 localhost 或 127.0.0.1 的本机地址")
    origin = request.headers.get("origin")
    if origin and urlparse(origin).hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise HTTPException(403, "同步凭证只供本机界面使用")
    from fastapi.responses import JSONResponse

    return JSONResponse({"token": service.pairing_token(), "session_id": service.SESSION_ID, "memory_enabled": False}, headers={"Cache-Control": "no-store"})


@router.post("/messages")
async def sync(body: SyncIn, authorization: str = Header(default="")) -> dict:
    if not secrets.compare_digest(authorization, f"Bearer {service.pairing_token()}"):
        raise HTTPException(401, "同步凭证无效")
    if len({m.id for m in body.messages}) != len(body.messages):
        raise HTTPException(422, "同批次消息标识重复")
    return service.sync_messages(body.conversation_id, [m.model_dump() for m in body.messages])
