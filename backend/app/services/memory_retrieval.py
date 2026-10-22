"""已批准文档的可重建向量索引；权限过滤先于检索。"""
from __future__ import annotations

import hashlib

from .. import db
from . import embedding as emb
from . import memory


def _table() -> None:
    with db._tx() as conn:
        conn.execute("""CREATE TABLE IF NOT EXISTS memory_document_vectors (
            id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, signature TEXT NOT NULL,
            vector BLOB NOT NULL, dim INTEGER NOT NULL)""")


def _embed(texts: list[str], cfg: dict) -> list[list[float]]:
    return emb.embed_texts(texts, engine=cfg["engine"], local_model=cfg["local_model"],
                          cloud_model=cfg["cloud_model"], base_url=cfg["base_url"], api_key=cfg["api_key"])


def rank(items: list[dict], query: str, topk: int = 6, *, allow_embeddings: bool = True) -> list[dict]:
    if not items or not query:
        return []
    if not allow_embeddings:
        terms = memory._query_terms(query)
        scored = [{**item, 'score': memory._fallback_score(terms, item.get('text') or item.get('content') or ''),
                   'injection_reason': 'keyword'} for item in items]
        return sorted((item for item in scored if item['score'] > 0), key=lambda item: -item['score'])[:topk]
    cfg = memory.embeddings_config()
    signature = memory.current_engine_signature(cfg)
    terms = memory._query_terms(query)
    qvec = []
    try:
        vectors = _embed([query], cfg)
        qvec = vectors[0] if vectors else []
    except emb.EmbeddingError:
        pass
    _table()
    missing = []
    cached = {}
    for item in items:
        text = item.get("text") or item.get("content") or ""
        fingerprint = hashlib.sha256(text.encode()).hexdigest()
        with db._tx() as conn:
            row = conn.execute("SELECT * FROM memory_document_vectors WHERE id=? AND fingerprint=? AND signature=?",
                               (item["id"], fingerprint, signature)).fetchone()
        if row:
            cached[item["id"]] = row["vector"]
        else:
            missing.append((item, text, fingerprint))
    if qvec and missing:
        try:
            vectors = _embed([m[1] for m in missing], cfg)
            for (item, text, fingerprint), vec in zip(missing, vectors):
                blob = emb.pack_vector(vec)
                cached[item["id"]] = blob
                with db._tx() as conn:
                    conn.execute("INSERT OR REPLACE INTO memory_document_vectors VALUES (?,?,?,?,?)",
                                 (item["id"], fingerprint, signature, blob, len(vec)))
        except emb.EmbeddingError:
            pass
    ranked = []
    for item in items:
        text = item.get("text") or item.get("content") or ""
        score = memory._fallback_score(terms, text)
        mode = "keyword"
        if qvec and item["id"] in cached:
            try:
                semantic = emb.cosine(qvec, emb.unpack_vector(cached[item["id"]]))
                if semantic >= 0.4:
                    score, mode = max(score, semantic), "semantic"
            except (ValueError, TypeError):
                pass
        if score > 0:
            ranked.append({**item, "score": round(score, 4), "injection_reason": mode})
    return sorted(ranked, key=lambda m: -m["score"])[:topk]


def rebuild(items: list[dict]) -> dict:
    _table()
    with db._tx() as conn:
        conn.execute("DELETE FROM memory_document_vectors")
    # rank 会按需重建；批量调用确保无须等待聊天触发。
    rank(items, "长期记忆索引", topk=len(items))
    with db._tx() as conn:
        done = conn.execute("SELECT count(*) FROM memory_document_vectors").fetchone()[0]
    return {"total": len(items), "done": done, "failed": len(items) - done}


def stale_count(items: list[dict], signature: str) -> int:
    """仅统计正式文档索引，历史旧记录不参与新索引状态。"""
    _table()
    with db._tx() as conn:
        rows = {r["id"]: r for r in conn.execute("SELECT id,fingerprint,signature FROM memory_document_vectors")}
    return sum(1 for item in items if item["id"] not in rows
               or rows[item["id"]]["signature"] != signature
               or rows[item["id"]]["fingerprint"] != hashlib.sha256(
                   (item.get("text") or item.get("content") or "").encode()).hexdigest())
