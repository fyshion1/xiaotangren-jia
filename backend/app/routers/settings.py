"""全局设置（越狱 / 规则等）键值存取。"""

from fastapi import APIRouter, HTTPException

from .. import db, tavern_feature

router = APIRouter()


@router.get("/settings")
async def get_settings() -> dict[str, str]:
    return {**db.get_settings(), "tavern_installed": str(tavern_feature.installed()).lower(),
            "tavern_mode": str(tavern_feature.enabled()).lower()}


@router.put("/settings")
async def put_settings(body: dict[str, str]) -> dict[str, str]:
    if "expert_mode_v1" in body or "agent_tools_v1" in body or "network_access_v1" in body:
        raise HTTPException(403, "请通过对应设置入口修改")
    if "tavern_installed" in body:
        raise HTTPException(403, "插件安装状态不可通过设置修改")
    if body.get("tavern_mode") == "true" and not tavern_feature.installed():
        raise HTTPException(409, "酒馆插件未安装")
    db.set_settings(body)
    return await get_settings()
