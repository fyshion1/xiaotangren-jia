"""自动记忆提取（对应《项目要求》§9.3「什么值得记」）。

思路：不每条消息都叫一次 LLM（费钱又吵），而是先**规则预筛**——
消息里出现「记得/以后/约定/答应」这类长期承诺词，或明显的情感浓烈时刻，
才把最近几轮喂给 LLM 提炼成 0~3 条「值得长期记住」的短句，再走 §9.2 的分桶落库。

两条落地规则（§9.2.2）：私聊提炼出的记忆默认只进 TA 的个人桶；
群聊提炼出的**按内容判**——只有明显「某人私下告诉你的事」才落个人桶，
其余共享进家桶。宁可多进家桶也不乱猜隐私（判错方向代价更大）。

低耦合：本模块不碰『存哪』以外的策略，检索/注入仍在 services/memory.py。
"""

from __future__ import annotations

import json
import re

from ..providers import openai
from . import memory as mem

# 触发词：明确指涉「长期 / 承诺 / 值得记住」。命中任意一个才值得叫 LLM。
TRIGGER_PATTERNS: list[str] = [
    r"记[得住牢]",
    r"别忘了?|别忘",
    r"以[后前]",
    r"约定|说好|答应|保证|发誓",
    r"下次|将来|以后每年",
    r"永远|一直|再也不",
    r"秘密|别告诉|只告诉",
    r"生日|纪念日|忌日",
    r"我(喜欢|讨厌|害怕|最怕)",
    r"叫我|我的名字|我叫",
    r"很重要|对我来说|不能忘",
]

# 情感浓烈信号（弱触发：单独出现不触发，得和上面的词配合看上下文长度）
_EMOTION_HINTS = ["爱你", "想你", "舍不得", "难过", "开心死", "太好了", "谢谢"]

_TRIGGER_RE = re.compile("|".join(TRIGGER_PATTERNS))

# 提炼时喂给 LLM 的最近消息条数（§9.3：情感浓烈/长期信息要看上下文，不能只看一句）
DISTILL_WINDOW = 12

# 单条记忆短句的长度上限，防止模型写成小作文
MAX_MEMORY_LEN = 120

_SYSTEM = (
    "你是一个记忆提炼器，从聊天片段里挑出**值得长期记住**的事，提炼成简短陈述句。\n"
    "只提炼这几类：\n"
    "1) 约定与承诺（说好以后要一起做的事）\n"
    "2) 长期偏好（喜欢/讨厌/害怕的东西、习惯）\n"
    "3) 重要的个人信息（名字、生日、称呼、身份）\n"
    "4) 只有特定人知道的小秘密\n"
    "5) 情感上很重要的时刻\n"
    "不要提炼：一次性的话题、寒暄、玩笑、当下就结束的事、以及任何你不确定的事实。\n"
    "每条写成一句第三人称的短句（如「哥哥答应周末带小诗音去买鱼」），"
    f"不超过 {MAX_MEMORY_LEN} 字，不要加引号、不要编号、不要解释。\n"
    "另外判断这条是不是「私下才会说的私密事」（private=true）——"
    "只有明显是某个人悄悄告诉用户的才为 true，拿不准就 false。\n"
    '严格只输出 JSON，格式：{"memories":[{"text":"...","private":false,"who":"角色名或空"}]}\n'
    "没有值得记的就输出 {\"memories\":[]}。"
)


def should_trigger(text: str) -> bool:
    """规则预筛：这条内容值不值得叫 LLM 提炼（§9.3）。"""
    t = (text or "").strip()
    if len(t) < 4:
        return False
    if _TRIGGER_RE.search(t):
        return True
    # 情感浓烈词 + 有一定长度（避免「爱你」两个字就触发一次提炼）
    return len(t) >= 12 and any(h in t for h in _EMOTION_HINTS)


def pick_candidates(messages: list[dict], window: int = DISTILL_WINDOW) -> list[dict]:
    """从最近消息里挑出触发区（命中触发词的消息 + 它前面一条，给点上下文）。"""
    recent = list(messages or [])[-window:]
    if not recent:
        return []
    picked: list[dict] = []
    for i, m in enumerate(recent):
        content = str(m.get("content") or "")
        if should_trigger(content):
            if i > 0 and (not picked or picked[-1] is not recent[i - 1]):
                picked.append(recent[i - 1])
            picked.append(m)
    return picked


