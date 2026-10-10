from fastapi import APIRouter

from ..config import get_settings

router = APIRouter(prefix="/model-config", tags=["model"])


@router.get("")
async def model_config() -> dict:
    s = get_settings()
    return {
        "source": "backend.env",
        "base_url": s.model_base_url,
        "chat_model": s.model_chat,
        "vision_model": s.model_vision,
        "provider": "ollama" if "localhost" in s.model_base_url or "127.0.0.1" in s.model_base_url else "cloud",
        "api_key_configured": bool(s.model_api_key),
    }
