"""通用 ComfyUI 客户端（对应《项目要求》§7）。

**本地与云端共用这一套实现** —— ComfyUI 的 HTTP 协议是同一个：
    POST /prompt            {prompt: <API 格式图>, client_id}  → {prompt_id}
    GET  /history/{id}      完成前为空对象；完成后含 outputs
    GET  /view              ?filename=&subfolder=&type=output   → 图片字节
    GET  /system_stats      存活探针

只有 base_url 不同，所以「本地 ComfyUI」和「云端 ComfyUI（CNB）」不是两套代码。

## 两条硬约束（踩坑预防，另见《项目要求》§16）

1. **超时分层**：`/prompt` 与 `/view` 用短读超时（连接 10s / 读取 60s）。
   轮询**不靠长读超时** —— 那是 openai.py 里 300s 的做法，实例一卡就挂满 5 分钟。
   这里用「短超时请求 + 外层循环累计」，总预算由调用方传入的 timeout 卡住。

2. **`n>1` 必须递增 seed 循环**：ComfyUI 对相同 `seed + prompt` 返回同一张图，
   批量靠加大 `n` 拿到的是同一张的副本。必须逐张改 seed 重新提交。

## 参数注入按「拓扑」定位，不硬编码节点 id

用户会自己改工作流、重新连线，写死 `"3"` / `"6"` 这类 id 迟早崩。改为顺着连线找：
    正向提示词 ← KSampler.inputs.positive → CLIPTextEncode
    负向提示词 ← KSampler.inputs.negative → CLIPTextEncode
    宽高       ← sampler.inputs.latent_image → EmptyLatentImage
    输出       ← SaveImage / PreviewImage
找不到时**把扫到的 class_type 集合原样报出来**（§16.2：不吞上游错误，别让用户面对一句「生图失败」）。
"""

from __future__ import annotations

import asyncio
import json
import random
import uuid
from pathlib import Path

import httpx

# 错误提示里给用户看的「怎么修」
_HINT_WORKFLOW = (
    "请在 ComfyUI 里用「Save (API Format)」导出工作流 json，"
    "把路径填进 COMFYUI_WORKFLOW（或替换 backend/examples/comfyui/ 里的示例）。"
)

# 短超时：连接快、读也快；长时间等待交给外层轮询循环
_TIMEOUT = httpx.Timeout(60.0, connect=10.0)

# 采样器节点（seed / steps / cfg / sampler 都在它身上）
_SAMPLER_TYPES = {"KSampler", "KSamplerAdvanced", "SamplerCustom", "KSampler (Efficient)"}
_OUTPUT_TYPES = {"SaveImage", "PreviewImage", "SaveImageWebsocket"}
_TEXT_ENCODE_TYPES = {"CLIPTextEncode", "CLIPTextEncodeSDXL", "BNK_CLIPTextEncodeAdvanced"}

# 单次批量上限（≥ 就逐张改 seed 重跑，很贵，别放开太多）
MAX_BATCH = 4


class ComfyUIError(RuntimeError):
    """ComfyUI 侧的错误。message 已带上「缺什么 / 该改哪里」，直接透给前端。"""


def _base(base_url: str) -> str:
    return (base_url or "").strip().rstrip("/")


def _class_types(workflow: dict) -> list[str]:
    return sorted({str(n.get("class_type") or "?") for n in workflow.values() if isinstance(n, dict)})


def _nodes_of(workflow: dict, types: set[str]) -> list[tuple[str, dict]]:
    return [
        (nid, node)
        for nid, node in workflow.items()
        if isinstance(node, dict) and str(node.get("class_type") or "") in types
    ]


def _link_target(node: dict, input_name: str) -> str | None:
    """取某个 input 连的上游节点 id。

    API 格式里连线是 `[node_id, output_index]`，也可能直接给 node_id 字符串。
    """
    ref = (node.get("inputs") or {}).get(input_name)
    if isinstance(ref, list) and ref:
        ref = ref[0]
    return ref if isinstance(ref, str) else None


