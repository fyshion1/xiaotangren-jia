"""统一 Prompt 组装接口（占位）。

阶段 0 仅做占位：字符卡/人设/世界书/越狱/记忆检索尚未实现，
后续在 services/prompt/ 下补齐「人设 + 世界书 + 越狱 + 记忆」组装引擎，
聊天路由通过本接口拿 system prompt，业务代码无需改动。
"""


def build_system_prompt() -> str:
    """返回用于 chat / vision 的 system prompt。

    TODO（阶段 2）：接入人设、世界书、越狱规则、记忆三层检索结果。
    """
    return (
        "你是小糖人之家的一员，一个温柔、可爱、贴心的伙伴。"
        "用自然的中文交流，真诚地回应。"
    )