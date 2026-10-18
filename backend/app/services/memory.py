"""记忆服务（对应《项目要求》§9.2 / §9.3）。

三层：
- 家记忆（bucket='home'）—— 共享的长期记忆
- 个人记忆（bucket='personal', char_id=角色）—— 私密长期记忆
- 会话上下文 —— 不在这里，由调用方把最近几轮直接带进请求

两条核心规则（§9.2.2）：
1. 打标：群聊产生 → 家记忆；私聊产生 → 那个人的个人记忆；手动 → 用户指定。
2. 注入只给在场者：群聊注入 家 + 四人各自；私聊注入 家 + TA。
   靠这两条，私聊保密自动成立，无需额外机制。
"""

from __future__ import annotations

from .. import db
from . import embedding as emb

# 家记忆的桶名（char_id 固定空串）
HOME = "home"
PERSONAL = "personal"


def bucket_of(session_kind: str, character_ids: list[str]) -> tuple[str, str]:
    """按会话类型推出「默认落哪个桶」（§9.2.2 打标规则）。

    返回 (bucket, char_id)：
    - 群聊 / 多人在场 → ('home', '')
    - 私聊单一角色     → ('personal', char_id)
    - 私聊但无角色（导入卡）→ ('home', '') 兜底
    """
    ids = [i for i in (character_ids or []) if i]
    if session_kind == "single" and len(ids) == 1:
        return PERSONAL, ids[0]
    return HOME, ""


def embeddings_config() -> dict:
    """从全局配置取 embedding 参数（服务层唯一读配置的地方，方便测试注入）。"""
    from ..config import get_settings

    s = get_settings()
    return {
        "engine": s.embed_engine or "local",
        "local_model": s.embed_local_model,
        "cloud_model": s.embed_cloud_model,
        "base_url": s.embed_base_url or s.model_base_url,
        "api_key": s.model_api_key,
        "topk_home": max(0, int(s.memory_topk_home)),
        "topk_personal": max(0, int(s.memory_topk_personal)),
    }


def current_engine_signature(cfg: dict | None = None) -> str:
    cfg = cfg or embeddings_config()
    return emb.engine_signature(cfg["engine"], cfg["local_model"], cfg["cloud_model"])


def remember(
    text: str,
    bucket: str = HOME,
    char_id: str = "",
    source: str = "manual",
    meta: dict | None = None,
    game_id: str = "",
    world_id: str = "",
) -> dict | None:
    """写入一条记忆：先算向量，再落库（同桶同内容自动去重）。

    向量算不出来时**降级为「无向量记忆」**：仍进库、仍能在列表里看到、也仍会在
    关键词兜底检索里被捞到，不会因为模型没装好就丢掉用户想记的事。
    """
    text = (text or "").strip()
    if not text:
        return None
    cfg = embeddings_config()
    engine = current_engine_signature(cfg)
    vector: bytes | None = None
    dim = 0
    try:
        vec = emb.embed_texts(
            [text],
            engine=cfg["engine"],
            local_model=cfg["local_model"],
            cloud_model=cfg["cloud_model"],
            base_url=cfg["base_url"],
            api_key=cfg["api_key"],
        )
        if vec:
            dim = len(vec[0])
            vector = emb.pack_vector(vec[0])
    except emb.EmbeddingError:
        vector, dim = None, 0

    return db.add_memory(
        bucket=bucket,
        char_id=char_id or "",
        text=text,
        source=source,
        engine=engine if vector else "",
        vector=vector,
        dim=dim,
        fingerprint=emb.text_fingerprint(text),
        meta=meta,
        game_id=game_id,
        world_id=world_id,
    )


def _query_terms(query: str) -> list[str]:
    """把 query 拆成用于兜底检索的词（中文按 2-gram + 连续串，英文按空格）。

    只在「向量不可用」时用；目的是别让没装模型的用户拿到一堆 0 分。
    """
    import re

    q = (query or "").strip().lower()
    if not q:
        return []
    terms: set[str] = set()
    # 英文/数字按词切
    for w in re.findall(r"[a-z0-9_]{2,}", q):
        terms.add(w)
    # 中文：先取连续汉字串，再在里面滑动 2-gram
    for run in re.findall(r"[一-鿿]+", q):
        if len(run) >= 2:
            terms.add(run)
            for i in range(len(run) - 1):
                terms.add(run[i : i + 2])
    return [t for t in terms if t]


def _fallback_score(terms: list[str], text: str) -> float:
    """无向量兜底：按命中词占比给分（0~0.3，永远低于真实向量相似度区间）。"""
    if not terms:
        return 0.0
    low = (text or "").lower()
    hit = sum(1 for t in terms if t in low)
    if not hit:
        return 0.0
    return round(0.3 * hit / len(terms), 4)