# ---- 节点定位 ----


def _find_sampler(workflow: dict) -> tuple[str, dict]:
    samplers = _nodes_of(workflow, _SAMPLER_TYPES)
    if not samplers:
        raise ComfyUIError(
            f"工作流里找不到采样器节点（KSampler 等）。实际节点类型：{_class_types(workflow)}。{_HINT_WORKFLOW}"
        )
    # KSamplerAdvanced 更常见于高清修复流程，优先取「非 refine」的那一个（第一个）
    return samplers[0]


def _find_text_encoder(workflow: dict, sampler: dict, input_name: str) -> tuple[str, dict]:
    ref = _link_target(sampler, input_name)
    node = workflow.get(ref) if ref else None
    if isinstance(node, dict) and str(node.get("class_type") or "") in _TEXT_ENCODE_TYPES:
        return ref, node
    # 退化：连线断了 / 被换成了 ConditionCombine 之类，就按类型随便挑一个可用的
    cands = [pair for pair in _nodes_of(workflow, _TEXT_ENCODE_TYPES) if pair[0] != ref]
    if not cands:
        raise ComfyUIError(
            f"工作流里找不到 CLIPTextEncode 节点（{input_name} 提示词没处写）。"
            f"实际节点类型：{_class_types(workflow)}。{_HINT_WORKFLOW}"
        )
    # 正向取第一个、负向取第二个，尽量拉开
    idx = 0 if input_name == "positive" else min(1, len(cands) - 1)
    return cands[idx]


def _find_latent(workflow: dict, sampler: dict) -> tuple[str, dict] | None:
    ref = _link_target(sampler, "latent_image")
    node = workflow.get(ref) if ref else None
    if isinstance(node, dict) and "width" in (node.get("inputs") or {}) and "height" in (
        node.get("inputs") or {}
    ):
        return ref, node
    return None


def _find_outputs(workflow: dict) -> list[tuple[str, dict]]:
    out = _nodes_of(workflow, _OUTPUT_TYPES)
    if not out:
        raise ComfyUIError(
            f"工作流里没有 SaveImage / PreviewImage 节点，拿不到图。"
            f"实际节点类型：{_class_types(workflow)}。{_HINT_WORKFLOW}"
        )
    return out


# ---- 参数注入 ----


