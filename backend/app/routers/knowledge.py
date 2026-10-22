"""Local reference-library API. Identity comes from the app, never request bodies."""
import html

from fastapi import APIRouter, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field

from .. import db
from ..services import knowledge as service

router = APIRouter(prefix='/knowledge', tags=['knowledge'])


def actor():
    persona = db.get_active_persona_id()
    if not persona or not db.get_profile(persona):
        raise HTTPException(403, '请先选择有效身份')
    return persona


def call(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except KeyError as exc:
        raise HTTPException(404, '资料或草案不存在，可能已更新') from exc
    except RuntimeError as exc:
        raise HTTPException(409, str(exc)) from exc
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(422, str(exc)) from exc


class ImportInput(BaseModel):
    paths: list[str] = Field(min_length=1, max_length=60)


class SearchInput(BaseModel):
    query: str = Field(min_length=1, max_length=400)
    region: str = Field(default='', max_length=40)
    year_start: int | None = Field(default=None, ge=-10000, le=3000)
    year_end: int | None = Field(default=None, ge=-10000, le=3000)


class DraftInput(BaseModel):
    doc_id: str
    body: str = Field(min_length=1, max_length=4000)
    kind: str = '待核实'
    anchor: str = Field(default='', max_length=800)


class Decision(BaseModel):
    action: str
    expected_persona: str = Field(default='', max_length=100)


class CaptureInput(BaseModel):
    title: str = Field(min_length=1, max_length=160)
    body: str = Field(min_length=1, max_length=service.MAX_CAPTURE_CHARS)
    category: str = Field(default='未分类', max_length=80)
    source: str = Field(default='', max_length=2000)
    expected_persona: str = Field(default='', max_length=100)


def checked_actor(expected):
    persona = actor()
    if expected and expected != persona:
        raise HTTPException(409, '当前身份已变化，请刷新后重新操作')
    return persona


@router.get('')
def overview():
    persona = actor()
    return {'persona_id': persona, 'sources': call(service.scan),
            'documents': call(service.documents, persona), 'proposals': call(service.proposals, persona),
            'captures': call(service.captures, persona)}


@router.post('/captures')
def capture(body: CaptureInput):
    return call(service.capture, checked_actor(body.expected_persona), **body.model_dump(exclude={'expected_persona'}))


@router.post('/captures/{capture_id}')
def settle_capture(capture_id: str, body: Decision):
    return call(service.settle_capture, checked_actor(body.expected_persona), capture_id, body.action)


@router.post('/import')
def import_sources(body: ImportInput):
    return call(service.import_history, actor(), body.paths)


@router.post('/search')
def search(body: SearchInput):
    return call(service.search, actor(), **body.model_dump())


@router.post('/index')
def index():
    return call(service.index_batch, actor())


@router.get('/documents/{doc_id}')
def document(doc_id: str):
    return call(service.read_document, actor(), doc_id)


@router.post('/proposals')
def propose(body: DraftInput):
    return call(service.propose, actor(), **body.model_dump())


@router.post('/proposals/{proposal_id}')
def decide(proposal_id: str, body: Decision):
    return call(service.settle, actor(), proposal_id, body.action)


@router.get('/citations/{chunk_id}', response_class=HTMLResponse)
def citation(chunk_id: str):
    item = call(service.passage, actor(), chunk_id)
    escape = html.escape
    return HTMLResponse('<!doctype html><html lang="zh-CN"><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        '<title>笔记出处</title><style>body{max-width:850px;margin:32px auto;padding:16px;'
        'font:16px/1.8 system-ui}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style>'
        f"<h1>{escape(item['title'])}</h1><p>来源：{escape(item['source'])}</p>"
        f"<p>工作正文：{escape(item['path'])} · 第 {item['start_line']}–{item['end_line']} 行</p>"
        f"<p>{escape(item['warning'])}</p><h2>引用原文</h2><pre>{escape(item['text'])}</pre>"
        f"<details><summary>相邻上下文</summary><pre>{escape(item['context'])}</pre></details></html>",
        headers={'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'"})
