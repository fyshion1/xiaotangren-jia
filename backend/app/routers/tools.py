"""Configuration and metadata only: no caller-supplied executable/tool endpoint."""
from fastapi import APIRouter, HTTPException, Query

from .. import db
from ..services import agent_tools as tools

router = APIRouter(prefix="/tools", tags=["tools"])


@router.get("/config")
async def get_config():
    config = tools.settings()
    return {"config": config.model_dump(), "resolved_root": str(tools.root_of(config)),
            "capabilities": tools.CAPABILITIES,
            "personas": [{"id": p["id"], "name": p.get("name", p["id"])} for p in db.list_profiles()]}


@router.put("/config")
async def put_config(body: tools.ToolSettings):
    if not db.get_profile(body.owner_persona_id):
        raise HTTPException(422, "请选择已存在的主人身份")
    try:
        tools.root_of(body)
    except (OSError, ValueError):
        raise HTTPException(422, "允许目录无效") from None
    db.set_settings({tools.SETTING_KEY: body.model_dump_json()})
    return await get_config()


@router.get("/runs")
async def runs(persona_id: str = Query("", max_length=120),
               session_id: str = Query("", max_length=240)):
    persona_id = persona_id or db.get_active_persona_id() or "dalaoda"
    return {"items": tools.recent_runs(persona_id, session_id)}
