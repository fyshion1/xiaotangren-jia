"""自我档案服务：Markdown 文件真源，读/写/删/列表/验证。

文件布局：
    backend/data/self_profile/
        _shared/               ← 跨身份共享区块（例：账本）；任何身份都可见
            {slug}.md
        <persona_id>/
            {slug}.md           ← 该身份的专属区块

每个 .md 文件前 4 行是 YAML frontmatter：
    ---
    title: 区块标题
    inject: true          # true = 聊天时注入；false = 仅手动查看
    visible_to: all       # 'all' | ['dashiyin', 'xiaoshiyin', ...]
    created_at: 2026-10-05
    ---
    正文……（textarea 直写，不走解析库）

前端直接 textarea 写正文，不做 Markdown 渲染 —— 与本项目的其他面板保持一致。
"""

from __future__ import annotations

import re
import os
from datetime import date
from pathlib import Path

# ── 路径常量 ──────────────────────────────────────────────────────────────────

from ..data_paths import runtime_root

_SELF_PROFILE_ROOT = runtime_root() / "self_profile"
_SHARED_DIR = "_shared"

# ── 安全工具 ───────────────────────────────────────────────────────────────────

_BLOCK_SLUG_RE = re.compile(r"^[A-Za-z0-9_一-鿿-]+$")


def _safe_slug(value: str, fallback: str = "untitled") -> str:
    """把 title 收敛成合法的文件名 slug。"""
    slug = re.sub(r"[^A-Za-z0-9_一-鿿-]", "-", (value or "").strip())[:64]
    slug = re.sub(r"-+", "-", slug).strip("-")
    return slug or fallback


def _resolve(persona_id: str, filename: str) -> Path:
    """把 persona_id + filename 解析成绝对路径；越界直接抛错（路径穿越防护）。

    `_shared` 是合法的「共享区块」目录，一并放行；其余 persona_id 只允许单层安全字符。
    """
    if not persona_id or "/" in persona_id or "\\" in persona_id or persona_id in (".", ".."):
        raise ValueError("invalid persona_id")
    root = _SELF_PROFILE_ROOT / persona_id
    path = (root / filename).resolve()
    if not path.is_relative_to(root.resolve()):
        raise ValueError("path traversal")
    return path


# ── frontmatter ───────────────────────────────────────────────────────────────

DEFAULT_FRONT = {
    "title": "",
    "inject": False,
    "visible_to": "all",
    "created_at": str(date.today()),
}


def _parse_front(lines: list[str]) -> dict:
    """把 frontmatter 行列表解析成字典。缺省值由 DEFAULT_FRONT 补。"""
    result = dict(DEFAULT_FRONT)
    for raw in lines:
        raw = raw.strip()
        if ":" not in raw:
            continue
        key, _, val = raw.partition(":")
        key = key.strip()
        val = val.strip()
        if key == "inject":
            result[key] = val.lower() in ("true", "1", "yes")
        elif key == "visible_to":
            # 'all' 或逗号分隔的 id 列表（如 'dashiyin,xiaoshiyin'）
            if val and val != "all":
                result[key] = [v.strip() for v in val.split(",") if v.strip()]
            else:
                result[key] = "all"
        elif key in result:
            result[key] = val
    return result


def _format_front(meta: dict) -> str:
    visible = meta.get("visible_to", "all")
    visible_str = ",".join(visible) if isinstance(visible, list) else str(visible)
    return (
        "---\n"
        f"title: {meta.get('title', '')}\n"
        f"inject: {str(meta.get('inject', False)).lower()}\n"
        f"visible_to: {visible_str}\n"
        f"created_at: {meta.get('created_at', str(date.today()))}\n"
        "---\n"
    )


# ── 核心 CRUD ─────────────────────────────────────────────────────────────────

def ensure_root() -> None:
    """启动时调用一次，确保根目录存在；各身份目录在第一次写入时自动创建。"""
    _SELF_PROFILE_ROOT.mkdir(parents=True, exist_ok=True)


