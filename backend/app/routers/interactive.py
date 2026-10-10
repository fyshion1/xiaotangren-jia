from __future__ import annotations

import os
import subprocess
from pathlib import Path

from fastapi import APIRouter, HTTPException

router = APIRouter(prefix="/interactive-home", tags=["interactive"])
DEFAULT_PROJECT = Path(r"D:\ai+2d+3d+unity+vrchat\DashiyinRoom")
DEFAULT_UNITY = Path(r"D:\other software\unity\2022.3.62f3c1\Editor\Unity.exe")


@router.post("/launch")
async def launch_interactive_home() -> dict:
    project = Path(os.getenv("XTR_UNITY_PROJECT", str(DEFAULT_PROJECT)))
    unity = Path(os.getenv("XTR_UNITY_EDITOR", str(DEFAULT_UNITY)))
    if not project.is_dir():
        raise HTTPException(503, f"Unity 项目目录不存在：{project}")
    if not unity.is_file():
        raise HTTPException(503, f"Unity 编辑器路径不存在：{unity}")
    try:
        subprocess.Popen([str(unity), "-projectPath", str(project)], cwd=str(project))
    except OSError as exc:
        raise HTTPException(503, "无法启动 Unity 编辑器") from exc
    return {"ok": True, "project": str(project)}