def _strip_fences(raw: str) -> str:
    """去掉模型爱包的 ```json 围栏，再从里面抠出第一个 JSON 对象。"""
    text = (raw or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    if text.startswith("{") and text.endswith("}"):
        return text
    start, end = text.find("{"), text.rfind("}")
    if 0 <= start < end:
        return text[start : end + 1]
    return ""


def parse_memories(raw: str) -> list[dict]:
    """解析 LLM 输出成 [{text, private, who}]；解析失败返回空（不猜）。"""
    cleaned = _strip_fences(raw)
    if not cleaned:
        return []
    try:
        obj = json.loads(cleaned)
    except (ValueError, TypeError):
        return []
    items = obj.get("memories") if isinstance(obj, dict) else None
    if not isinstance(items, list):
        return []
    out: list[dict] = []
    for item in items:
        if isinstance(item, str):
            item = {"text": item}
        if not isinstance(item, dict):
            continue
        text = str(item.get("text") or "").strip().strip("「」\"'")
        if not text:
            continue
        out.append(
            {
                "text": text[:MAX_MEMORY_LEN],
                "private": bool(item.get("private")),
                "who": str(item.get("who") or "").strip(),
            }
        )
    return out


def _fmt_candidate(messages: list[dict], name_of: dict[str, str]) -> str:
    lines: list[str] = []
    for m in messages:
        role = m.get("role") or "user"
        who = "哥哥" if role == "user" else (name_of.get(str(m.get("character_id") or "")) or "小糖人")
        lines.append(f"{who}：{str(m.get('content') or '').strip()}")
    return "\n".join(lines)


def _resolve_who(who: str, name_of: dict[str, str]) -> str:
    """把模型给的角色名映射回角色 id（名字对不上就返回空）。"""
    w = (who or "").strip()
    if not w:
        return ""
    for cid, name in name_of.items():
        if name and (name in w or w in name):
            return cid
    return ""


async def extract(
    messages: list[dict],
    character_ids: list[str],
    session_kind: str = "group",
    name_of: dict[str, str] | None = None,
    base_url: str = "",
    api_key: str = "",
    model: str = "",
    force: bool = False,
    save: bool = True,
    feature_id: str = "",
) -> dict:
    """从聊天片段里提炼记忆并（可选）落库。

    messages：最近若干轮，元素形如 {"role","content","character_id"}。
    name_of：{char_id: 名字}，用于让模型知道是谁在说话、以及把 who 映回 id。
    force=True 时跳过触发词预筛（用户手动点「提炼记忆」用）。
    save=False 时只返回提炼结果不落库（预览用）。
    feature_id：记忆归属的功能命名空间。普通聊天留空（存 game_id=''）；
        游戏 / 小窝外设传入自己的 id，这样提炼出的记忆只在同一个功能里召回，
        **不会漏进日常聊天**（§9.6 记忆隔离）。
    """
    name_of = name_of or {}
    candidates = pick_candidates(messages)
    if not force and not candidates:
        return {"triggered": False, "memories": [], "saved": []}
    feed = candidates or list(messages or [])[-DISTILL_WINDOW:]
    if not feed:
        return {"triggered": False, "memories": [], "saved": []}

    user_block = _fmt_candidate(feed, name_of)
    known = "、".join(n for n in name_of.values() if n) or "（未知）"
    prompt = f"在场角色：{known}\n\n聊天片段：\n{user_block}"

    raw = await openai.complete_chat(
        [
            {"role": "system", "content": _SYSTEM},
            {"role": "user", "content": prompt},
        ],
        model=model,
        base_url=base_url,
        api_key=api_key,
        max_tokens=600,
        temperature=0.2,
    )
    distilled = parse_memories(raw)

    ids = [i for i in (character_ids or []) if i]
    default_bucket, default_char = mem.bucket_of(session_kind, ids)

    saved: list[dict] = []
    for item in distilled:
        # 私聊 → 一律进 TA 个人桶（§9.2.2 默认打标，模型判定也翻不了这条案）
        if session_kind == "single" and default_char:
            bucket, char_id = mem.PERSONAL, default_char
        elif item["private"]:
            who_id = _resolve_who(item["who"], name_of)
            bucket = mem.PERSONAL if who_id else mem.HOME
            char_id = who_id if who_id else ""
        else:
            bucket, char_id = mem.HOME, ""
        if not save:
            item = {**item, "bucket": bucket, "char_id": char_id}
            saved.append(item)
            continue
        record = mem.remember(
            text=item["text"],
            bucket=bucket,
            char_id=char_id,
            source="auto",
            meta={"private": item["private"], "who": item["who"]},
            # 功能命名空间写进 game_id 列（列名历史原因叫 game_id，语义是「功能隔离键」，见 §9.6）。
            # 普通聊天留空 → game_id=''，与游戏/外设的记忆互相召回不到。
            game_id=feature_id,
        )
        if record:
            record.pop("vector", None)
            saved.append(record)

    return {"triggered": True, "memories": distilled, "saved": saved}