"""Prompt 组装实现。

组装顺序（对应《项目要求》§9.1）：人设 → 世界书命中 → 越狱规则。
记忆检索（向量 RAG）阶段 2 后半段再接入，此处不注入。
"""

from __future__ import annotations

from ... import db

DEFAULT_PERSONA = (
    "你是小糖人之家的一员，一个温柔、可爱、贴心的伙伴。"
    "用自然的中文交流，真诚地回应。"
)

# 扫描世界书时回看的最近消息条数
WORLDBOOK_WINDOW = 10

# 档案里挑出来、用「键：值」展示的字段（越靠前越重要）
_PROFILE_ROWS: list[tuple[str, str]] = [
    ("日文假名", "jp"),
    ("别名", "alias"),
    ("生日", "birthday"),
    ("年龄", "age"),
    ("身高", "height"),
    ("血型", "bloodType"),
    ("星座", "constellation"),
    ("职业", "occupation"),
    ("性格", "personality"),
    ("喜好", "likes"),
    ("讨厌", "dislikes"),
    ("口头禅", "catchphrase"),
    ("体型", "bodyType"),
    ("瞳色", "eyeColor"),
    ("发型", "hairstyle"),
    ("发色", "hairColor"),
    ("胸部", "bust"),
    ("臀部", "hip"),
    ("服装", "clothing"),
    ("关系", "relationships"),
    ("特殊特征", "specialFeatures"),
]

_PRIVATE_ROWS: list[tuple[str, str]] = [
    ("体重", "weight"),
    ("三围", "measurements"),
    ("秘密", "secret"),
    ("弱点", "weakPoint"),
    ("私密小愿望", "privateWish"),
]


def _val(profile: dict, key: str) -> str:
    v = profile.get(key)
    if isinstance(v, list):
        return "、".join(str(x) for x in v if x)
    return str(v).strip() if v else ""


def _persona_block(profile: dict) -> str:
    name = profile.get("name") or "小糖人"
    lines = [f"【{name}】", ""]
    about = (profile.get("about") or "").strip()
    if about:
        lines.append(about)
        lines.append("")
    for label, key in _PROFILE_ROWS:
        value = _val(profile, key)
        if value:
            lines.append(f"- {label}：{value}")
    priv = [(label, _val(profile, key)) for label, key in _PRIVATE_ROWS]
    priv = [(k, v) for k, v in priv if v]
    if priv:
        lines.append("")
        lines.append(
            "（以下是她自己心知、不会主动摊开的私密信息，仅在对话自然涉及或她主动提起时才流露）"
        )
        for label, value in priv:
            lines.append(f"- {label}：{value}")
    return "\n".join(lines)


def _group_director(names: list[str]) -> str:
    return (
        f"这是一个多人聊天场景，在场角色有：{'、'.join(names)}。"
        "请你一人分饰多角：轮流扮演在场的每个角色，让她们自然地对话、互相搭话或拌嘴。"
        "每位角色都要保持自己的语气与个性，不要串戏；用户是大家同处一屋的「哥哥/姐姐」。"
    )


def _worldbook_hits(texts: list[str]) -> list[dict]:
    blob = "\n".join(texts).lower()
    hits: list[dict] = []
    for entry in db.list_worldbook():
        if not entry.get("enabled", True):
            continue
        keywords = [k.strip() for k in (entry.get("keywords") or "").split(",") if k.strip()]
        if not keywords:
            continue
        if any(kw.lower() in blob for kw in keywords):
            hits.append(entry)
    hits.sort(key=lambda e: -(e.get("priority") or 0))
    return hits


def build_system_prompt(
    character_ids: list[str] | None = None,
    messages: list[dict] | None = None,
) -> str:
    """组装最终 system prompt。

    character_ids：本会话在场角色 id（空/缺省时默认全员在场）。
    messages：聊天历史，用于世界书关键词扫描（取最近 N 条）。
    """
    messages = messages or []
    ids = [i for i in (character_ids or []) if i]

    by_id = {c["id"]: c for c in db.list_characters()}
    profiles = [by_id[i] for i in ids if i in by_id] if ids else []
    if not profiles:
        # 未指定 / 全部未知：默认全家在场（贴合「家」模型）。
        profiles = list(db.list_characters())

    parts: list[str] = []
    if len(profiles) == 1:
        parts.append(_persona_block(profiles[0]))
        parts.append("请用她的语气自然回应，保持中文，不要跳出角色或提及以上设定本身。")
    elif len(profiles) > 1:
        parts.append(_group_director([p.get("name") or "小糖人" for p in profiles]))
        parts.append("—— 各角色设定 ——")
        for p in profiles:
            parts.append(_persona_block(p))
    else:
        parts.append(DEFAULT_PERSONA)

    recent = [str(m.get("content") or "") for m in messages[-WORLDBOOK_WINDOW:]]
    hits = _worldbook_hits(recent)
    if hits:
        block = ["【当前场景背景 · 世界书】"]
        for h in hits:
            content = (h.get("content") or "").strip()
            block.append(f"- {h.get('title', '')}：{content}")
        parts.append("\n".join(block))

    jailbreak = (db.get_settings().get("jailbreak") or "").strip()
    if jailbreak:
        parts.append(f"【规则 / 越狱提示】\n{jailbreak}")

    return "\n\n".join(p for p in parts if p)