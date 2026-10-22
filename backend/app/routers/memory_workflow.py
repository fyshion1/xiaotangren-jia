from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .. import db
from ..services import memory_workflow as workflow, memory_daily
from ..services.memory_relations import annotate

router = APIRouter(prefix="/memory-workflow", tags=["memory-workflow"])


class CandidateIn(BaseModel):
    persona_id: str
    text: str = Field(min_length=1, max_length=6000)
    character_ids: list[str] = Field(default_factory=list)
    category: str = "experience"
    scope: str = "personal"
    session_id: str = ""
    messages: list[dict] = Field(default_factory=list)
    legacy_id: str = ""


class ReviewIn(BaseModel):
    persona_id: str
    action: str
    revision: str
    changes: dict = Field(default_factory=dict)


class MergeIn(BaseModel):
    persona_id: str
    records: list[dict]


class PersonaIn(BaseModel):
    persona_id: str


class IntegrationIn(MergeIn):
    base_url: str = ''
    api_key: str = ''
    model: str = ''


class OrganizeIn(PersonaIn):
    base_url: str = ''
    api_key: str = ''
    model: str = ''


def ensure_persona(persona_id: str) -> None:
    if not db.get_profile(persona_id):
        raise HTTPException(404, "用户身份不存在")


@router.get("")
def overview(persona_id: str) -> dict:
    ensure_persona(persona_id)
    workflow.initialize()
    sources = [{k: item.get(k) for k in ('path', 'day', 'session_id', 'message_count')}
               for item in (workflow._item(p) for p in workflow._files(workflow.SOURCE))
               if item.get('persona_id') == persona_id and item.get('day')]
    candidates = workflow.list_items(persona_id)
    from ..services.memory_integration import replaced_ids
    replaced = replaced_ids(persona_id)
    candidates = [m for m in candidates if m['id'] not in replaced]
    protected = workflow.list_items(persona_id, workflow.LONG) + workflow.list_items(persona_id, workflow.WORK)
    annotated = {m['id']: m for m in annotate(protected, persona_id)}
    return {"candidates": [annotated.get(m['id'], m) for m in candidates], "approved": workflow.approved(persona_id),
            "sources": sorted(sources, key=lambda m: m['day'], reverse=True), "runs": memory_daily.runs(persona_id),
            "fact_candidates": workflow.fact_candidates(persona_id),
            "source_count": sum(_item.get("persona_id") == persona_id for _item in
                                (workflow._item(p) for p in workflow._files(workflow.SOURCE)))}


@router.get('/source')
def read_source(persona_id: str, path: str) -> dict:
    ensure_persona(persona_id)
    target = (workflow.root() / path).resolve()
    if not target.is_relative_to(workflow.root()) or target.is_symlink() or not path.startswith((workflow.SOURCE + '/', '01_清洗层/')):
        raise HTTPException(403, '不能读取该路径')
    if not target.is_file():
        raise HTTPException(404, '归档不存在')
    meta, text = workflow.document(target.read_text(encoding='utf-8-sig'))
    if meta.get('persona_id') != persona_id:
        raise HTTPException(403, '不能读取其他身份的归档')
    return {'text': text, 'path': path}


@router.post("/candidates")
def propose(body: CandidateIn) -> dict:
    ensure_persona(body.persona_id)
    source = ""
    text = body.text
    character_ids = body.character_ids
    scope = body.scope
    if body.legacy_id:
        legacy = db.get_memory(body.legacy_id)
        if not legacy:
            raise HTTPException(404, "历史记忆不存在")
        # 旧记录保留原桶和命名空间，迁移不能意外扩大私密可见范围。
        scope = "personal" if legacy["bucket"] == "personal" else "shared"
        character_ids = [legacy["char_id"]] if scope == "personal" else body.character_ids
        source = "sqlite:memories/" + body.legacy_id
    else:
        source = workflow.archive_source(body.messages or [{"role": "user", "content": text}],
                                         body.persona_id, body.session_id, character_ids)
    try:
        return workflow.propose(text, body.persona_id, character_ids, category=body.category,
                                scope=scope, source=source, session_id=body.session_id,
                                feature_id=legacy.get("game_id", "") if body.legacy_id else "",
                                evidence=body.messages, legacy_id=body.legacy_id)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.post("/{item_id}/review")
def review(item_id: str, body: ReviewIn) -> dict:
    ensure_persona(body.persona_id)
    try:
        return workflow.review(item_id, body.persona_id, body.action, body.changes, body.revision)
    except PermissionError as exc:
        raise HTTPException(403, str(exc)) from exc
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(409, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.post("/merge")
def merge(body: MergeIn) -> dict:
    ensure_persona(body.persona_id)
    try:
        return workflow.merge(body.persona_id, body.records)
    except PermissionError as exc:
        raise HTTPException(403, str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(409, str(exc)) from exc
    except (ValueError, KeyError, LookupError) as exc:
        raise HTTPException(422, str(exc)) from exc


@router.post("/archive-history")
def archive_history(body: PersonaIn) -> dict:
    ensure_persona(body.persona_id)
    return {"archived": workflow.archive_history(body.persona_id)}


@router.post('/integrate')
async def integrate(body: IntegrationIn) -> dict:
    ensure_persona(body.persona_id)
    from ..services.memory_integration import draft
    from ..config import get_settings
    settings = get_settings()
    try:
        return await draft(body.persona_id, body.records, base_url=body.base_url or settings.model_base_url,
                           api_key=body.api_key or settings.model_api_key, model=body.model or settings.model_chat)
    except PermissionError as exc:
        raise HTTPException(403, str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(409, str(exc)) from exc
    except (ValueError, KeyError, LookupError) as exc:
        raise HTTPException(422, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(502, '整理调用失败，原记忆未修改；模型请求可能已计费') from exc


@router.post('/organize')
async def organize(body: OrganizeIn) -> dict:
    ensure_persona(body.persona_id)
    from ..services.memory_integration import organize_pending
    from ..config import get_settings
    settings = get_settings()
    try:
        return await organize_pending(body.persona_id, base_url=body.base_url or settings.model_base_url,
                                      api_key=body.api_key or settings.model_api_key,
                                      model=body.model or settings.model_chat)
    except PermissionError as exc:
        raise HTTPException(403, str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(409, str(exc)) from exc
    except (ValueError, KeyError, LookupError) as exc:
        raise HTTPException(422, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(502, '整理调用失败，原短句保留；模型请求可能已计费') from exc
