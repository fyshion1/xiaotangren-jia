"""个人档案（私人空间）CRUD + 身份切换（对应《项目要求》§22）。

和 `characters.py` 是一对镜像，差别只有三点：

1. **删除**：角色不能删（没有 DELETE 路由），身份可以。删身份要连带清掉这个身份名下的
   会话 —— 每个身份各自一条聊天记录（用户拍板），档案没了，那些会话就是孤儿。
   记忆 / 画廊 / 世界书**不动**：记忆以角色 id 为键、与用户视角无关（用户原话
   「小糖人们的记忆就是完全独立的，不随着用户视角的改变而不改变」），画廊与世界书
   按归属分（家共用 / 某位角色专属），也都与身份无关。
2. **当前身份**：存在 settings 表里（`active_persona_id`），全局一处切换，私聊群聊一起走。
3. **默认身份不能删**：`dalaoda` 是会话 id 不加后缀的那个身份，删掉它老历史就没有主人了。
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, HTTPException

from .. import db
from ..seed_profiles import MAIN_PERSONA_ID
from ..services import cleanup

router = APIRouter()


@router.get("/profiles")
async def list_profiles() -> dict:
    """档案列表 + 当前身份，一次给全 —— 前端启动时只要一次请求。"""
    return {
        "profiles": db.list_profiles(),
        "active_id": db.get_active_persona_id(),
        "main_id": MAIN_PERSONA_ID,
    }


@router.post("/profiles")
async def create_profile(body: dict) -> dict:
    """新建身份档案。缺 id 或 id 撞车时重新生成（与 characters 同款）。"""
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="身份得有名字")
    profile_id = (body.get("id") or "").strip()
    if not profile_id or db.get_profile(profile_id) is not None:
        profile_id = f"persona-{uuid.uuid4().hex[:10]}"
    db.upsert_profile(profile_id, body)
    return db.get_profile(profile_id) or {}


@router.put("/profiles/{profile_id}")
async def update_profile(profile_id: str, body: dict) -> dict:
    if db.get_profile(profile_id) is None:
        raise HTTPException(status_code=404, detail="没有这份身份档案")
    db.upsert_profile(profile_id, body)
    return db.get_profile(profile_id) or {}


@router.put("/profiles/active/{profile_id}")
async def switch_persona(profile_id: str) -> dict:
    """切换当前身份。只改 settings，不动任何消息 —— 各身份的历史本来就各自躺着。"""
    if db.get_profile(profile_id) is None:
        raise HTTPException(status_code=404, detail="没有这份身份档案")
    db.set_active_persona_id(profile_id)
    return {"active_id": profile_id}


@router.delete("/profiles/{profile_id}")
async def delete_profile(profile_id: str) -> dict:
    """删档案 + 清掉这个身份名下的会话及其孤儿图片。"""
    if profile_id == MAIN_PERSONA_ID:
        raise HTTPException(status_code=400, detail="默认身份不能删")
    if db.get_profile(profile_id) is None:
        raise HTTPException(status_code=404, detail="没有这份身份档案")

    db.delete_profile(profile_id)

    # 这个身份名下的会话 id 形如 `xizi@group` / `xizi@single-dashiyin`（§22）。
    removed = {"deleted": 0, "files_removed": 0, "gallery_removed": 0}
    for session_id in db.list_session_ids(f"{profile_id}@"):
        for key, value in cleanup.delete_session(session_id).items():
            removed[key] += value

    # 删的正好是当前身份 → 落回默认身份，免得前端拿着一个不存在的 id。
    if db.get_active_persona_id() == profile_id:
        db.set_active_persona_id(MAIN_PERSONA_ID)

    return {"ok": True, "active_id": db.get_active_persona_id(), "removed": removed}
