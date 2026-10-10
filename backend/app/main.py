"""小糖人之家 · 后端入口。"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .config import get_settings
from .db import init_db
from .routers import (
    agents,
    characters,
    chat,
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
    profiles,
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

init_db()
sp.ensure_root()

app = FastAPI(title="小糖人之家 后端", version="0.1.0")

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
app.include_router(gemini_sync.router, prefix="/api")
app.include_router(agents.router, prefix="/api")
app.include_router(characters.router, prefix="/api")
app.include_router(profiles.router, prefix="/api")
app.include_router(self_router.router, prefix="/api")
from .routers import personal_db
app.include_router(personal_db.router, prefix="/api")
app.include_router(worldbook.router, prefix="/api")
app.include_router(settings_router.router, prefix="/api")

# 附件图片静态目录（§15.1：媒体落盘，库里只存引用）
attachments.ensure_dir()
app.mount("/api/files", StaticFiles(directory=str(attachments.ATTACHMENTS_DIR)), name="files")
media.ROOT.mkdir(parents=True, exist_ok=True)
app.mount("/api/media-files", StaticFiles(directory=str(media.ROOT)), name="media-files")


@app.get("/api/health")
async def health() -> dict:
    return {"status": "ok", "name": "小糖人之家"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host=settings.host, port=settings.port, reload=True)
