"""Embedding Provider 抽象（对应《项目要求》§9.2.1）。

两个实现，配置 embed_engine 切换：
- local（默认）：sentence-transformers + 中文 bge-small-zh，约 100MB，CPU 可跑，离线。
- cloud：走 OpenAI 兼容 /v1/embeddings（可复用 vsllm 中转）。

⚠ 两者产出的向量**口径不同**，换 engine 后必须重建记忆索引（§16.6）——
   engine_signature() 就是给这一步做校验用的。

低耦合约定：本层不读全局配置，调用方显式传入参数；保持无状态、可测试。
"""

from __future__ import annotations

import array
import hashlib
import json
import math
import threading
from pathlib import Path

import httpx

# 本地模型目录（§16.7）：{root}/<模型名，/ 换成 __>/。模型文件不进 git。
# 落点 backend/data/models/embedding/，由仓库根目录 download_embedding.sh 下载。
DEFAULT_MODEL_DIR = Path(__file__).resolve().parent.parent.parent / "data" / "models" / "embedding"

# 本地模型懒加载缓存：{model_name: SentenceTransformer}
_local_cache: dict[str, object] = {}
_load_lock = threading.Lock()


class EmbeddingError(RuntimeError):
    """embedding 不可用（模型没下载 / 网络失败 / 上游报错）。"""


def engine_signature(engine: str, local_model: str, cloud_model: str) -> str:
    """当前向量口径的指纹，落库进每条记忆；检索时对不上就提示重建索引。"""
    if engine == "cloud":
        return f"cloud:{cloud_model}"
    return f"local:{local_model}"


# ---- 本地：sentence-transformers ----


def _load_local(model_name: str, model_dir: Path) -> object:
    """懒加载本地模型。首次调用会加载权重（几百 ms ~ 数秒），之后走缓存。"""
    local_path = model_dir / model_name.replace("/", "__")
    # 兼容已下载到 embedding 根目录的旧布局，离线加载，绝不悄悄联网。
    if not local_path.is_dir() and (model_dir / "config.json").is_file():
        local_path = model_dir
    cache_key = str(local_path.resolve()) + ":" + model_name
    cached = _local_cache.get(cache_key)
    if cached is not None:
        return cached
    try:
        from sentence_transformers import SentenceTransformer
    except Exception as exc:
        raise EmbeddingError(
            "本地 embedding 需要 sentence-transformers：请先跑 download_embedding.sh 下模型、"
            "再 uv pip install sentence-transformers"
        ) from exc
    # 优先用本地目录里的权重（离线），没有再让 sentence-transformers 按名字取（会联网下载）
    if not local_path.is_dir():
        raise EmbeddingError("本地向量模型文件缺失，请下载模型到 backend/data/models/embedding")
    try:
        with _load_lock:
            if cache_key in _local_cache:
                return _local_cache[cache_key]
            model = SentenceTransformer(str(local_path), local_files_only=True, device="cpu")
            _local_cache[cache_key] = model
    except Exception as exc:
        raise EmbeddingError(f"本地向量模型加载失败：{exc}") from exc
    return model


def _embed_local(texts: list[str], model_name: str, model_dir: Path) -> list[list[float]]:
    model = _load_local(model_name, model_dir)
    try:
        vectors = model.encode(texts, normalize_embeddings=True, convert_to_numpy=True)
    except Exception as exc:  # noqa: BLE001
        raise EmbeddingError(f"本地 embedding 失败：{exc}") from exc
    return [[float(x) for x in row] for row in vectors]


# ---- 云端：/v1/embeddings ----


def _embed_cloud(
    texts: list[str], model: str, base_url: str, api_key: str = ""
) -> list[list[float]]:
    base = (base_url or "").rstrip("/")
    if not base:
        raise EmbeddingError("云端 embedding 未配置 base_url")
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    try:
        resp = httpx.post(
            f"{base}/embeddings",
            headers=headers,
            json={"model": model, "input": texts, "encoding_format": "float"},
            timeout=httpx.Timeout(15.0, connect=3.0),
        )
    except httpx.HTTPError as exc:
        raise EmbeddingError("云端 embedding 连接失败或超时，已使用关键词降级") from exc
    if resp.status_code >= 400:
        raise EmbeddingError(f"云端 embedding HTTP {resp.status_code}，已使用关键词降级")
    data = resp.json().get("data") or []
    if not isinstance(data, list) or any(not isinstance(item, dict) for item in data):
        raise EmbeddingError("云端向量返回格式无效，已使用关键词降级")
    # 按 index 排序，保证与入参顺序一致（部分中转不保证返回顺序）
    data = sorted(data, key=lambda d: d.get("index", 0))
    if [item.get("index") for item in data] != list(range(len(texts))):
        raise EmbeddingError("云端向量序号缺失或重复，已使用关键词降级")
    return [[float(x) for x in item.get("embedding", [])] for item in data]


