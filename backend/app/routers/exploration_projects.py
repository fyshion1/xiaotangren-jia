"""Local dashboard approval surface; not exposed as a model/QQ bridge tool."""
from __future__ import annotations

import asyncio
import ipaddress
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from ..services import exploration_projects as projects, exploration_workspace as workspace
from ..services import exploration_wallet as wallet, exploration_autonomy as autonomy, exploration_outbox as outbox

router = APIRouter(prefix='/exploration-projects', tags=['exploration-projects'])


def local_dashboard(request: Request):
    # The app is single-user/local. Containers have no network, no admin token,
    # no host API access. Cross-origin sites cannot submit an approval form.
    host = request.client.host if request.client else ''
    try:
        local = ipaddress.ip_address(host).is_loopback
    except ValueError:
        local = host == 'testclient'
    origin = request.headers.get('origin')
    parsed_origin = urlsplit(origin) if origin else None
    # Vite development proxy changes Host to :8000 but preserves browser Origin.
    dev_origin = bool(parsed_origin and parsed_origin.scheme in ('http', 'https')
                      and parsed_origin.hostname in ('localhost', '127.0.0.1', '[::1]', '::1')
                      and parsed_origin.port == 5173)
    same_origin = not origin or urlsplit(origin).netloc == request.url.netloc or dev_origin
    if not local or not same_origin or request.headers.get('x-exploration-dashboard') != '1' or request.headers.get('sec-fetch-site', 'same-origin') not in ('same-origin', 'none'):
        raise HTTPException(403, '只能通过本机前端后台审批；聊天回复不授予权限')


class Approval(BaseModel):
    tokens: int = Field(ge=1000, le=200000)
    hours: int = Field(default=2, ge=1, le=24)
    capabilities: list[str] = Field(default_factory=lambda: ['document'], min_length=1, max_length=4)


class WalletIn(BaseModel):
    operation_id: str = Field(default='', max_length=80, pattern=r'^[a-zA-Z0-9-]*$')
    persona: str = Field(min_length=1, max_length=120)
    speaker: str = Field(min_length=1, max_length=120)
    base_url: str = Field(min_length=8, max_length=500)
    model: str = Field(min_length=1, max_length=120)
    api_key: str = Field(default='', max_length=4096)
    add_tokens: int = Field(default=0, ge=0, le=2000000)
    enabled: bool = False
    provider_balance: bool | None = None


class AutonomyIn(BaseModel):
    enabled: bool = False
    qq_notify: bool = True
    qq_account_index: int | None = Field(default=None, ge=0, le=100)
    continuous: bool = True
    allow_estimated_usage: bool = False
    continuation_minutes: int = Field(default=1, ge=1, le=60)
    min_minutes: int = Field(default=60, ge=5, le=1440)
    max_minutes: int = Field(default=180, ge=5, le=1440)
    daily_opportunities: int = Field(default=6, ge=0, le=48)
    run_tokens: int = Field(default=12000, ge=0, le=50000)
    day_tokens: int = Field(default=24000, ge=0, le=200000)


class SignalIn(BaseModel):
    persona: str = Field(min_length=1, max_length=120)
    speaker: str = Field(min_length=1, max_length=120)
    action: str = Field(default='start', pattern=r'^(start|pause|status)$')
    prompt: str = Field(default='', max_length=400)
    request_id: str = Field(min_length=1, max_length=150)


class LifeMessage(BaseModel):
    persona: str = Field(min_length=1, max_length=120)
    speaker: str = Field(min_length=1, max_length=120)
    text: str = Field(min_length=1, max_length=4000)
    request_id: str = Field(min_length=1, max_length=120)


@router.get('/conversations')
async def conversations(persona: str):
    from ..services import exploration_conversations
    return {'items': exploration_conversations.sessions(persona)}


@router.post('/conversations/message', dependencies=[Depends(local_dashboard)])
async def life_message(body: LifeMessage):
    from ..services import exploration_conversations
    return exploration_conversations.receive(body.persona, body.speaker, body.text, 'life:'+body.request_id)


@router.post('/autonomy/signal', dependencies=[Depends(local_dashboard)])
async def autonomy_signal(body: SignalIn):
    from ..services import exploration_threads
    return exploration_threads.signal(**body.model_dump())


@router.get('/wallets', dependencies=[Depends(local_dashboard)])
async def wallets():
    return {'items': wallet.listing()}


@router.get('/personal-space', dependencies=[Depends(local_dashboard)])
async def personal_space(persona: str, speaker: str):
    from ..services import exploration_memory
    return await asyncio.to_thread(exploration_memory.overview, persona, speaker)


@router.get('/personal-space/document', dependencies=[Depends(local_dashboard)])
async def personal_document(persona: str, speaker: str, path: str, offset: int = 0):
    from ..services import exploration_memory
    try:
        base = await asyncio.to_thread(exploration_memory.ensure, persona, speaker)
        return await asyncio.to_thread(exploration_memory.document, base, {'path': path, 'offset': offset})
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.put('/wallets', dependencies=[Depends(local_dashboard)])
async def save_wallet(body: WalletIn):
    ident = await asyncio.to_thread(wallet.save, **body.model_dump())
    return {'id': ident}


@router.get('/autonomy', dependencies=[Depends(local_dashboard)])
async def autonomy_status():
    return {**autonomy.status(), 'notifications': outbox.listing()}


@router.put('/autonomy', dependencies=[Depends(local_dashboard)])
async def autonomy_save(body: AutonomyIn):
    if body.max_minutes < body.min_minutes:
        raise HTTPException(422, '最长活动间隔不能小于最短间隔')
    autonomy.configure(body.model_dump())
    return {'ok': True}


@router.get('')
async def listing():
    return {'items': projects.listing(), 'runtime': await asyncio.to_thread(workspace.capability)}


@router.get('/{project_id}/files')
async def files(project_id: str):
    return {'items': workspace.files(project_id)}


@router.post('/requests/{request_id}/approve', dependencies=[Depends(local_dashboard)])
async def approve(request_id: str, body: Approval):
    grant_id = await asyncio.to_thread(projects.approve, request_id, body.tokens, body.hours, body.capabilities)
    return {'grant_id': grant_id}


@router.post('/requests/{request_id}/reject', dependencies=[Depends(local_dashboard)])
async def reject(request_id: str):
    projects.reject(request_id)
    return {'ok': True}


@router.post('/{project_id}/pause', dependencies=[Depends(local_dashboard)])
async def pause(project_id: str):
    projects.pause(project_id)
    return {'ok': True}


@router.post('/{project_id}/discard', dependencies=[Depends(local_dashboard)])
async def discard(project_id: str):
    workspace.discard(project_id)
    return {'ok': True}