def load_workflow(path: str | None = None, builtin: str | None = None) -> dict:
    """读一份 API 格式工作流。path 优先；否则读内置示例。"""
    target: Path | None = None
    if path and str(path).strip():
        target = Path(str(path).strip())
        if not target.is_file():
            raise ComfyUIError(f"COMFYUI_WORKFLOW 指向的文件不存在：{target}")
    elif builtin:
        target = Path(__file__).resolve().parent.parent.parent / "examples" / "comfyui" / builtin
        if not target.is_file():
            raise ComfyUIError(f"内置示例工作流缺失：{target}")
    if target is None:
        raise ComfyUIError(f"没有可用的工作流。{_HINT_WORKFLOW}")
    try:
        data = json.loads(target.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ComfyUIError(f"工作流不是合法 JSON（{target}）：{exc}") from exc
    if not isinstance(data, dict) or not data:
        raise ComfyUIError(f"工作流内容为空或格式不对（{target}）：顶层应是 {{节点id: 节点}}。")
    # 有些导出会包一层 {"prompt": {...}}
    inner = data.get("prompt")
    if isinstance(inner, dict) and inner and all(isinstance(v, dict) for v in inner.values()):
        return inner
    return data


def apply_params(
    workflow: dict,
    *,
    prompt: str | None = None,
    negative: str | None = None,
    width: int | None = None,
    height: int | None = None,
    seed: int | None = None,
    steps: int | None = None,
    cfg: float | None = None,
) -> dict:
    """把参数按拓扑注入工作流副本，返回新 dict（不改原对象）。"""
    wf = json.loads(json.dumps(workflow))  # 深拷贝：同一次请求要跑 n 张，不能互相污染
    _, sampler = _find_sampler(wf)

    if prompt is not None:
        _, pos = _find_text_encoder(wf, sampler, "positive")
        pos.setdefault("inputs", {})["text"] = prompt
    if negative is not None:
        _, neg = _find_text_encoder(wf, sampler, "negative")
        neg.setdefault("inputs", {})["text"] = negative

    inputs = sampler.setdefault("inputs", {})
    if seed is not None:
        # KSamplerAdvanced 用 noise_seed；两个键都在就一起写，谁在就用谁
        if "noise_seed" in inputs:
            inputs["noise_seed"] = int(seed)
        if "seed" in inputs:
            inputs["seed"] = int(seed)
        if "seed" not in inputs and "noise_seed" not in inputs:
            inputs["seed"] = int(seed)  # 都没有就补一个常规键，至少不是每次同图
    if steps is not None and "steps" in inputs:
        inputs["steps"] = int(steps)
    if cfg is not None and "cfg" in inputs:
        inputs["cfg"] = float(cfg)

    if width or height:
        latent = _find_latent(wf, sampler)
        if latent is None:
            raise ComfyUIError(
                "工作流里找不到带 width/height 的潜空间节点（EmptyLatentImage 等），改不了尺寸。"
                f"实际节点类型：{_class_types(wf)}。"
            )
        lin = latent[1].setdefault("inputs", {})
        if width:
            lin["width"] = int(width)
        if height:
            lin["height"] = int(height)
    return wf


def parse_size(size: str) -> tuple[int | None, int | None]:
    """'832x1216' → (832, 1216)；解析不了就返回 (None, None) 交给工作流自带尺寸。"""
    try:
        w, h = str(size or "").lower().split("x", 1)
        return int(w), int(h)
    except (ValueError, AttributeError):
        return None, None


# ---- HTTP ----


async def health(base_url: str) -> bool:
    """存活探针。不可达 / 非 ComfyUI → False（不抛错，调用方只需布尔）。"""
    base = _base(base_url)
    if not base:
        return False
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(3.0, connect=2.0)) as client:
            resp = await client.get(f"{base}/system_stats")
        return resp.status_code < 400
    except Exception:  # noqa: BLE001
        return False


async def submit(base_url: str, workflow: dict) -> str:
    """提交一次任务，返回 prompt_id。"""
    base = _base(base_url)
    payload = {"prompt": workflow, "client_id": uuid.uuid4().hex}
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            resp = await client.post(f"{base}/prompt", json=payload)
    except httpx.HTTPError as exc:
        raise ComfyUIError(f"连不上 ComfyUI（{base}）：{exc}。确认它在跑，且地址填对了。") from exc
    if resp.status_code >= 400:
        body = resp.text[:800]
        # ComfyUI 校验失败会把「哪个节点的哪个输入不合法」放进 error 里，照实透出
        try:
            obj = resp.json()
            err = obj.get("error")
            if isinstance(err, dict):
                detail = err.get("message") or json.dumps(err, ensure_ascii=False)
                node_errors = obj.get("node_errors")
                if node_errors:
                    detail += f"；节点报错：{json.dumps(node_errors, ensure_ascii=False)[:400]}"
                body = str(detail)
        except Exception:  # noqa: BLE001
            pass
        raise ComfyUIError(f"ComfyUI 拒绝了这个工作流（{resp.status_code}）：{body}")
    obj = resp.json()
    prompt_id = obj.get("prompt_id")
    if not prompt_id:
        raise ComfyUIError(f"ComfyUI 没返回 prompt_id：{json.dumps(obj, ensure_ascii=False)[:400]}")
    return str(prompt_id)


