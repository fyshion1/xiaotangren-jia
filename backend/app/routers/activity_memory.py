from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field, field_validator

from .. import db
from ..services import activity_memory as service

router = APIRouter(prefix='/memory', tags=['shared-activity'])


class EventIn(BaseModel):
    persona_id: str = Field(min_length=1, max_length=120)
    source_feature_id: str = Field(min_length=1, max_length=100)
    event_id: str = Field(min_length=1, max_length=200)
    revision: int = Field(default=1, ge=1)
    occurred_at: str
    kind: str = Field(default='activity', max_length=80)
    role: Literal['user', 'assistant', 'activity'] = 'activity'
    text: str = Field(max_length=20000)
    topic: str = Field(default='', max_length=200)
    context_text: str = Field(default='', max_length=4000)
    session_id: str = Field(default='', max_length=240)
    character_ids: list[str] = Field(default_factory=list, max_length=30)
    scope: Literal['personal', 'shared'] = 'personal'
    context: Literal['real', 'fiction', 'exercise'] = 'real'
    reply_to: str = Field(default='', max_length=200)
    attachments: list[str] = Field(default_factory=list, max_length=16)
    deleted: bool = False

    @field_validator('occurred_at')
    @classmethod
    def timestamp(cls, value):
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if parsed.tzinfo is None:
            raise ValueError('发生时间必须包含时区')
        return value


def ensure(persona):
    if not db.get_profile(persona):
        raise HTTPException(404, '用户身份不存在')


@router.post('/events')
def append(body: EventIn):
    ensure(body.persona_id)
    if body.scope == 'personal' and not body.character_ids:
        raise HTTPException(422, '私密记录须指定角色')
    if any(not db.get_character(cid) for cid in body.character_ids):
        raise HTTPException(422, '角色不存在')
    if body.session_id:
        owner = body.session_id.split('@', 1)[0] if '@' in body.session_id else 'dalaoda'
        if owner != body.persona_id:
            raise HTTPException(403, '会话与身份不一致')
    if any(not a.startswith('/api/files/') for a in body.attachments):
        raise HTTPException(422, '附件必须使用本体附件引用')
    try:
        data = body.model_dump(exclude={'persona_id', 'source_feature_id'})
        return service.append(body.persona_id, body.source_feature_id, data)
    except PermissionError as exc:
        raise HTTPException(409, str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(409, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.get('/events')
def events(persona_id: str, day: str = '', source: str = '', query: str = '', offset: int = Query(0, ge=0), limit: int = Query(100, ge=1, le=500)):
    ensure(persona_id)
    if day:
        try: date.fromisoformat(day)
        except ValueError: raise HTTPException(422, '日期无效')
    return service.records(persona_id, day, source, query=query, limit=limit, before=offset)


@router.get('/daily')
def daily(persona_id: str, day: date):
    ensure(persona_id)
    return service.daily(persona_id, day.isoformat())


@router.get('/sources')
def sources(persona_id: str):
    ensure(persona_id)
    return {'items': service.sources(persona_id)}


class PolicyIn(BaseModel):
    persona_id: str
    receive: bool
    organize: bool
    recall: bool
    archived: bool = False


@router.put('/sources/{source}')
def policy(source: str, body: PolicyIn):
    ensure(body.persona_id)
    return service.set_policy(body.persona_id, source, body.model_dump(exclude={'persona_id'}))


@router.get('/events/{seq}/delete-preview')
def delete_preview(seq: int, persona_id: str):
    ensure(persona_id)
    try:
        event = service.get_event(persona_id, seq)
        from ..services.cleanup import preview_delete
        counts = preview_delete([event['message_id']]) if event.get('message_id') else {'messages':0,'images':0,'gallery':0}
        return {**counts, 'event_id':event['event_id'], 'formal_memories_deleted':False}
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.delete('/events/{seq}')
def delete(seq: int, persona_id: str):
    ensure(persona_id)
    try:
        return service.delete_event(persona_id, seq)
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc


class CandidateIn(BaseModel):
    persona_id: str
    text: str = Field(min_length=1, max_length=1600)


@router.post('/events/{seq}/candidate')
def candidate(seq: int, body: CandidateIn):
    ensure(body.persona_id)
    try:
        event = service.get_event(body.persona_id, seq)
        if event.get('deleted'):
            raise LookupError('原始事件已删除')
        from ..services import memory_workflow as work
        with work._lock:
            item = work.propose(body.text, body.persona_id, event.get('character_ids', []),
                                scope=event.get('scope', 'personal'), source=f'activity:{seq}',
                                evidence=[{'id':f'activity:{seq}', 'role':event.get('role', 'activity'), 'content':event.get('text', '')}],
                                occurred_at=event['occurred_at'], event_key=f'activity:{seq}')
            path, item = work.get(item['id'])
            meta = {k:v for k,v in item.items() if k not in {'text','path','revision'}}
            meta['source_feature_ids'] = [event['source_feature_id']]
            work.write(path, meta, item['text'])
            return work._item(path)
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc
