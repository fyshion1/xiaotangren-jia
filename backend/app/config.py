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
    # 生图方式切换器（§7）：tencent（默认占位）/ comfyui（本地 SD，未接入）/ thirdparty。
    # 仅记录选择；实机接入前只作占位提示，不改变上游调用。
    image_engine: str = "tencent"

    # Embedding（记忆 RAG，§9.2.1）：默认本地小模型，可切云端 /v1/embeddings。
    # ⚠ 两者向量口径不同，换 engine 后必须重建记忆索引（§16.6）。
    embed_engine: str = "local"  # local | cloud
    embed_local_model: str = "BAAI/bge-small-zh-v1.5"  # 约 100MB，CPU 可跑
    embed_local_dir: str = ""  # 本地模型落地目录，留空 = backend/data/models/embedding（§16.7）
    embed_cloud_model: str = "text-embedding-3-small"
    embed_base_url: str = ""  # 留空 = 同 model_base_url
    memory_topk_home: int = 4  # 家记忆每次注入条数上限
    memory_topk_personal: int = 4  # 每位在场角色个人记忆注入条数上限

    # 跨域（本地留空即可；部署时填前端域名，逗号分隔）
    cors_origins: str = ""

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()