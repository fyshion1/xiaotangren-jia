"""NovelAI 插槽（预留，本轮未实接）。

NovelAI 的接口**不是 OpenAI 兼容**的，所以不能塞进 `providers/openai.py` 里凑合：

    POST https://image.novelai.net/ai/generate-image
    Authorization: Bearer <token>
    body: {input, model, action, parameters: {width, height, scale, sampler, steps, seed, n_samples, ucPreset, qualityToggle, negative_prompt}}
    返回: zip 流（不是 JSON，也不是 base64）—— 这一点和 OpenAI 的 /images/generations 完全不同

外加它用的是 **Anlas（点数）** 计费，且模型是自家的 `nai-diffusion-*` 系列，
参数名（`sampler` / `ucPreset` / `qualityToggle`）都得按它的文档来。

## 为什么这轮不写

按《项目要求》§16.2：不吞上游错误、也不猜上游协议。上面这些细节我还没有对着
NovelAI 官方文档逐条核实过，**写出来的话大概率是错的、还很难查**。所以这里只留
一个明确的占位：引擎列表里 `novelai` 会以 `ready=false` 显示为「未接入」。

## 接的时候要做什么

1. 确认 `NOVELAI_URL` / `NOVELAI_API_KEY`（token）填进 `.env`
2. 按官方文档核实上面那串 body 字段，实现 `generate(...) -> list[tuple[bytes, str]]`
   （返回 `[(图片字节, mime), ...]`，和 `services/comfyui.py` 的 `generate` 保持同一签名），
   注意返回是 **zip**，要先解包
3. 在 `routers/imagegen.py` 的分派里把 `novelai` 分支从 501 换成真实调用
"""

from __future__ import annotations

_API_HINT = "POST https://image.novelai.net/ai/generate-image（Bearer token，返回 zip 流）"


class NovelAINotImplemented(NotImplementedError):
    """引擎已选中但实现未落地时抛这个，路由层翻译成 501。"""


async def generate(*_args, **_kwargs) -> list[tuple[bytes, str]]:
    """占位：本轮未实接。参数签名对齐 services/comfyui.py 的 generate。"""
    raise NovelAINotImplemented(
        f"NovelAI 通道还没实接（{_API_HINT}）。"
        "这轮只留了插槽 —— 协议与 OpenAI 不兼容，得照着官方文档单独适配，"
        "不做猜测实现。先把 NOVELAI_URL / NOVELAI_API_KEY 填好，"
        "等这个 provider 写完了就能直接切过来。"
    )