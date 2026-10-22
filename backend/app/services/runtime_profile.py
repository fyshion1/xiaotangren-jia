"""Prevent accidental local heavy work on an always-on lightweight primary."""
from starlette.responses import JSONResponse

from .. import config


class LightweightGuard:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if config.get_settings().runtime_profile == "lightweight":
            path = scope.get("path", "")
            blocked = any(path == prefix or path.startswith(prefix + "/") for prefix in (
                "/api/voice", "/api/pet", "/api/media/audio", "/api/media/video",
            ))
            if blocked and scope["type"] == "http":
                response = JSONResponse({"detail": "轻量模式未启用桌宠、语音和视频计算"}, status_code=503)
                await response(scope, receive, send)
                return
            if blocked and scope["type"] == "websocket":
                await send({"type": "websocket.close", "code": 1008,
                            "reason": "轻量模式未启用语音"})
                return
        await self.app(scope, receive, send)
