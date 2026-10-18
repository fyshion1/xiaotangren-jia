"""小糖人之家 · 后端入口。"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

from fastapi import BackgroundTasks, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .config import get_settings
from . import crash, runtime
from .db import init_db
from .services import harvest
from .routers import (
    agents,
    characters,
    chat,
    session_chat,
    gallery,
    game,
    gemini_sync,
    imagegen,
    images,
    imports,
    interactive,
    media,
    memory,
    messages,
    model_config,
    nest,
    profiles,
    qq_bridge,
    voice,
    worldbook,
)
from .routers import (
    self as self_router,
)
from .routers import (
    settings as settings_router,
)
from .services import attachments
from .services import self_profile as sp

settings = get_settings()

# 崩溃自证：钩子要在数据库初始化之前就挂上 —— 改完全局配置重启，最容易炸的就是初始化这一步。
crash.install()

init_db()
sp.ensure_root()


@asynccontextmanager
async def lifespan(_: FastAPI):
    # 成果巡检（任务①）：后台低频轮询，发现新文件弹待确认卡片。
    crash.attach(asyncio.get_running_loop())
    harvest.start()
    try:
        yield
    finally:
        harvest.stop()


app = FastAPI(title="小糖人之家 后端", version="0.1.0", lifespan=lifespan)

if settings.cors_origin_list:
    # 本地留空不启用 CORS（前后端同源）；部署时填前端域名。
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

app.include_router(chat.router, prefix="/api")
app.include_router(session_chat.router, prefix="/api")
app.include_router(images.router, prefix="/api")
app.include_router(imagegen.router, prefix="/api")
app.include_router(imports.router, prefix="/api")
app.include_router(voice.router, prefix="/api")
app.include_router(messages.router, prefix="/api")
app.include_router(memory.router, prefix="/api")
app.include_router(media.router, prefix="/api")
app.include_router(interactive.router, prefix="/api")
app.include_router(model_config.router, prefix="/api")
app.include_router(gallery.router, prefix="/api")
app.include_router(game.router, prefix="/api")
app.include_router(nest.router, prefix="/api")
app.include_router(qq_bridge.router, prefix="/api")
app.include_router(gemini_sync.router, prefix="/api")
app.include_router(agents.router, prefix="/api")
app.include_router(characters.router, prefix="/api")
app.include_router(profiles.router, prefix="/api")
app.include_router(self_router.router, prefix="/api")
from .routers import personal_db
app.include_router(personal_db.router, prefix="/api")
from .routers import harvest as harvest_router
app.include_router(harvest_router.router, prefix="/api")
app.include_router(worldbook.router, prefix="/api")
app.include_router(settings_router.router, prefix="/api")

# 附件图片静态目录（§15.1：媒体落盘，库里只存引用）
attachments.ensure_dir()
app.mount("/api/files", StaticFiles(directory=str(attachments.ATTACHMENTS_DIR)), name="files")
media.ROOT.mkdir(parents=True, exist_ok=True)
app.mount("/api/media-files", StaticFiles(directory=str(media.ROOT)), name="media-files")


@app.get("/api/health")
async def health() -> dict:
    """顶栏那颗灯靠它 —— 「大脑活着没有、这一个是第几次起来的、活了多久」。"""
    return {"status": "ok", "name": "小糖人之家", **runtime.info()}


@app.post("/api/system/restart")
async def system_restart(background: BackgroundTasks) -> dict:
    """一键重启大脑（顶栏那颗灯旁边的按钮）。

    顺序不能反：**先把中间人叫起来 → 回话 → 才退位**。
    中间人在等 :8000 腾出来，话一回完老进程就撒手，端口立刻被顶上。
    真起不来的话 `runtime.restart()` 会抛，这里回 500 —— 当前这个大脑不受影响，继续跑。
    """
    try:
        log_path = runtime.restart()
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"没能叫起新进程：{exc}") from exc
    background.add_task(runtime.exit_soon)
    return {"ok": True, "message": "新大脑正在顶上来，几秒后自己会好", "log": log_path.name}


@app.get("/api/debug/last-crash")
async def last_crash() -> dict:
    """最近一次崩溃（前端「小窝出过一次问题」横幅用）。没有就是 null。"""
    return {"crash": crash.latest()}


@app.get("/api/debug/self-check")
async def self_check() -> dict:
    """一键自检（新手用）：把最常把人卡住的东西挨个看一眼，返回人话结论。

    只读不改 —— 看出来问题也不替你动配置，免得越修越乱。
    """
    from . import db
    from .features_registry import FEATURES
    from .routers import nest

    problems: list[dict] = []

    # ① 全局模型配置：缺 key 是最常见的「什么都调不通」。
    cfg = db.get_brain_default() or {}
    if not (cfg.get("api_key") or "").strip():
        problems.append({"level": "error", "what": "全局模型配置",
                         "detail": "没填 api_key —— 聊天、识图、功能全都会失败"})
    if not (cfg.get("base_url") or "").strip():
        problems.append({"level": "warn", "what": "全局模型配置", "detail": "没填 base_url"})
    if not (cfg.get("model") or "").strip():
        problems.append({"level": "warn", "what": "全局模型配置", "detail": "没填 model（对话模型名）"})

    # ② 每个独立功能：目录在不在、跑没跑、最近一次是停的还是自己退的。
    feats = []
    for spec in FEATURES:
        runner = spec.get("runner")
        if not runner:
            continue
        fid = spec["id"]
        folder = nest.FEATURES_DIR / runner["folder"]
        row = db.latest_feature_run(fid) or {}
        alive = bool(nest._running_pid(fid))
        log = nest._log_path(fid)
        feats.append({"feature_id": fid, "name": spec.get("name", fid),
                      "folder_ok": folder.is_dir(), "running": alive,
                      "last_started": row.get("started_at", ""),
                      "stopped_at": row.get("stopped_at", ""),
                      "log_tail": nest._tail(log, 6) if log.is_file() else ""})
        if not folder.is_dir():
            problems.append({"level": "error", "what": spec.get("name", fid),
                             "detail": f"独立项目没放进来：features/{runner['folder']}/"})

    # ③ 前端代理的三个端口占不占得上（Windows 保留段那种「怎么都起不来」）。
    import socket
    for port in (5173, 8765, 8766):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
            except OSError as exc:
                problems.append({"level": "warn", "what": f"端口 {port}",
                                 "detail": f"占不上（{exc.strerror or exc}）—— "
                                           f"可能被别的程序或系统保留段占了"})

    return {"ok": not any(p["level"] == "error" for p in problems),
            "problems": problems, "features": feats,
            "crash": crash.latest()}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host=settings.host, port=settings.port, reload=True)
