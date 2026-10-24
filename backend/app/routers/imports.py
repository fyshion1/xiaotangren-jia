"""Core data imports; optional character-card routes are mounted separately."""
import json
import zipfile
from fastapi import APIRouter, File, HTTPException, UploadFile
from .. import tavern_feature

router = APIRouter(prefix="/imports", tags=["imports"])

@router.post("/google-takeout")
async def preview_google_takeout(file: UploadFile = File(...)) -> dict:  # noqa: B008
    if not (file.filename or "").lower().endswith(".zip"):
        raise HTTPException(400, "请上传 Google Takeout ZIP 文件")
    raw = await file.read()
    if len(raw) > 200 * 1024 * 1024:
        raise HTTPException(413, "导出文件不能超过 200 MB")
    try:
        with zipfile.ZipFile(__import__("io").BytesIO(raw)) as archive:
            names = [n for n in archive.namelist() if not n.endswith("/")]
            json_files = [n for n in names if n.lower().endswith(".json")]
            html_files = [n for n in names if n.lower().endswith((".html", ".htm"))]
            preview = []
            for name in json_files[:20]:
                try:
                    value = json.loads(archive.read(name).decode("utf-8-sig"))
                    preview.append({"file": name, "kind": "json", "items": len(value) if isinstance(value, list) else 1})
                except (UnicodeDecodeError, json.JSONDecodeError):
                    continue
    except zipfile.BadZipFile as exc:
        raise HTTPException(400, "ZIP 文件损坏或格式不正确") from exc
    return {"status": "preview", "filename": file.filename, "file_count": len(names), "json_count": len(json_files), "html_count": len(html_files), "files": preview, "commit_required": True}



if tavern_feature.installed():
    router.include_router(tavern_feature.load("imports").router)


def __getattr__(name):
    if name.startswith("__"):
        raise AttributeError(name)
    return getattr(tavern_feature.load("imports"), name)
