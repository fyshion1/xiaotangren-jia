"""酒馆（SillyTavern）角色卡导入：读卡 → 本家档案草稿。

支持的两种载体：
1. **PNG 卡**：正文（v1 平铺 或 v2/v3 的 `data`）以 base64 塞在 PNG 的文本块里 ——
   SillyTavern 写 `tEXt/chara`（v2），新版另写 `ccv3`（v3，优先）。三种文本块都认
   （tEXt / zTXt / iTXt），因为不同导出工具各用各的。
2. **纯 JSON 卡**：v1 平铺 或 v2/v3 带 `data` 的对象。

抽取出的词条分两层：
- `about`（喂给模型的核心提示词）＝ **原文照搬**，只按「描述 / 性格 / 场景 / 对话示例」
  分段加中文小标题，不改一个字 —— 卡是别人写的，尊重原作。
- 结构化词条（生日 / 身高 / 三围 / 喜好…）＝ 由模型从原文里**抽取**，不是改写。
  原文没写的字段一律留空，宁可少填也不编（见 `EXTRACT_FIELDS` 与 `_SYSTEM`）。

**原文永远留着，只多两层「另算的」**：
- `about` 是原话（喂给模型的就是它，一字不动）；`aboutZh` 是给界面看的中文译文，
  纯显示用，随时能切回原文看。
- `greeting` 存卡里的 `first_mes`（去标签后的纯文本，供「插入开场白」用）。
  **绝不自动发言**：导入框默认不勾，勾了才写进私聊的第一条。原始带 HTML 的那份
  始终躺在卡文件里，这里存的只是能直接塞进气泡的版本。

**快慢是分开的**：读卡 + 拼 about 是纯本地活儿（毫秒级），慢的只有「叫模型抽词条 /
翻译文」那两次网络调用 —— 所以这两件都做成**独立的第二步请求**（见 routers/imports.py），
预览先出画面，词条后填。
"""

from __future__ import annotations

import base64
import binascii
import json
import re
import struct
import zlib

# 单段原文的长度上限（约为 token 预算兜底）：超了截断并在 warnings 里说清楚。
SECTION_LIMIT = 4000

# 只抽这些词条。键名与前端 CharacterProfile 一致（camelCase），中文标签用于给模型看。
EXTRACT_FIELDS: list[tuple[str, str]] = [
    ("jp", "日文假名 / 外文名（原文的罗马音或假名，没有就空）"),
    ("alias", "别名 / 称号（如「传说中的女仆 Minalinsky」）"),
    ("birthday", "生日"),
    ("age", "年龄"),
    ("height", "身高"),
    ("bloodType", "血型"),
    ("constellation", "星座"),
    ("occupation", "职业 / 身份（学生、偶像、设计师…）"),
    ("personality", "性格（短标签列表）"),
    ("likes", "喜好（短标签列表：喜欢的食物、爱好…）"),
    ("dislikes", "讨厌（短标签列表）"),
    ("catchphrase", "口头禅（原文明确给出一句台词才填）"),
    ("bodyType", "体型"),
    ("eyeColor", "瞳色"),
    ("hairstyle", "发型"),
    ("hairColor", "发色"),
    ("bust", "胸部 / 罩杯"),
    ("hip", "臀部"),
    ("clothing", "服装"),
    ("relationships", "关系（家人、朋友、队友的人名）"),
    ("specialFeatures", "特殊特征"),
    ("weight", "体重"),
    ("measurements", "三围（原文写了 B/W/H 才填）"),
    ("secret", "秘密"),
    ("weakPoint", "弱点"),
    ("privateWish", "私密小愿望"),
]

_LIST_KEYS = {"personality", "likes", "dislikes"}

# 开场白超出这个长度就截断（存档仍留全文）。
GREETING_LIMIT = 4000

