"""记忆路由（对应《项目要求》§9.2 检索 / §9.3 手动+自动记忆）。"""

from __future__ import annotations

from typing import Literal
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from .. import db
from ..services import embedding as emb
from ..services import memory as mem
from ..services import memory_extract as extractor

router = APIRouter()


class EmbeddingConfigIn(BaseModel):
    engine: Literal["local", "cloud"]
    base_url: str = ""
    cloud_model: str = Field(min_length=1)
    api_key: str | None = None
    clear_api_key: bool = False


@router.get("/memories/embedding-config")
def embedding_config() -> dict:
    from ..config import get_settings
    settings = get_settings()
    saved = db.get_feature_settings("memory_embedding").get("data") or {}
    cfg = mem.embeddings_config()
    return {"engine": cfg["engine"], "base_url": saved.get("base_url", settings.embed_base_url),
            "cloud_model": cfg["cloud_model"], "has_api_key": bool(cfg["api_key"])}


@router.put("/memories/embedding-config")
def update_embedding_config(body: EmbeddingConfigIn) -> dict:
    base = body.base_url.strip().rstrip('/')
    try:
        parsed = urlsplit(base)
    except ValueError as exc:
        raise HTTPException(400, "API 根地址格式无效") from exc
    if base and (parsed.scheme not in {"http", "https"} or not parsed.hostname
                 or parsed.username or parsed.password or parsed.query or parsed.fragment):
        raise HTTPException(400, "请填写 HTTP(S) API 根地址，不包含账号密码、查询参数或片段")
    model = body.cloud_model.strip()
    if not model:
        raise HTTPException(400, "请填写 embedding 模型名称")
    saved = db.get_feature_settings("memory_embedding").get("data") or {}
    saved.update(engine=body.engine, base_url=base, cloud_model=model)
    if body.clear_api_key:
        saved["api_key"] = ""
    elif body.api_key and body.api_key.strip():
        saved["api_key"] = body.api_key.strip()
    db.set_feature_settings("memory_embedding", saved)
    return embedding_config()


class MemoryIn(BaseModel):
    text: str
    # bucket: home（家记忆）/ personal（个人记忆）；留空则按 session 推断
    bucket: str = ""
    char_id: str = ""
    session_kind: str = "group"  # group / single，用于推断默认桶
    character_ids: list[str] = Field(default_factory=list)
    source: str = "manual"
    meta: dict = Field(default_factory=dict)
    game_id: str = ""
    world_id: str = ""


class Turn(BaseModel):
    id: str = ""
    created_at: str = ""
    image: str = ""
    frames: list[str] = Field(default_factory=list)
    role: str = "user"  # user / assistant
    content: str = ""
    character_id: str = ""  # assistant 发言者（群聊用于辨认是谁说的）


class ExtractIn(BaseModel):
    messages: list[Turn] = Field(default_factory=list)
    character_ids: list[str] = Field(default_factory=list)
    session_kind: str = "group"
    force: bool = False  # 跳过触发词预筛（用户手点「提炼记忆」）
    preview: bool = False  # 只提炼不落库
    # 模型来源：默认用服务端配置，前端也可显式覆盖
    base_url: str = ""
    api_key: str = ""
    model: str = ""
    # 功能命名空间（§9.6）：普通聊天留空；游戏 / 小窝外设传自己的 id，
    # 提炼出的记忆只在同一功能内召回，不会漏进日常聊天。
    feature_id: str = ""
    persona_id: str = ""
    session_id: str = ""
    day: str = Field(default="", pattern=r"^(?:\d{4}-\d{2}-\d{2})?$")


class RecallIn(BaseModel):
    query: str
    character_ids: list[str] = Field(default_factory=list)
    session_kind: str = "group"
    topk_home: int | None = None
    topk_personal: int | None = None
    game_id: str = ""
    world_id: str = ""


@router.get("/memories")
async def list_memories(
    bucket: str | None = Query(None),
    char: str | None = Query(None),
    limit: int = Query(200, ge=1, le=1000),
    game_id: str | None = Query(None),
    world_id: str | None = Query(None),
) -> dict:
    """列出记忆（不含向量）。bucket / char 可收窄。"""
    items = db.list_memories(bucket=bucket, char_id=char, limit=limit, game_id=game_id, world_id=world_id)
    for m in items:
        m.pop("vector", None)
    return {
        "items": items,
        "total": db.count_memories(bucket),
        "home_total": db.count_memories(mem.HOME),
        "personal_total": db.count_memories(mem.PERSONAL),
    }


@router.post("/memories")
async def create_memory(body: MemoryIn) -> dict:
    """手动记一条（§9.3）。bucket 留空时按会话类型自动打标（§9.2.2）。"""
    bucket, char_id = body.bucket, body.char_id
    if not bucket:
        bucket, char_id = mem.bucket_of(body.session_kind, body.character_ids or ([char_id] if char_id else []))
    if bucket not in (mem.HOME, mem.PERSONAL):
        raise HTTPException(status_code=400, detail="bucket 只能是 home / personal")
    if bucket == mem.PERSONAL and not char_id:
        raise HTTPException(status_code=400, detail="个人记忆必须指定 char_id")
    saved = mem.remember(
        text=body.text,
        bucket=bucket,
        char_id=char_id if bucket == mem.PERSONAL else "",
        source=body.source or "manual",
        meta=body.meta,
        game_id=body.game_id,
        world_id=body.world_id,
    )
    if saved is None:
        raise HTTPException(status_code=409, detail="这条记忆已存在（内容重复），或内容为空")
    saved.pop("vector", None)
    return saved