# ---- 对外统一入口 ----


def embed_texts(
    texts: list[str],
    engine: str = "local",
    local_model: str = "BAAI/bge-small-zh-v1.5",
    model_dir: Path | None = None,
    cloud_model: str = "text-embedding-3-small",
    base_url: str = "",
    api_key: str = "",
    _delegate: bool = True,
) -> list[list[float]]:
    """把一批文本编码成向量（同步；本地 CPU 与云端阻塞调用都用这个入口）。"""
    cleaned = [t if isinstance(t, str) else str(t or "") for t in texts]
    if not cleaned:
        return []
    if engine == "cloud":
        try:
            vectors = _embed_cloud(cleaned, cloud_model, base_url, api_key)
        except (ValueError, TypeError, KeyError, AttributeError, OverflowError) as exc:
            raise EmbeddingError("云端向量返回格式无效，已使用关键词降级") from exc
    else:
        # Explicit cloud API bypasses delegation in both runtime modes.
        if _delegate:
            from ..config import get_settings
            from . import compute
            try:
                cfg = compute.configuration()
                if cfg.mode == "delegated":
                    result = compute.request_sync("embeddings", {"texts": cleaned, "model": local_model})
                    if result.get("model") != local_model:
                        raise EmbeddingError("算力端向量模型不一致，请核对配置")
                    vectors = [[float(x) for x in row] for row in result["vectors"]]
                elif get_settings().runtime_profile == "lightweight":
                    raise EmbeddingError("轻量模式未启用本地向量模型，使用关键词检索或配置外部 API")
                else:
                    vectors = _embed_local(cleaned, local_model, model_dir or DEFAULT_MODEL_DIR)
            except (compute.ComputeUnavailable, ValueError, TypeError, KeyError) as exc:
                raise EmbeddingError("委托向量计算不可用，已使用关键词降级") from exc
        else:
            vectors = _embed_local(cleaned, local_model, model_dir or DEFAULT_MODEL_DIR)
    if (len(vectors) != len(cleaned) or not vectors or not vectors[0]
            or any(len(v) != len(vectors[0]) or not all(math.isfinite(x) for x in v) for v in vectors)):
        raise EmbeddingError("向量返回为空、数量不符或维度无效，已使用关键词降级")
    return vectors


# ---- 向量与 BLOB 的互转（sqlite 存 BLOB，检索时读回算余弦）----


def pack_vector(vec: list[float]) -> bytes:
    """float32 打包成 BLOB —— 体积小、读写快，精度对检索足够。"""
    return array.array("f", vec).tobytes()


def unpack_vector(blob: bytes, dim: int = 0) -> list[float]:
    a = array.array("f")
    a.frombytes(blob)
    if dim and len(a) > dim:
        return list(a[:dim])
    return list(a)


def cosine(a: list[float], b: list[float]) -> float:
    """余弦相似度。本地模型已归一化，云端未归一，这里都按通用式算。"""
    if not a or not b or len(a) != len(b) or not all(math.isfinite(v) for v in [*a, *b]):
        return 0.0
    n = min(len(a), len(b))
    dot = 0.0
    na = 0.0
    nb = 0.0
    for i in range(n):
        x = a[i]
        y = b[i]
        dot += x * y
        na += x * x
        nb += y * y
    if na <= 0.0 or nb <= 0.0:
        return 0.0
    return dot / ((na ** 0.5) * (nb ** 0.5))


def text_fingerprint(text: str) -> str:
    """内容指纹，用于去重（同样的话不重复入库）。"""
    return hashlib.sha1(text.strip().encode("utf-8")).hexdigest()[:16]


def vector_blob(vec: list[float]) -> bytes:
    return pack_vector(vec)


def blob_to_vector(blob: bytes) -> list[float]:
    return unpack_vector(blob)


def dumps(vec: list[float]) -> str:
    """调试用：向量转 JSON 字符串（前若干维）。"""
    return json.dumps(vec[:8], ensure_ascii=False)
