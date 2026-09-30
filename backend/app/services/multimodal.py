"""多模态 Embedding（对应《项目要求》§9.4「照片记忆 B 方案」）——**接口占位**。

A 方案（默认，已实装）：画廊图的**文字描述**走 §9.2 的文本 embedding/RAG。
B 方案（本模块）：用中文 CLIP 之类的多模态模型，把图片和文字映射进**同一向量空间**，
聊天文字能直接「检索到图」，不必先人工写描述。

现在只留 Provider 形状，默认关闭（不下载模型、不占显存）。真要接的时候：
1. 装 `transformers` + 中文 CLIP（如 `OFA-Sys/chinese-clip-vit-base-patch16`）；
2. 在 `embed_images()` 里实装，返回与 `embedding.embed_texts()` **同维度**的向量；
3. 复用 §16.6 的「换引擎必须重建索引」流程 —— 但注意本方案下图片向量与
   文本向量同空间，重建索引时要同时重算两侧，不能只重算文本。
"""

from __future__ import annotations

# 默认关闭。打开需要用户显式安装模型并改配置（见 modules docstring）。
ENGINE = "off"


class MultimodalUnavailable(RuntimeError):
    """多模态 embedding 未就绪（未安装 / 未启用）。"""


def available() -> bool:
    return False


def engine_signature() -> str:
    return ENGINE


def embed_images(images: list[bytes]) -> list[list[float]]:
    """图片 → 向量。未实装，直接抛。"""
    raise MultimodalUnavailable(
        "多模态 embedding（B 方案）尚未实装：当前照片记忆走 A 方案（文字描述进 RAG）。"
    )


def describe(url_or_bytes: object) -> str:
    """兜底：给一张图生成文字描述。未实装时由调用方改用 vision 模型（见 services/gallery.py）。"""
    return ""