def search(
    query: str,
    buckets: list[tuple[str, str]],
    topk: int = 4,
    game_id: str = "",
    world_id: str = "",
) -> list[dict]:
    """在给定桶集合里做向量检索 topk。

    buckets：[(bucket, char_id), ...]，例如 [(home,''), (personal,'dashiyin')]。
    向量不可用时退化为「关键词命中 + 最近写入」，保证 Prompt 里始终有点上下文。
    """
    if not buckets or topk <= 0:
        return []
    cfg = embeddings_config()
    query = (query or "").strip()

    # 把若干桶铺开成一次查询（bucket, char_id 精确匹配）
    candidates: list[dict] = []
    for b, cid in buckets:
        candidates.extend(db.list_memories(
            bucket=b, char_id=cid or "", limit=500, game_id=game_id, world_id=world_id
        ))
    if not candidates:
        return []

    qvec: list[float] = []
    if query:
        try:
            got = emb.embed_texts(
                [query],
                engine=cfg["engine"],
                local_model=cfg["local_model"],
                cloud_model=cfg["cloud_model"],
                base_url=cfg["base_url"],
                api_key=cfg["api_key"],
            )
            qvec = got[0] if got else []
        except emb.EmbeddingError:
            qvec = []

    terms = [] if qvec else _query_terms(query)
    scored: list[tuple[float, dict]] = []
    for mem in candidates:
        vec_blob = mem.get("vector")
        if qvec and vec_blob:
            score = emb.cosine(qvec, emb.unpack_vector(vec_blob))
        elif qvec:
            # query 有向量但这条记忆没向量（模型刚装上、还没重建索引）：不参与语义排序
            score = 0.0
        else:
            score = _fallback_score(terms, mem["text"])
        scored.append((score, mem))

    scored.sort(key=lambda t: -t[0])
    out: list[dict] = []
    for score, mem in scored[:topk]:
        mem = {k: v for k, v in mem.items() if k != "vector"}  # 不回传原始向量
        mem["score"] = round(float(score), 4)
        out.append(mem)
    return out


def recall_for(
    character_ids: list[str],
    query: str,
    session_kind: str = "group",
    game_id: str = "",
    world_id: str = "",
) -> list[dict]:
    """按「在场者」规则检索（§9.2.2/§9.2.3）。

    群聊 → 家记忆 + 每位在场角色个人记忆；私聊 → 家 + TA。
    返回带 bucket/char_id 的记忆列表，供 Prompt 组装分区展示。
    """
    cfg = embeddings_config()
    ids = [i for i in (character_ids or []) if i]
    if not ids:
        return []

    # 游戏记忆必须显式限制在同一个游戏世界；空值代表普通聊天记忆。
    home = search(query, [(HOME, "")], topk=cfg["topk_home"], game_id=game_id, world_id=world_id)
    # 个人记忆：每位在场角色各自 topk（§9.2.3「各自控制条数」）
    personal: list[dict] = []
    for cid in ids:
        personal.extend(search(
            query, [(PERSONAL, cid)], topk=cfg["topk_personal"],
            game_id=game_id, world_id=world_id,
        ))
    return home + personal


def build_query(messages: list[dict], window: int = 4) -> str:
    """检索 query = 最近 window 轮消息拼接（§9.2.3）。"""
    recent = [str(m.get("content") or "").strip() for m in (messages or [])[-window:]]
    return "\n".join(t for t in recent if t)


# ---- Prompt 注入格式 ----


def format_memory_block(
    memories: list[dict],
    name_of: dict[str, str],
    pinned: list[dict] | None = None,
) -> str:
    """把检索到的记忆块排版进 System Prompt。

    - 家记忆：所有在场者都知道
    - 个人记忆：只有该角色自己知道（旁人不该知道，且她也不该主动摊开）
    - pinned：我的档案里为大老大挑中的记忆（§22.4），原样带上、不参与打分；
      个人库里挑出来的（`id` 以 `db:` 开头）当成「确定的事实」写。
    """
    pinned = pinned or []
    if not memories and not pinned:
        return ""
    home = [m for m in memories if m.get("bucket") == HOME]
    personal: dict[str, list[dict]] = {}
    for m in memories:
        if m.get("bucket") == PERSONAL:
            personal.setdefault(m.get("char_id") or "", []).append(m)
    pinned_mem = [p for p in pinned if not str(p.get("id") or "").startswith("db:")]
    pinned_facts = [p for p in pinned if str(p.get("id") or "").startswith("db:")]

    lines: list[str] = ["【你记得的事 · 长期记忆】"]
    has_facts = bool(pinned_mem or pinned_facts)
    if pinned_mem:
        lines.append("· 大老大特意叮嘱过要记住的：")
        lines.extend(f"  - {m['text']}" for m in pinned_mem)
    if pinned_facts:
        lines.append("· 大老大档案里确定的真实信息（当作事实，别质疑、别猜别的）：")
        lines.extend(f"  - {(p.get('title') or '').strip()}：{(p.get('content') or '').strip()}"
                     for p in pinned_facts if (p.get("content") or "").strip())
    if home:
        lines.append("· 大家共同记得的（在场者都知道）：")
        lines.extend(f"  - {m['text']}" for m in home)
    for cid, items in personal.items():
        who = name_of.get(cid) or cid
        lines.append(f"· {who} 自己记得的（只有她自己知道，别人不知道，她也不会主动全盘托出）：")
        lines.extend(f"  - {m['text']}" for m in items)
    if not has_facts and not home and not personal:
        return ""
    if home or personal:
        lines.append("这些是过去的片段，只在话题自然相关时自然地流露，不要生硬复述或声明「我记得」。")
    return "\n".join(lines)
