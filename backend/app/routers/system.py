"""发现项目进程；路径用于发现，父子关系用于判断启动归属。"""
from __future__ import annotations

import contextlib
import os
import signal
from pathlib import Path

import psutil
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..launcher_settings import StartupSettings, load_startup, save_startup

router = APIRouter(prefix="/system", tags=["system"])
REPO = Path(__file__).resolve().parents[3]
WATCH_PORTS = {8000, *range(5173, 5181), 8765, 8766, 3001, 3010}


@router.get("/startup")
def startup_settings() -> dict:
    try:
        return {"settings": load_startup().model_dump(),
                "managed": bool(os.environ.get("XTR_LAUNCHER_URL"))}
    except (OSError, ValueError) as exc:
        raise HTTPException(500, f"无法读取启动设置：{exc}") from exc


@router.put("/startup")
def update_startup_settings(body: StartupSettings) -> dict:
    try:
        return {"settings": save_startup(body).model_dump(),
                "message": "已保存，下次用 BAT 启动时生效"}
    except OSError as exc:
        raise HTTPException(500, f"无法保存启动设置：{exc}") from exc


def _under_repo(value: str) -> bool:
    try:
        return Path(value).is_absolute() and Path(value).resolve().is_relative_to(REPO)
    except (OSError, ValueError):
        return False


def _project(p) -> bool:
    with contextlib.suppress(psutil.Error, OSError):
        args = p.cmdline()
        if any(_under_repo(arg) for arg in args):
            return True
        # Tools launched by an editor also inherit the repository cwd. Require a
        # known service command before using cwd as evidence of project membership.
        service_args = " ".join(args).lower()
        known = any(token in service_args for token in (
            "app.main:app", "multiprocessing", "vite", "qqbridge", "jplab", "english_study",
        ))
        return known and _under_repo(p.cwd())
    return False


def _protected() -> set[int]:
    me = psutil.Process(os.getpid())
    return {me.pid, *(p.pid for p in me.parents())}


def _why(p) -> tuple[bool, bool, str]:
    if p.pid in _protected():
        return False, False, "当前后端或其祖先进程，不能停止"
    owned = os.getpid() in {a.pid for a in p.parents()}
    return True, not owned, "" if owned else "不是当前后端启动的，需要确认停止"


@router.get("/processes")
def list_processes() -> dict:
    ports: dict[int, set[int]] = {}
    warnings = []
    try:
        for c in psutil.net_connections(kind="tcp"):
            if c.status == psutil.CONN_LISTEN and c.pid and c.laddr:
                ports.setdefault(c.pid, set()).add(c.laddr.port)
    except (psutil.Error, OSError):
        warnings.append("无法读取监听端口，进程列表可能不完整")
    items = []
    for p in psutil.process_iter():
        with contextlib.suppress(psutil.Error, OSError):
            related = _project(p)
            listening = ports.get(p.pid, set())
            if not related and not WATCH_PORTS.intersection(listening):
                continue
            args = p.cmdline()
            name = p.name().lower()
            if not name.startswith(("python", "uvicorn", "node", "npm")) and not WATCH_PORTS.intersection(listening):
                continue
            can, force, reason = _why(p)
            if not related:
                can, reason = False, "端口被其他项目占用，不在这里停止"
            role = "后端" if "app.main:app" in args else (
                "前端" if any("vite" in a for a in args) else "功能进程")
            items.append({
                "pid": p.pid, "ppid": p.ppid(), "name": p.name(), "role": role,
                "cmd": " ".join(args), "create_time": p.create_time(),
                "ports": sorted(listening), "current": p.pid == os.getpid(),
                "can_kill": can, "requires_force": force, "reason": reason,
            })
    return {"items": sorted(items, key=lambda i: i["pid"]), "warnings": warnings,
            "me": {"pid": os.getpid()}}


class StopIn(BaseModel):
    create_time: float = Field(gt=0)
    force: bool = False


@router.delete("/processes/{pid}")
def kill_process(pid: int, body: StopIn) -> dict:
    try:
        p = psutil.Process(pid)
        if abs(p.create_time() - body.create_time) > 0.001:
            raise HTTPException(409, "PID 已被复用，请刷新列表")
        can, needs_force, reason = _why(p)
        if not can:
            raise HTTPException(409, reason)
        if not _project(p):
            raise HTTPException(403, "无法确认属于本项目，拒绝停止")
        if needs_force and not body.force:
            raise HTTPException(409, reason)
        tracked = [*p.children(recursive=True), p]
        if _protected().intersection(q.pid for q in tracked):
            raise HTTPException(409, "目标进程树包含当前后端，拒绝停止")
        # Windows console signals are best-effort and do not guarantee finally execution.
        for q in reversed(tracked):
            with contextlib.suppress(psutil.NoSuchProcess, OSError):
                q.send_signal(signal.CTRL_BREAK_EVENT if os.name == "nt" else signal.SIGINT)
        _, alive = psutil.wait_procs(tracked, timeout=5)
        extra = []
        for q in alive:
            with contextlib.suppress(psutil.NoSuchProcess):
                extra.extend(q.children(recursive=True))
        targets = list({q.pid: q for q in [*extra, *alive]}.values())
        for q in targets:
            with contextlib.suppress(psutil.NoSuchProcess):
                q.kill()
        _, remaining = psutil.wait_procs(targets, timeout=3)
        return {"ok": not remaining, "pid": pid,
                "remaining": [q.pid for q in remaining],
                "message": "已停止" if not remaining else "部分进程仍在运行，请刷新查看"}
    except psutil.NoSuchProcess:
        return {"ok": True, "pid": pid, "message": "进程已经退出"}
    except psutil.AccessDenied:
        raise HTTPException(403, "没有权限操作该进程") from None