async def wait(base_url: str, prompt_id: str, timeout: float = 180.0) -> dict:
    """轮询 /history/{id} 直到出结果，返回该次执行的 history 条目。

    短超时请求 + 外层累计：卡住的实例只会在单次请求上耗 60s，总预算由 timeout 控住。
    """
    base = _base(base_url)
    deadline = asyncio.get_running_loop().time() + max(5.0, float(timeout))
    last: dict = {}
    while True:
        try:
            async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
                resp = await client.get(f"{base}/history/{prompt_id}")
            if resp.status_code < 400:
                last = resp.json() or {}
                entry = last.get(prompt_id) if isinstance(last, dict) else None
                if isinstance(entry, dict) and entry:
                    status = (entry.get("status") or {}).get("status_str")
                    if status == "error":
                        msgs = (entry.get("status") or {}).get("messages") or []
                        raise ComfyUIError(
                            f"ComfyUI 执行出错：{json.dumps(msgs, ensure_ascii=False)[:600]}"
                        )
                    outputs = entry.get("outputs") or {}
                    if outputs:
                        return entry
        except httpx.HTTPError:
            pass  # 单次抖动不算失败，继续轮询到总预算耗尽
        if asyncio.get_running_loop().time() >= deadline:
            raise ComfyUIError(
                f"等 ComfyUI 出图超时（{int(timeout)}s）。任务可能仍在跑 —— "
                "可以调大 COMFYUI_TIMEOUT，或先看 ComfyUI 控制台有没有报错。"
            )
        await asyncio.sleep(1.0)


def _output_images(entry: dict) -> list[dict]:
    """从 history 条目里抠出所有图片引用（可能来自多个输出节点）。"""
    out: list[dict] = []
    for node_out in (entry.get("outputs") or {}).values():
        if not isinstance(node_out, dict):
            continue
        for item in node_out.get("images") or []:
            if isinstance(item, dict) and item.get("filename"):
                out.append(item)
    return out


async def fetch(base_url: str, item: dict) -> bytes:
    """按 /view 取一张图的字节。"""
    base = _base(base_url)
    params = {
        "filename": item.get("filename"),
        "subfolder": item.get("subfolder") or "",
        "type": item.get("type") or "output",
    }
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        resp = await client.get(f"{base}/view", params=params)
    if resp.status_code >= 400:
        raise ComfyUIError(f"取图失败（{resp.status_code}）：{params}")
    return resp.content


def _mime_of(filename: str) -> str:
    ext = str(filename or "").rsplit(".", 1)[-1].lower()
    return {
        "png": "image/png",
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "webp": "image/webp",
        "gif": "image/gif",
    }.get(ext, "image/png")


async def generate(
    base_url: str,
    workflow: dict,
    *,
    prompt: str,
    negative: str = "",
    size: str = "832x1216",
    n: int = 1,
    seed: int | None = None,
    steps: int | None = None,
    cfg: float | None = None,
    timeout: float = 180.0,
) -> list[tuple[bytes, str]]:
    """跑 n 张图，返回 [(字节, mime), ...]。

    n 张 = n 次提交，每次 seed 递增 —— ComfyUI 对相同 seed+prompt 返回同一张图。
    """
    count = max(1, min(int(n or 1), MAX_BATCH))
    width, height = parse_size(size)
    # 先确认拿得到图，别跑完一轮才发现输出节点没接
    _find_outputs(workflow)
    base_seed = int(seed) if seed is not None else random.randint(0, 2**31 - 1)
    results: list[tuple[bytes, str]] = []
    for i in range(count):
        wf = apply_params(
            workflow,
            prompt=prompt or None,
            negative=negative or None,
            width=width,
            height=height,
            seed=base_seed + i,
            steps=steps,
            cfg=cfg,
        )
        prompt_id = await submit(base_url, wf)
        entry = await wait(base_url, prompt_id, timeout=timeout)
        images = _output_images(entry)
        if not images:
            raise ComfyUIError(
                "ComfyUI 跑完了但输出节点没吐出图片。检查 SaveImage 是否连在采样结果上。"
            )
        first = images[0]  # 一次任务通常只有一张；多输出节点时取第一个
        results.append((await fetch(base_url, first), _mime_of(first.get("filename", ""))))
    return results


def builtin_workflow_name() -> str:
    """内置示例工作流文件名（见 examples/comfyui/）。"""
    return "sd15_basic.json"