_SYSTEM = (
    "你在把一张「酒馆角色卡」的原文，抽取成一份中文角色档案的词条。\n"
    "规则：\n"
    "1) 只提取原文里**明确写到**的信息，一个字都不许编。原文没写的字段，"
    '字符串一律留空 ""，列表一律留空 []。\n'
    "2) 人名 / 地名 / 作品名保留原文写法，其余用中文填写。\n"
    '3) 原文是英文也要抽出来（例如 "Her birthday is September 12th" → '
    '生日 "9 月 12 日"；"She stands at 159cm" → 身高 "159cm"）。\n'
    "4) personality / likes / dislikes 是**短标签**列表，每个不超过 8 个字，不要抄整句。\n"
    "5) 私密类字段（secret / weakPoint / privateWish / weight / measurements）"
    "原文没有写就留空，**不要推测**。\n"
    "严格只输出一个 JSON 对象，不要解释、不要代码围栏。\n"
    "需要输出的键（一个都不能少，没有内容的留空）：\n"
    + "\n".join(f'- "{key}"：{label}' for key, label in EXTRACT_FIELDS)
)

# 译文提示词：只给界面看。about 原文一个字不动，这里另算一份中文摆着看。
_TRANSLATE_SYSTEM = (
    "你在把一张「酒馆角色卡」的「关于」原文翻成中文，仅供界面显示。\n"
    "规则：\n"
    "1) 逐段对译：原文一句不减、一句不加，不总结、不润色、不补设定、不删「重复」段落。\n"
    "2) 人名 / 地名 / 作品名 / 招式名保留原文写法，可在后面用括号补中文。\n"
    "3) 原文自带的小标题（形如【角色设定】的整行）原样保留，只翻标题里的词。\n"
    "4) 原文本来就是中文的段落，原样返回那一段。\n"
    "5) 只输出译文本身 —— 不要前言、解释、代码围栏，也不要输出原文。"
)


def _png_text_chunks(raw: bytes) -> dict[str, str]:
    """PNG 的文本块 → {keyword: text}。三种块都认，坏块跳过。"""
    if not raw.startswith(b"\x89PNG\r\n\x1a\n"):
        return {}
    out: dict[str, str] = {}
    i, size = 8, len(raw)
    while i + 8 <= size:
        (length,) = struct.unpack(">I", raw[i : i + 4])
        ctype = raw[i + 4 : i + 8]
        data = raw[i + 8 : i + 8 + length]
        i += 12 + length  # 4 长度 + 4 类型 + data + 4 CRC
        if ctype == b"IEND":
            break
        if ctype == b"tEXt":
            kw, _, text = data.partition(b"\x00")
            out.setdefault(kw.decode("latin-1", "replace"), text.decode("latin-1", "replace"))
        elif ctype == b"zTXt":
            kw, _, rest = data.partition(b"\x00")
            if len(rest) < 1:
                continue
            try:
                text = zlib.decompress(rest[1:])  # rest[0] = 压缩方法（恒为 0）
            except zlib.error:
                continue
            out.setdefault(kw.decode("latin-1", "replace"), text.decode("utf-8", "replace"))
        elif ctype == b"iTXt":
            # iTXt 的字段是「关键字 \0 压缩标志 压缩方法 语言标签 \0 译名 \0 正文」——
            # 标志与方法各占一个**字节**、不带分隔符，所以不能按 \0 一路切下去：
            # 压缩时标志位是 0x01，分隔符少一个，切出来的段数就对不上了。
            kw, _, rest = data.partition(b"\x00")
            if len(rest) < 2:
                continue
            compressed = rest[:1] == b"\x01"
            body = rest[2:]  # 跳过压缩方法字节（恒为 0）
            _, _, body = body.partition(b"\x00")  # 语言标签
            _, _, text = body.partition(b"\x00")  # 译名之后就是正文
            if compressed:
                try:
                    text = zlib.decompress(text)
                except zlib.error:
                    continue
            if not text:
                continue
            out.setdefault(kw.decode("latin-1", "replace"), text.decode("utf-8", "replace"))
    return out


def _decode_embedded(text: str) -> dict | None:
    """PNG 文本块里的值 → dict。多数导出是 base64，少数直接塞 JSON。"""
    blob = (text or "").strip()
    if not blob:
        return None
    try:
        raw = base64.b64decode(blob, validate=False)
        obj = json.loads(raw.decode("utf-8"))
    except (binascii.Error, ValueError, UnicodeDecodeError):
        try:
            obj = json.loads(blob)
        except ValueError:
            return None
    return obj if isinstance(obj, dict) else None


