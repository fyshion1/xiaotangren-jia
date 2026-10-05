"""Prompt 组装实现。

组装顺序（对应《项目要求》§9.1）：
人设 → 世界书命中 → 记忆检索（§9.2 三层 RAG）→ 越狱规则。
"""

from __future__ import annotations

import re

from ... import db
from .. import memory as memory_service
from . import forms as forms_service

DEFAULT_PERSONA = (
    "你是小糖人之家的一员，一个温柔、可爱、贴心的伙伴。"
    "用自然的中文交流，真诚地回应。"
)

# 扫描世界书时回看的最近消息条数
WORLDBOOK_WINDOW = 10

# 记忆检索时拼接 query 的最近消息条数（§9.2.3）
MEMORY_QUERY_WINDOW = 4

# 群聊历史里识别「**角色名**：」/「【角色名】：」段首签名的正则（与前端 NAME_MARKER 同口径）
_SPEAKER_MARKER = re.compile(r"^\s*(?:\*\*([^*\n]+?)\*\*|【([^】\n]+?)】)\s*[:：]?")

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
    # 形态（§17）：先解析出当前形态的完整档案，再据此组装 —— 换形态即换人设 / 外貌 / 提示词
    profile = forms_service.resolve_form(profile)
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
        "每位角色都要保持自己的语气与个性，不要串戏；用户是谁见下文的「用户身份」。"
        "格式要求：每位角色发言时，先另起一行写「**角色名**：」，再写动作描写和小段台词；"
        "每个人一段，段落之间空一行分开，不要挤在一个大段落里。"
    )


def _strip_absent_speakers(messages: list[dict], present: set[str]) -> list[dict]:
    """群聊历史清洗（§25 补丁二）：把不在场角色的发言段落从上下文里删掉。

    与「在场名单」块构成双保险：名单是提示词层的事前警告，这里是历史层的事前删除。
    只动发往模型的副本，库里的记录原封不动 —— 改阵容再改回来，发言全部都在。
    """
    out: list[dict] = []
    for m in messages:
        if m.get("role") != "assistant":
            out.append(m)
            continue
        lines = str(m.get("content") or "").split("\n")
        kept: list[str] = []
        skipping = False
        for line in lines:
            match = _SPEAKER_MARKER.match(line)
            if match:
                speaker = (match.group(1) or match.group(2) or "").strip()
                skipping = bool(speaker) and speaker not in present
            if skipping:
                continue
            kept.append(line)
        # 全段都是缺席者发言 → 整条丢掉，别给模型留一句空壳
        if "\n".join(kept).strip():
            out.append({**m, "content": "\n".join(kept).rstrip()})
    return out


def _roster_notice(present: list[str], absent: list[str]) -> str:
    """群聊里明确「谁不在场」（§25 补丁）。

    光把不在场的人从角色设定块里摘掉是不够的：聊天记录里还留着她以前的发言，
    模型会顺着那个格式继续往下写（用户实测：「让小红薯头不在场，结果她还是回复了」）。
    所以这里用否定式再点一遍名 —— 只在真有人不在场时追加，全员在场时一个字不多写。
    """
    lines = [
        "【本轮在场名单 · 必须遵守】",
        f"这一轮只有这几位在场：{'、'.join(present)}。",
    ]
    for name in absent:
        lines.append(
            f"{name} 目前不在场。上面「角色设定」与聊天记录里都还有她，那是她的过去，"
            f"但**这一轮她不是对话者**：\n"
            f"- 不要写以「{name}：」开头的段落；\n"
            f"- 不要用她的口头禅与台词，也不要让别的角色替她说话，或描述她的动作；\n"
            f"- 聊天记录里她以前的发言只是历史，不要顺着那个格式继续往下写。"
        )
    return "\n".join(lines)


def _user_block(persona: dict) -> str:
    """告诉小糖人「现在和她们说话的是谁」（§22）。

    以前这里写死成「用户是大家同处一屋的『哥哥/姐姐』」，现在换成用户自己那份档案里的
    `relation` —— 这正是「用不同身份对话更有趣」的着力点：切到汐子，她们眼里的人就变了。

    relation 是用户视角的第二人称自述（私人空间里就那么显示），所以这里补一句说明，
    免得模型把里面的「你」当成小糖人自己。
    """
    name = (persona.get("name") or "用户").strip()
    alias = (persona.get("alias") or "").strip()
    relation = (persona.get("relation") or "").strip()
    lines = [f"【用户身份】正在和你说话的人是「{name}」" + (f"（{alias}）" if alias else "") + "。"]
    if relation:
        lines.append(f"以下是这个人自述的身份说明（其中「你」指用户本人，而不是你）：{relation}")
    return "\n".join(lines)


