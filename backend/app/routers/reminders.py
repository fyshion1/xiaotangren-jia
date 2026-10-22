from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from .. import db
from ..services import reminders

router = APIRouter(prefix='/reminders', tags=['reminders'])


def owner():
    return db.get_active_persona_id() or 'dalaoda'


class Change(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    action: Literal['confirm', 'cancel', 'dismiss', 'edit']
    revision: int = Field(ge=1)
    title: str = Field(default='', max_length=200)
    due_at: str = Field(default='', max_length=64)


@router.get('')
async def listing():
    return {'items': reminders.list_items(owner()), 'persona_id': owner(), 'timezone': 'Asia/Shanghai'}


@router.get('/due')
async def due():
    return {'items': reminders.list_items(owner(), due_only=True), 'persona_id': owner()}


@router.post('/{rid}')
async def change(rid: str, body: Change):
    try:
        return reminders.change(rid, owner(), **body.model_dump())
    except KeyError:
        raise HTTPException(404, '未找到当前身份的提醒') from None
    except reminders.Conflict as exc:
        raise HTTPException(409, str(exc)) from None
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None