def read_card(raw: bytes, filename: str = "") -> dict:
    """读一张卡 → 归一化后的 dict。认不出就抛 ValueError（由路由转 400）。"""
    name = (filename or "").lower()
    is_png = raw[:8] == b"\x89PNG\r\n\x1a\n"
    if is_png or name.endswith(".png"):
        chunks = _png_text_chunks(raw)
        for key in ("ccv3", "chara"):  # v3 优先：新版卡两个块都写，ccv3 更新
            card = _decode_embedded(chunks.get(key, ""))
            if card:
                return _normalize(card, source="png")
        raise ValueError("这张 PNG 里没有角色卡数据（不是酒馆导出的卡，或者卡没嵌进图里）")

    try:
        obj = json.loads(raw.decode("utf-8-sig"))
    except (ValueError, UnicodeDecodeError) as exc:
        raise ValueError(f"读不出这张卡：既不是酒馆 PNG 卡，也不是合法的 JSON（{exc}）") from exc
    if not isinstance(obj, dict):
        raise ValueError("这张 JSON 不是角色卡（顶层得是一个对象）")
    return _normalize(obj, source="json")


def _normalize(card: dict, source: str) -> dict:
    """v1 平铺 / v2、v3 带 `data` → 一份统一的卡。"""
    data = card.get("data") if isinstance(card.get("data"), dict) else None
    body = data or card
    spec = str(card.get("spec") or card.get("spec_version") or "").strip()

    def text(key: str) -> str:
        value = body.get(key)
        return value.strip() if isinstance(value, str) else ""

    tags = body.get("tags")
    return {
        "name": text("name"),
        "description": text("description"),
        "personality": text("personality"),
        "scenario": text("scenario"),
        "first_mes": text("first_mes"),
        "mes_example": text("mes_example"),
        "creator": text("creator"),
        "creator_notes": text("creator_notes"),
        "spec": spec or ("chara_card_v2" if data else "chara_card_v1"),
        "tags": [t for t in (tags if isinstance(tags, list) else []) if isinstance(t, str)],
        "source": source,
    }


def _section(title: str, text: str, warnings: list[str]) -> str:
    """一段原文 → 「小标题 + 原文」。超长截断并如实记一条提醒（不改写内容）。"""
    body = (text or "").strip()
    if not body:
        return ""
    if len(body) > SECTION_LIMIT:
        warnings.append(
            f"「{title}」原文有 {len(body)} 字，超过 {SECTION_LIMIT} 字上限，已截断 —— "
            "完整原文请回原卡文件里看，或手动补进这里的「关于」。"
        )
        body = body[:SECTION_LIMIT].rstrip() + "…"
    return f"【{title}】\n{body}"


def build_about(card: dict) -> tuple[str, list[str]]:
    """拼「关于」（喂给模型的核心提示词）。

    原文**一字不改**，只是分段加中文小标题，让模型看得出哪段是外貌、哪段是性格。
    first_mes（开场白）**不进提示词**：多是一整段带 HTML 的模板 / 广告，
    而且它的位置本来就在聊天记录里，不是人设。
    """
    warnings: list[str] = []
    parts = [
        _section("角色设定", card.get("description", ""), warnings),
        _section("性格", card.get("personality", ""), warnings),
        _section("场景", card.get("scenario", ""), warnings),
        _section("对话示例", card.get("mes_example", ""), warnings),
    ]
    return "\n\n".join(p for p in parts if p), warnings


def plain_text(raw: str) -> str:
    """存档里的开场白（带 HTML）→ 能塞进聊天气泡的纯文本。

    只做**渲染**需要的动作：标签去掉、常见实体还原、行首行尾收拾干净。
    卡里那份原文一个字没动，还在 `greeting` 里躺着。
    """
    text = raw or ""
    text = re.sub(r"<(script|style)\b[^>]*>.*?</\1>", "", text, flags=re.I | re.S)
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.I)
    text = re.sub(r"</(p|div|li|h[1-6])\s*>", "\n", text, flags=re.I)
    text = re.sub(r"<[^>]+>", "", text)
    for entity, char in (("&nbsp;", " "), ("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", '"'), ("&#39;", "'")):
        text = text.replace(entity, char)
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def greeting_for(card: dict) -> str:
    """卡里的 `first_mes` → 纯文本开场白。没有就返回空串。

    抽出来的这份**不自动说话**：导入框里默认不勾，勾了才写进私聊的第一条。
    """
    return plain_text(card.get("first_mes", ""))[:GREETING_LIMIT]


