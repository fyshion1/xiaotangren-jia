"""小糖人之家 · 后端入口。"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
from .db import init_db
from .routers import (
    characters,
    chat,
    imagegen,
    images,
    voice,
    worldbook,
)
from .routers import (
    settings as settings_router,
)

settings = get_settings()

init_db()

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
app.include_router(voice.router, prefix="/api")
app.include_router(characters.router, prefix="/api")
app.include_router(worldbook.router, prefix="/api")
app.include_router(settings_router.router, prefix="/api")


@app.get("/api/health")
async def health() -> dict:
    return {"status": "ok", "name": "小糖人之家"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host=settings.host, port=settings.port, reload=True)