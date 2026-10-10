"""通用 Agent 沟通 API：只做消息中转，不暴露内部上下文。"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from .. import db

router = APIRouter(prefix="/agents", tags=["agents"])


class AgentMessageIn(BaseModel):
    sender: str = Field(min_length=1, max_length=120)
    recipient: str = Field(default="*", max_length=120)
    conversation_id: str = Field(default="", max_length=160)
    correlation_id: str = Field(default="", max_length=160)
    kind: str = Field(default="message", min_length=1, max_length=60)
    payload: dict = Field(default_factory=dict)


@router.post("/messages")
async def send_message(body: AgentMessageIn) -> dict:
    return db.send_agent_message(
        body.sender,
        body.recipient,
        body.conversation_id,
        body.correlation_id,
        body.kind,
        body.payload,
    )


@router.get("/messages")
async def inbox(
    agent_id: str = Query(..., min_length=1, max_length=120),
    status: str | None = Query("queued", pattern="^(queued|handled|discarded)$"),
    conversation_id: str | None = Query(None, max_length=160),
    limit: int = Query(50, ge=1, le=200),
) -> dict:
    return {"items": db.list_agent_messages(agent_id, status, conversation_id, limit)}


@router.post("/messages/{message_id}/handled")
async def handled(message_id: str) -> dict:
    if not db.update_agent_message(message_id, "handled"):
        raise HTTPException(status_code=404, detail="Agent 消息不存在")
    return {"ok": True, "id": message_id, "status": "handled"}
