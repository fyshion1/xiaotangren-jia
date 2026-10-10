from __future__ import annotations
import hashlib, os, shutil, uuid
from datetime import datetime, timezone
from pathlib import Path
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from docx import Document
from openpyxl import load_workbook

router = APIRouter(prefix="/personal-db", tags=["personal-db"])
_PROJECT_ROOT = Path(__file__).resolve().parents[3]
_ROOT = Path(os.getenv("PERSONAL_DATABASE_ROOT", str(_PROJECT_ROOT / "个人数据库"))).resolve()
_VERSION_DIR = _ROOT / ".versions"
_EDITABLE, _READABLE = {".md", ".docx"}, {".md", ".txt", ".csv", ".json", ".xlsx", ".docx"}
_HIDDEN_DIRS = {".versions", ".archive", ".obsidian", ".trash"}

def _log_action(action: str, source: str, target: str = "") -> None:
    log_dir = _ROOT / "02_AI工作层" / "处理日志"
    log_dir.mkdir(parents=True, exist_ok=True)
    log = log_dir / "actions.md"
    stamp = datetime.now(timezone.utc).isoformat()
    with log.open("a", encoding="utf-8") as handle:
        handle.write(f"- `{stamp}` `{action}` source=`{source}` target=`{target}`\n")

class FileWrite(BaseModel):
    path: str
    content: str
    expected_sha256: str | None = None

def _path(rel: str) -> Path:
    if not rel or "\x00" in rel: raise HTTPException(400, "invalid path")
    p = (_ROOT / rel).resolve()
    if not p.is_relative_to(_ROOT) or any(part in _HIDDEN_DIRS for part in p.relative_to(_ROOT).parts): raise HTTPException(403, "path outside workspace")
    return p

def _entry(p: Path) -> dict:
    return {"path": p.relative_to(_ROOT).as_posix(), "name": p.name, "kind": "directory" if p.is_dir() else "file", "extension": p.suffix.lower(), "size": p.stat().st_size if p.is_file() else None, "editable": p.is_file() and p.suffix.lower() in _EDITABLE}

@router.get("/tree")
def tree() -> list[dict]:
    if not _ROOT.is_dir(): raise HTTPException(404, "personal database not found")
    entries = []
    for current, dirs, files in os.walk(_ROOT, followlinks=False):
        dirs[:] = sorted(d for d in dirs if d not in _HIDDEN_DIRS and not (Path(current) / d).is_symlink())
        base = Path(current)
        entries.extend(_entry(base / d) for d in dirs)
        entries.extend(_entry(base / f) for f in sorted(files) if (base / f).suffix.lower() in _READABLE)
    return entries

@router.get("/file")
def read_file(path: str = Query(...)) -> dict:
    p = _path(path)
    if not p.is_file() or p.suffix.lower() not in _READABLE: raise HTTPException(404, "file not readable")
    if p.suffix.lower() == ".docx":
        doc = Document(str(p)); content = "\n\n".join(x.text for x in doc.paragraphs)
        return {**_entry(p), "content": content, "readonly": False, "sha256": hashlib.sha256(p.read_bytes()).hexdigest()}
    if p.suffix.lower() == ".xlsx":
        wb = load_workbook(str(p), read_only=True, data_only=False)
        sheets = []
        for ws in wb.worksheets:
            rows = [[cell.value for cell in row] for row in ws.iter_rows(min_row=1, max_row=min(ws.max_row or 0, 100), max_col=min(ws.max_column or 0, 30), values_only=True)]
            sheets.append({"name": ws.title, "rows": ws.max_row, "columns": ws.max_column, "preview": rows})
        wb.close()
        return {**_entry(p), "content": None, "sheets": sheets, "readonly": True}
    raw = p.read_bytes()
    return {**_entry(p), "content": raw.decode("utf-8-sig"), "readonly": p.suffix.lower() not in _EDITABLE,
            "sha256": hashlib.sha256(raw).hexdigest()}

@router.put("/file")
def write_file(body: FileWrite) -> dict:
    p = _path(body.path)
    if p.suffix.lower() not in _EDITABLE: raise HTTPException(403, "file type is read-only")
    if not p.is_file(): raise HTTPException(404, "file not found")
    current_hash = hashlib.sha256(p.read_bytes()).hexdigest()
    if body.expected_sha256 and current_hash != body.expected_sha256:
        raise HTTPException(409, "file changed since it was opened; reload before saving")
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S") + f"_{uuid.uuid4().hex[:8]}Z"
    version = _VERSION_DIR / p.relative_to(_ROOT).parent / f"{p.stem}.{stamp}{p.suffix}"
    version.parent.mkdir(parents=True, exist_ok=True); shutil.copy2(p, version)
    if p.suffix.lower() == ".docx":
        doc = Document(str(p)); lines = body.content.split("\n")
        for i, paragraph in enumerate(doc.paragraphs):
            paragraph.text = lines[i] if i < len(lines) else ""
        for line in lines[len(doc.paragraphs):]: doc.add_paragraph(line)
        doc.save(str(p))
    else:
        p.write_text(body.content, encoding="utf-8")
    return {**_entry(p), "saved": True, "version": version.relative_to(_ROOT).as_posix(), "sha256": hashlib.sha256(body.content.encode()).hexdigest()}

@router.get("/history")
def history(path: str = Query(...)) -> list[dict]:
    p = _path(path); d = _VERSION_DIR / p.relative_to(_ROOT).parent
    if not d.is_dir(): return []
    return [{"path": x.relative_to(_ROOT).as_posix(), "name": x.name, "size": x.stat().st_size} for x in sorted(d.glob(f"{p.stem}.*{p.suffix}"), reverse=True)]

