"""自我档案路由组（§23）：/self"""

from __future__ import annotations

import zipfile
import io
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from ..services import self_profile as sp

router = APIRouter()


# ── 请求模型 ──────────────────────────────────────────────────────────────────

class WriteBody(BaseModel):
    title: str = ""
    inject: bool = False
    visible_to: str | list = "all"
    content: str = ""


class CreateBody(BaseModel):
    title: str = ""


# ── 路由 ───────────────────────────────────────────────────────────────────────

@router.get("/self/status")
async def self_status(persona_id: str) -> list[dict]:
    """当前身份下所有区块的元数据列表（不含正文）。"""
    return sp.list_blocks(persona_id)


@router.get("/self/{persona_id}/{filename}")
async def self_read(persona_id: str, filename: str) -> dict:
    """读完整区块：元数据 + 正文。"""
    return sp.read_block(persona_id, filename)


@router.put("/self/{persona_id}/{filename}")
async def self_write(persona_id: str, filename: str, body: WriteBody) -> dict:
    """写区块（替换 frontmatter + 正文）。"""
    meta = {
        "title": body.title,
        "inject": body.inject,
        "visible_to": body.visible_to,
    }
    return sp.write_block(persona_id, filename, meta, body.content)


@router.delete("/self/{persona_id}/{filename}")
async def self_delete(persona_id: str, filename: str) -> dict:
    """删区块。"""
    ok = sp.delete_block(persona_id, filename)
    if not ok:
        raise HTTPException(status_code=404, detail="文件不存在")
    return {"ok": True}


@router.post("/self/{persona_id}")
async def self_create(persona_id: str, body: CreateBody) -> dict:
    """新建空白区块。"""
    if not body.title.strip():
        raise HTTPException(status_code=400, detail="标题不能为空")
    return sp.create_block(persona_id, body.title)


@router.get("/self/export")
async def self_export(persona_id: str) -> StreamingResponse:
    """打包下载该身份的全部 .md 文件。"""
    blocks = sp.export_all(persona_id)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for block in blocks:
            filename = block.get("filename", "untitled.md")
            # 加 persona 前缀避免冲突
            safe_name = f"{persona_id}/{filename}" if not filename.startswith(persona_id) else filename
            visible = block.get("visible_to", "all")
            visible_str = ",".join(visible) if isinstance(visible, list) else str(visible)
            content = (
                f"---\n"
                f"title: {block.get('title', '')}\n"
                f"inject: {str(block.get('inject', False)).lower()}\n"
                f"visible_to: {visible_str}\n"
                f"created_at: {block.get('created_at', '')}\n"
                f"---\n"
                f"{block.get('content', '')}"
            )
            zf.writestr(safe_name, content.encode("utf-8"))
    buf.seek(0)
    ts = time.strftime("%Y%m%d")
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="self_profile_{persona_id}_{ts}.zip"'},
    )
