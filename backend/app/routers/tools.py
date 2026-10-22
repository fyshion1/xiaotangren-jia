"""Configuration and metadata only: no caller-supplied executable/tool endpoint."""
import json
from fastapi import APIRouter, HTTPException, Query, Depends
from pydantic import BaseModel, StrictBool

from .. import db
from .. import tool_feature
from ..expert_mode import require_expert
from ..local_access import local_dashboard
from ..services import agent_tools as tools

router = APIRouter(prefix="/tools", tags=["tools"])


@router.get("/config", dependencies=[Depends(require_expert)])
async def get_config():
    config = tools.settings()
    return {"config": config.model_dump(), "capabilities": tools.capabilities(),
            "groups": tools.groups(), "installed": tool_feature.installed(),
            "web_search_installed": tool_feature.network_available(),
            "personas": [{"id": p["id"], "name": p.get("name", p["id"])} for p in db.list_profiles()]}


@router.put("/config", dependencies=[Depends(require_expert), Depends(local_dashboard)])
async def put_config(body: tools.ToolSettings):
    if not tool_feature.installed():
        raise HTTPException(409, '工具插件未安装')
    if not db.get_profile(body.owner_persona_id):
        raise HTTPException(422, "请选择已存在的主人身份")
    db.set_settings({tools.SETTING_KEY: body.model_dump_json()})
    return await get_config()


@router.get("/runs", dependencies=[Depends(require_expert)])
async def runs(persona_id: str = Query("", max_length=120),
               session_id: str = Query("", max_length=240)):
    persona_id = persona_id or db.get_active_persona_id() or "dalaoda"
    return {"items": tools.recent_runs(persona_id, session_id)}


class NetworkIn(BaseModel):
    enabled: StrictBool


@router.get('/network')
def network_status():
    config = tools.settings()
    installed = tool_feature.network_available()
    return {'installed': installed, 'channels': {
        'core': bool(installed and config.enabled and config.web_enabled and 'web_search' in config.allowed_names),
        'qq_bridge': bool(installed and config.enabled and config.qq_enabled and 'web_search' in config.allowed_names),
        'desktop_pet': bool(installed and config.enabled and config.pet_enabled and 'web_search' in config.allowed_names),
    }}


@router.put('/network/{channel}', dependencies=[Depends(local_dashboard)])
def update_network(channel: str, body: NetworkIn):
    if channel not in ('core', 'qq_bridge', 'desktop_pet'):
        raise HTTPException(404, '不存在这个联网入口')
    if not tool_feature.network_available():
        raise HTTPException(409, '联网功能未安装')
    from ..expert_mode import enabled
    if enabled():
        config = tools.saved_settings()
        setattr(config, {'core':'web_enabled', 'qq_bridge':'qq_enabled', 'desktop_pet':'pet_enabled'}[channel], body.enabled)
        if body.enabled:
            config.enabled = True
            if 'web_search' not in config.allowed_names:
                config.allowed_names.append('web_search')
        db.set_settings({tools.SETTING_KEY: config.model_dump_json()})
    else:
        channels = tools.network_settings()
        channels[channel] = body.enabled
        db.set_settings({tools.NETWORK_KEY: json.dumps(channels)})
    return network_status()