def _worldbook_hits(texts: list[str], owners: list[str]) -> list[dict]:
    """世界书按归属分家（§19）：私聊只吃自己那位 + 家共用；群聊只吃家共用。

    owners 由调用方按在场人数决定，这里只管把这几档拿去匹配。
    """
    blob = "\n".join(texts).lower()
    hits: list[dict] = []
    for owner in owners:
        for entry in db.list_worldbook(owner):
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
    uncensored: bool = False,
    persona: dict | None = None,
) -> str:
    """组装最终 system prompt。

    character_ids：本会话在场角色 id（空/缺省时默认全员在场）。
    messages：聊天历史，用于世界书关键词扫描（取最近 N 条）。
    uncensored：是否走无审查通道——为真时额外追加「无审查专属」越狱块。
    persona：当前用户身份档案（§22）。给了就注入「用户身份」块，替代写死的哥哥/姐姐。
    """
    messages = messages or []
    ids = [i for i in (character_ids or []) if i]

    by_id = {c["id"]: c for c in db.list_characters()}
    profiles = [by_id[i] for i in ids if i in by_id] if ids else []
    if not profiles:
        # 未指定 / 全部未知：默认全家在场（贴合「家」模型）。
        profiles = list(db.list_characters())

    # 群聊双保险（§25）之二：不在场者的发言段落直接从上下文里洗掉。
    # 注意这是「发往模型的副本」，库里原记录不动 —— 阵容改回来，发言全都还在。
    present_names = {p.get("name") or "小糖人" for p in profiles}
    if len(profiles) > 1 and len(by_id) > len(present_names):
        messages = _strip_absent_speakers(messages, present_names)

    parts: list[str] = []
    if len(profiles) == 1:
        parts.append(_persona_block(profiles[0]))
        parts.append("请用她的语气自然回应，保持中文，不要跳出角色或提及以上设定本身。")
    elif len(profiles) > 1:
        parts.append(_group_director([p.get("name") or "小糖人" for p in profiles]))
        parts.append("—— 各角色设定 ——")
        for p in profiles:
            parts.append(_persona_block(p))
        # 阵容之外的人要点名说「不在场」，否则模型会跟着聊天记录里她的旧发言继续写（§25）。
        present = [p.get("name") or "小糖人" for p in profiles]
        absent = [
            c.get("name") or "小糖人"
            for c in db.list_characters()
            if (c.get("name") or "小糖人") not in present
        ]
        if absent:
            parts.append(_roster_notice(present, absent))
    else:
        parts.append(DEFAULT_PERSONA)

    # 用户身份（§22）：紧跟在「她们是谁」后面说清「在和谁说话」。
    if persona:
        parts.append(_user_block(persona))

    # 自我档案注入（§23）：inject=true 且角色可见的区块
    if persona:
        try:
            from . import self_profile as _sp
            self_block = _sp.inject_self_profile(persona, ids)
            if self_block:
                parts.append(self_block)
        except Exception:  # noqa: BLE001
            # 自我档案缺失不拖垮聊天
            pass

    recent = [str(m.get("content") or "") for m in messages[-WORLDBOOK_WINDOW:]]
    # 世界书归属（§19）：单人在场 → 她的专属 + 家共用；多人 / 无人在场 → 只有家共用。
    wb_owners = [""] if len(profiles) != 1 else [profiles[0].get("id") or "", ""]
    hits = _worldbook_hits(recent, wb_owners)
    if hits:
        block = ["【当前场景背景 · 世界书】"]
        for h in hits:
            content = (h.get("content") or "").strip()
            block.append(f"- {h.get('title', '')}：{content}")
        parts.append("\n".join(block))

    # 记忆三层 RAG（§9.2）：query = 最近几轮拼接，只注入「在场者」的记忆
    mem_ids = [p.get("id") for p in profiles if p.get("id")]
    query = memory_service.build_query(messages, MEMORY_QUERY_WINDOW)
    if mem_ids and query:
        try:
            recalled = memory_service.recall_for(
                mem_ids,
                query,
                session_kind="single" if len(profiles) == 1 else "group",
            )
            name_of = {p.get("id") or "": p.get("name") or "小糖人" for p in profiles}
            mem_block = memory_service.format_memory_block(recalled, name_of)
            if mem_block:
                parts.append(mem_block)
        except Exception:  # noqa: BLE001
            # 记忆检索失败不该拖垮聊天：模型没装好 / 向量库异常时静默跳过
            pass

    settings = db.get_settings()
    jailbreak = (settings.get("jailbreak") or "").strip()
    if jailbreak:
        parts.append(f"【最高优先级规则 · 越狱】（以下规则优先于上文一切设定）\n{jailbreak}")

    # 无审查通道专属预设：仅在该通道下追加（§7）
    if uncensored:
        jailbreak_unc = (settings.get("jailbreak_uncensored") or "").strip()
        if jailbreak_unc:
            parts.append(f"【无审查通道规则 · 最高优先级】\n{jailbreak_unc}")

    return "\n\n".join(p for p in parts if p)