def list_blocks(persona_id: str) -> list[dict]:
    """返回 persona 目录下所有区块的元数据列表（不含正文）。"""
    blocks: list[dict] = []

    # 1. _shared（共享）
    shared = _SELF_PROFILE_ROOT / _SHARED_DIR
    if shared.is_dir():
        for p in sorted(shared.glob("*.md")):
            meta = _read_meta(p)
            blocks.append({**meta, "filename": p.name, "persona_id": _SHARED_DIR, "is_shared": True})

    # 2. persona 专属
    persona_dir = _SELF_PROFILE_ROOT / persona_id
    if persona_dir.is_dir():
        for p in sorted(persona_dir.glob("*.md")):
            meta = _read_meta(p)
            blocks.append({**meta, "filename": p.name, "persona_id": persona_id, "is_shared": False})

    return blocks


def _read_meta(path: Path) -> dict:
    raw = path.read_text(encoding="utf-8")
    meta, _ = _split_front(raw)
    return meta


def _split_front(raw: str) -> tuple[dict, list[str]]:
    """把「frontmatter + 正文」拆成 (元数据, 正文行)。

    不假定固定行号：开头是 `---` 时向后找**第二个** `---` 作闭合，
    `---` 之间的行是 frontmatter，之后全是正文。
    """
    lines = raw.splitlines()
    if lines and lines[0].strip() == "---":
        for i in range(1, len(lines)):
            if lines[i].strip() == "---":
                return _parse_front(lines[1:i]), lines[i + 1:]
    return dict(DEFAULT_FRONT), lines


def read_block(persona_id: str, filename: str) -> dict:
    """读完整文件：元数据 + 正文 content。"""
    path = _resolve(persona_id, filename)
    raw = path.read_text(encoding="utf-8")
    meta, body_lines = _split_front(raw)

    return {
        **meta,
        "filename": filename,
        "persona_id": persona_id,
        "content": "\n".join(body_lines),
    }


def write_block(persona_id: str, filename: str, meta: dict, content: str) -> dict:
    """写文件（自动补 frontmatter），返回写入后的元数据。"""
    path = _resolve(persona_id, filename)
    path.parent.mkdir(parents=True, exist_ok=True)
    merged = {**dict(DEFAULT_FRONT), **meta, "created_at": meta.get("created_at", str(date.today()))}
    body = content.rstrip("\r\n")
    # frontmatter 末行 `---` 之后：空内容则不追加换行，避免 textarea 出现空行
    file_text = _format_front(merged) + body if body else _format_front(merged).rstrip("\n")
    path.write_text(file_text, encoding="utf-8")
    return merged


def delete_block(persona_id: str, filename: str) -> bool:
    """删文件，返回是否真的删掉了。"""
    path = _resolve(persona_id, filename)
    if path.is_file():
        path.unlink()
        return True
    return False


def create_block(persona_id: str, title: str) -> dict:
    """在 persona 目录下新建区块文件（slug 不重复则追加 -1 -2 …）。"""
    if persona_id == _SHARED_DIR:
        dir_path = _SELF_PROFILE_ROOT / _SHARED_DIR
    else:
        dir_path = _SELF_PROFILE_ROOT / persona_id
    dir_path.mkdir(parents=True, exist_ok=True)

    slug = _safe_slug(title)
    filename = f"{slug}.md"
    path = dir_path / filename
    counter = 1
    while path.exists():
        filename = f"{slug}-{counter}.md"
        path = dir_path / filename
        counter += 1

    merged = dict(DEFAULT_FRONT, title=title.strip(), created_at=str(date.today()))
    path.write_text(_format_front(merged) + "", encoding="utf-8")
    return {**merged, "filename": filename, "persona_id": persona_id, "content": ""}