def blank_profile() -> dict:
    """一份空档案（键与前端 CharacterProfile 完全一致）—— 抽取结果往它身上填。"""
    profile = {
        "name": "",
        "jp": "",
        "alias": "",
        "emoji": "🎴",
        "portrait": "",
        "avatar": "",
        "about": "",
        # 界面看的译文（另算的，不喂模型）。原文照旧在上面。
        "aboutZh": "",
        "birthday": "",
        "age": "",
        "height": "",
        "bloodType": "",
        "constellation": "",
        "personality": [],
        "likes": [],
        "dislikes": [],
        "catchphrase": "",
        "bodyType": "",
        "eyeColor": "",
        "hairstyle": "",
        "hairColor": "",
        "bust": "",
        "hip": "",
        "clothing": "",
        "occupation": "",
        "relationships": "",
        "specialFeatures": "",
        "weight": "",
        "measurements": "",
        "secret": "",
        "weakPoint": "",
        "privateWish": "",
        # 卡里的开场白（去标签后的纯文本）。默认不勾选，不自动发言 ——
        # 角色介绍页给一个「插入开场白」按钮，用户点了才写进私聊。
        "greeting": "",
        # 导入标记（前端 buildSessions 用）：默认**不进**「小糖人的家」群聊 ——
        # 别的作品来的角色，先单独聊；想拉进群，去群聊成员面板手动勾。
        "imported": True,
    }
    return profile


def _strip_fences(raw: str) -> str:
    text = (raw or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    if text.startswith("{") and text.endswith("}"):
        return text
    start, end = text.find("{"), text.rfind("}")
    return text[start : end + 1] if 0 <= start < end else ""


def parse_fields(raw: str) -> dict:
    """模型输出 → 词条 dict。解析失败返回空 dict（不猜）。"""
    cleaned = _strip_fences(raw)
    if not cleaned:
        return {}
    try:
        obj = json.loads(cleaned)
    except ValueError:
        return {}
    if not isinstance(obj, dict):
        return {}
    out: dict = {}
    for key, _label in EXTRACT_FIELDS:
        value = obj.get(key)
        if key in _LIST_KEYS:
            if isinstance(value, list):
                items = [str(v).strip() for v in value if str(v).strip()]
            elif isinstance(value, str) and value.strip():
                items = [s.strip() for s in re.split(r"[,，、/／]", value) if s.strip()]
            else:
                items = []
            if items:
                out[key] = items[:8]
        elif isinstance(value, str):
            text = value.strip().strip("。") if value.strip() else ""
            # 模型爱用「无 / 未知 / N/A」表示「原文没写」—— 这些一律当空。
            if text and not re.fullmatch(r"(无|没有|未知|不明确|未提及|none|n/?a|null|-|—)+", text, re.I):
                out[key] = text
    return out


def card_text_for_extract(card: dict) -> str:
    """喂给抽取模型的原文（描述 + 性格 + 场景，各段封顶）。开场白与对话示例不给 ——
    前者是模板 / 广告，后者太长，都可能把抽取带偏。"""
    parts = [card.get("description", ""), card.get("personality", ""), card.get("scenario", "")]
    return "\n\n".join(p.strip() for p in parts if p and p.strip())[: SECTION_LIMIT * 2]


def extract_system_prompt() -> str:
    return _SYSTEM


def translate_system_prompt() -> str:
    return _TRANSLATE_SYSTEM


def clean_translation(raw: str) -> str:
    """译文 → 干净的正文。模型偶尔套代码围栏或加「译文：」前缀，这里剥掉。

    优先取代码围栏**内部**的内容：模型常把译文包在 ``` 里、外面还带两句客套话
    （"好的：\n```\n…\n```\n希望有帮助"）—— 只剥围栏会把那两句客套话也留下。
    """
    text = (raw or "").strip()
    fenced = re.search(r"```[a-zA-Z]*\s*\n(.*?)```", text, re.DOTALL)
    if fenced:
        text = fenced.group(1).strip()
    text = re.sub(r"^```[a-zA-Z]*\s*\n?", "", text).rstrip("`").strip()
    text = re.sub(r"^(译文|翻译|中文译文)\s*[：:]\s*", "", text)
    return text.strip()