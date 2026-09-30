"""应用配置：从环境变量 / .env 读取。API Key 只存在服务端，不暴露给前端。"""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # 服务端
    host: str = "127.0.0.1"
    port: int = 8000

    # 模型来源（OpenAI 兼容，多路切换）
    # 当前主力 vsllm（New API 中转），文字/看图都用 gemini 3.8 flash。
    model_base_url: str = "https://vsllm.cc/v1"
    model_api_key: str = ""
    model_chat: str = "gemini-3.8-flash"
    model_vision: str = "gemini-3.8-flash"
    # 生图：vsllm 无生图通道，默认留空（错填会报「没有配置生图模型」）。
    model_image: str = ""
    image_base_url: str = ""

    # 跨域（本地留空即可；部署时填前端域名，逗号分隔）
    cors_origins: str = ""

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()