@router.post("/memories/extract")
async def extract_memories(body: ExtractIn) -> dict:
    """自动清洗并整理当天事件，提交 03 待审核；preview 不写正式记忆。"""
    from ..config import get_settings

    msgs = [
        {"role": t.role if t.role in ("user", "assistant") else "user",
         "content": t.content,
         "character_id": t.character_id, "id": t.id, "created_at": t.created_at, "image": t.image, "frames": t.frames}
        for t in body.messages
    ]
    ids = [i for i in (body.character_ids or []) if i]
    name_of = {c["id"]: c.get("name") or "小糖人" for c in db.list_characters()}

    s = get_settings()
    try:
        result = await extractor.extract(
            messages=msgs,
            character_ids=ids,
            session_kind=body.session_kind,
            name_of=name_of,
            base_url=body.base_url or s.model_base_url,
            api_key=body.api_key or s.model_api_key,
            model=body.model or s.model_chat,
            force=body.force,
            save=not body.preview,
            feature_id=body.feature_id,
            persona_id=body.persona_id,
            session_id=body.session_id,
            day=body.day,
        )
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        # 提炼失败不该打断聊天：如实回报，前端静默处理
        raise HTTPException(status_code=502, detail=f"记忆提炼失败：{exc}") from exc
    return result


@router.post("/memories/extract/preview")
async def preview_extract(body: ExtractIn) -> dict:
    """只做规则预筛，不叫 LLM —— 用来快速判断「这段对话值不值得提炼」。"""
    msgs = [{"role": t.role, "content": t.content, "character_id": t.character_id} for t in body.messages]
    candidates = extractor.pick_candidates(msgs)
    return {
        "triggered": bool(candidates),
        "candidate_count": len(candidates),
        "candidates": candidates,
    }


@router.delete("/memories/{mem_id}")
async def delete_memory(mem_id: str) -> dict:
    if not db.delete_memory(mem_id):
        raise HTTPException(status_code=404, detail="记忆不存在")
    return {"ok": True}


@router.delete("/memories")
async def clear_memories(
    bucket: str | None = Query(None),
    char: str | None = Query(None),
) -> dict:
    return {"removed": db.clear_memories(bucket=bucket, char_id=char)}


@router.post("/memories/recall")
async def recall(body: RecallIn) -> dict:
    """调试/预览用：看当前 query 会从「在场者」桶里捞出哪些记忆（§9.2.2）。"""
    import time

    ids = [i for i in (body.character_ids or []) if i]
    if not ids:
        raise HTTPException(status_code=400, detail="需要至少一位在场角色")
    start = time.perf_counter()
    items = mem.recall_for(
        ids, body.query, session_kind=body.session_kind,
        game_id=body.game_id, world_id=body.world_id,
    )
    return {"items": items, "count": len(items), "elapsed_ms": round((time.perf_counter() - start) * 1000, 1)}


@router.get("/memories/status")
def memory_status() -> dict:
    """embedding 是否可用 + 当前向量口径，前端据此提示「模型没装好」。"""
    cfg = mem.embeddings_config()
    sig = mem.current_engine_signature(cfg)
    ok = True
    detail = ""
    try:
        vec = emb.embed_texts(
            ["测试"],
            engine=cfg["engine"],
            local_model=cfg["local_model"],
            cloud_model=cfg["cloud_model"],
            base_url=cfg["base_url"],
            api_key=cfg["api_key"],
        )
        dim = len(vec[0]) if vec else 0
        if dim == 0:
            ok, detail = False, "向量引擎未返回有效向量，已使用关键词降级"
    except emb.EmbeddingError as exc:
        ok, dim, detail = False, 0, str(exc)
    stale = _stale_count(sig)
    return {
        "engine": cfg["engine"],
        "signature": sig,
        "available": ok,
        "dim": dim,
        "detail": detail,
        "home_total": db.count_memories(mem.HOME),
        "personal_total": db.count_memories(mem.PERSONAL),
        # 换了 embedding 引擎后，用旧口径存下的向量条数（§16.6：需要重建索引）
        "stale_vectors": stale,
    }


def _stale_count(signature: str) -> int:
    from ..services import memory_retrieval
    return memory_retrieval.stale_count(_index_documents(), signature)


def _index_documents() -> list[dict]:
    from ..services import memory_workflow as workflow, persona_memory as pm
    items = [m for p in db.list_profiles() for m in workflow.approved(p["id"])]
    items.extend({**m, "id": "db:" + m["ref_id"]} for m in pm.db_pool() if m.get("inject"))
    return items


@router.post("/memories/reindex")
def reindex() -> dict:
    """换 embedding 引擎后重建全部向量（§16.6）。无向量的条目一并补齐。"""
    from ..services import memory_retrieval
    return {**memory_retrieval.rebuild(_index_documents()), "signature": mem.current_engine_signature()}