class RestoreBody(BaseModel):
    path: str
    version: str

@router.post("/restore")
def restore(body: RestoreBody) -> dict:
    target, source = _path(body.path), (_ROOT / body.version).resolve()
    if (not target.is_file() or target.suffix.lower() not in _EDITABLE or
        not source.is_relative_to(_VERSION_DIR.resolve()) or not source.is_file() or
        source.parent.relative_to(_VERSION_DIR.resolve()) != target.parent.relative_to(_ROOT) or
        not source.name.startswith(target.stem + ".")):
        raise HTTPException(400, "invalid restore request")
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S") + f"_{uuid.uuid4().hex[:8]}Z"
    snapshot = _VERSION_DIR / target.relative_to(_ROOT).parent / f"{target.stem}.{stamp}.md"
    snapshot.parent.mkdir(parents=True, exist_ok=True); shutil.copy2(target, snapshot)
    shutil.copy2(source, target)
    return {"ok": True, "path": body.path}

class FileCreate(BaseModel):
    path: str
    content: str = "---\ntitle: 新建笔记\ntype: reference\nstatus: draft\nupdated_at: " + datetime.now(timezone.utc).date().isoformat() + "\nsensitivity: private\ninject: false\nvisible_to: all\n---\n"

class FileRename(BaseModel):
    path: str
    new_name: str

class PathMove(BaseModel):
    path: str
    destination: str

class LayerCopy(BaseModel):
    source: str
    destination: str
    title: str | None = None

@router.post("/layer/copy")
def copy_to_layer(body: LayerCopy) -> dict:
    source = _path(body.source)
    if not source.is_file() or source.suffix.lower() != ".md":
        raise HTTPException(400, "only Markdown files can enter an AI layer")
    destination = _path(body.destination)
    if destination.exists(): raise HTTPException(409, "destination already exists")
    text = source.read_text(encoding="utf-8-sig")
    title = body.title or source.stem
    if not text.startswith("---"):
        text = ("---\n" f"title: {title}\n" "type: analysis\nstatus: draft\n"
                f"source: {body.source}\nreview_status: pending\n"
                "sensitivity: private\ninject: false\nvisible_to: all\n---\n" + text)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(text, encoding="utf-8")
    _log_action("copy_to_ai_work", body.source, body.destination)
    return _entry(destination)

@router.post("/layer/approve")
def approve_layer(body: LayerCopy) -> dict:
    source = _path(body.source)
    if not source.is_file() or source.suffix.lower() != ".md": raise HTTPException(400, "Markdown source required")
    destination = _path(body.destination)
    text = source.read_text(encoding="utf-8-sig")
    if text.startswith("---"):
        text = text.replace("review_status: pending", "review_status: approved", 1)
        text = text.replace("status: draft", "status: current", 1)
        text = text.replace("inject: false", "inject: true", 1)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(text, encoding="utf-8")
    _log_action("approve_to_ai_inject", body.source, body.destination)
    return _entry(destination)

@router.post("/file")
def create_file(body: FileCreate) -> dict:
    p = _path(body.path)
    if p.suffix.lower() != ".md" or p.exists(): raise HTTPException(400, "new Markdown path required")
    p.parent.mkdir(parents=True, exist_ok=True); p.write_text(body.content, encoding="utf-8")
    return _entry(p)

@router.post("/rename")
def rename_file(body: FileRename) -> dict:
    p = _path(body.path)
    if not p.is_file() or p.suffix.lower() not in _EDITABLE: raise HTTPException(403, "only editable files can be renamed")
    name = Path(body.new_name).name
    if not name.lower().endswith(".md"): name += ".md"
    target = _path((p.parent.relative_to(_ROOT) / name).as_posix())
    if target.exists(): raise HTTPException(409, "target already exists")
    p.rename(target)
    return _entry(target)

@router.post("/move")
def move_path(body: PathMove) -> dict:
    source = _path(body.path)
    if not source.exists(): raise HTTPException(404, "source not found")
    destination = _ROOT if body.destination == "" else _path(body.destination)
    target = destination / source.name if destination.is_dir() else destination
    if target.exists(): raise HTTPException(409, "target already exists")
    if source.is_dir() and destination.is_relative_to(source): raise HTTPException(400, "cannot move folder into itself")
    target.parent.mkdir(parents=True, exist_ok=True); shutil.move(str(source), str(target))
    _log_action("move", body.path, target.relative_to(_ROOT).as_posix())
    return _entry(target)

@router.post("/rename-folder")
def rename_folder(body: FileRename) -> dict:
    source = _path(body.path)
    if not source.is_dir(): raise HTTPException(400, "folder not found")
    name = Path(body.new_name).name
    target = _path((source.parent.relative_to(_ROOT) / name).as_posix())
    if target.exists(): raise HTTPException(409, "target already exists")
    source.rename(target)
    _log_action("rename_folder", body.path, target.relative_to(_ROOT).as_posix())
    return _entry(target)

@router.post("/archive")
def archive_file(path: str) -> dict:
    p = _path(path)
    if not p.is_file() or p.suffix.lower() != ".md": raise HTTPException(403, "only Markdown files can be archived")
    target = _ROOT / ".archive" / p.relative_to(_ROOT)
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists(): raise HTTPException(409, "archive copy already exists")
    shutil.move(str(p), str(target))
    return {"ok": True, "archived": p.relative_to(_ROOT).as_posix()}
