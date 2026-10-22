"""The hidden local dashboard unlock surface."""
import secrets

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, StrictBool

from .. import db, expert_mode
from ..local_access import local_dashboard

router = APIRouter(prefix='/expert', tags=['expert'])


class ModeIn(BaseModel):
    enabled: StrictBool
    passphrase: str = Field(default='', max_length=100)
    qq_self_id: str = Field(default='', max_length=15)


@router.get('')
def status():
    return expert_mode.status()


@router.put('', dependencies=[Depends(local_dashboard)])
async def update(body: ModeIn):
    if body.enabled and not secrets.compare_digest(body.passphrase.encode(), expert_mode.PASSPHRASE.encode()):
        raise HTTPException(403, '口令不正确')
    if not body.enabled:
        from ..services import qq_basic_settings as basic
        # Account selection belongs to QQ settings; require_ready blocks an
        # ambiguous account from starting after the existing bridge is stopped.
        if body.qq_self_id:
            basic.choose(body.qq_self_id)
    db.set_settings({expert_mode.KEY: '{"enabled":true}' if body.enabled else '{"enabled":false}'})
    # Stop new work first, then let cancellation settle in-flight wallet calls.
    from .. import optional_plugins
    if not body.enabled:
        # Close existing connections before the old multi-account process can reply again.
        from .nest import stop_feature
        stopped = await stop_feature('qq_bridge')
        await optional_plugins.stop_workers()
        if isinstance(stopped, dict) and stopped.get('ok') is False:
            raise HTTPException(503, '专家模式已关闭，但旧 QQ 桥未能停止，请先停止旧进程再启动简化模式')
    return expert_mode.status()