def rename_block(persona_id: str, old_name: str, new_title: str) -> dict:
    """重命名：生成新 slug → 写新文件 → 删旧文件。"""
    meta = read_block(persona_id, old_name)
    content = meta.pop("content", "")
    meta["title"] = new_title.strip()
    new_slug = _safe_slug(new_title)
    new_filename = f"{new_slug}.md"
    # 防撞名
    if persona_id == _SHARED_DIR:
        dir_path = _SELF_PROFILE_ROOT / _SHARED_DIR
    else:
        dir_path = _SELF_PROFILE_ROOT / persona_id
    if (dir_path / new_filename).exists():
        new_filename = f"{new_slug}-{old_name}".replace(".md", "") + ".md"
    result = write_block(persona_id, new_filename, meta, content)
    delete_block(persona_id, old_name)
    return {**result, "filename": new_filename}


def export_all(persona_id: str) -> list[dict]:
    """导出一个身份的全部区块（含正文）。"""
    blocks = []
    # 共享
    shared = _SELF_PROFILE_ROOT / _SHARED_DIR
    if shared.is_dir():
        for p in sorted(shared.glob("*.md")):
            blocks.append(read_block(_SHARED_DIR, p.name))
    # 专属
    persona_dir = _SELF_PROFILE_ROOT / persona_id
    if persona_dir.is_dir():
        for p in sorted(persona_dir.glob("*.md")):
            blocks.append(read_block(persona_id, p.name))
    return blocks


# ── 注入相关 ───────────────────────────────────────────────────────────────────

def external_ai_layer_root() -> Path:
    """个人数据库 `03_AI注入层` 目录（可用 PERSONAL_DATABASE_ROOT 改根）。"""
    return Path(os.getenv("PERSONAL_DATABASE_ROOT", str(_SELF_PROFILE_ROOT.parents[2] / "个人数据库"))) / "03_AI注入层"


def is_visible(visible_to: str | list, char_ids_present: list[str]) -> bool:
    return _is_visible(visible_to, char_ids_present)


def get_injectable_texts(persona_id: str, char_ids_present: list[str]) -> list[dict]:
    """返回所有 inject=true、且角色可见的区块文本（供 prompt 注入）。

    合并策略：
    1. _shared/ 里 inject=true 的（全局共享内容，如账本）
    2. persona_id/ 里 inject=true 的（该身份专属）
    按 created_at 排序（先写的优先）。
    """
    from .. import personal_space
    if not personal_space.enabled('personal_profile'):
        return []
    texts: list[dict] = []

    # 已批准的个人数据库 AI 注入层：只读取 approved + inject=true 的 Markdown。
    # 外部 03 事实统一经过 persona_memory 的身份挑选与权限检查，避免旁路注入。

    # _shared
    shared = _SELF_PROFILE_ROOT / _SHARED_DIR
    if shared.is_dir():
        for p in sorted(shared.glob("*.md")):
            block = read_block(_SHARED_DIR, p.name)
            if not block.get("inject"):
                continue
            if not _is_visible(block.get("visible_to", "all"), char_ids_present):
                continue
            texts.append(block)

    # persona
    persona_dir = _SELF_PROFILE_ROOT / persona_id
    if persona_dir.is_dir():
        for p in sorted(persona_dir.glob("*.md")):
            block = read_block(persona_id, p.name)
            if not block.get("inject"):
                continue
            if not _is_visible(block.get("visible_to", "all"), char_ids_present):
                continue
            texts.append(block)

    # 按创建时间排序（先写先注入）
    texts.sort(key=lambda b: b.get("created_at", ""))
    return texts

def read_external_block(path: Path) -> dict:
    from .memory_workflow import document
    raw = path.read_text(encoding="utf-8-sig")
    fields, body = document(raw)
    meta = {**DEFAULT_FRONT, **fields}
    visible = meta.get("visible_to", "all")
    if isinstance(visible, str) and visible != "all":
        meta["visible_to"] = [v.strip() for v in visible.split(",") if v.strip()]
    return {**meta, "filename": path.name, "content": body, "source_path": str(path)}


def _is_visible(visible_to: str | list, char_ids_present: list[str]) -> bool:
    if visible_to == "all":
        return True
    if isinstance(visible_to, list):
        return any(cid in char_ids_present for cid in visible_to)
    return True
