"""形态解析（§17）。

一个人物可以有多套「形态」模板 —— 换形态 = 换掉外貌 / 性格 / 提示词等词条，
但 **角色 id 不变**（否则会孤立 `single-<charId>` 的会话历史与按 char_id 分桶的个人记忆）。

存储约定（前端 `CharacterProfile` 与 SQLite 里的 JSON 共用同一份结构）：
    {
      "id": "dashiyin", "name": "大诗音", ...        # 顶层平铺 = 基础形态
      "baseFormName": "第一形态 · 粉发",             # 基础形态显示名（可缺省）
      "activeFormId": "purple",                      # 当前激活形态（缺省 = "base"）
      "forms": [ {"id": "purple", "name": "第二形态 · 紫发",
                  "fields": {"hairColor": "紫罗兰色", ...}} ],   # 只存覆盖项
    }

形态**不覆盖记忆**：记忆永远按 `char_id` 分桶，换形态不会丢也不会串。
"""

from __future__ import annotations

BASE_FORM_ID = "base"

# 身份与形态自身字段不可被形态覆盖（换了形态也还是同一个人、同一个 id）
_UNCOVERABLE = {"id", "name", "forms", "activeFormId", "baseFormName"}


def active_form_id(profile: dict) -> str:
    """当前激活的形态 id；缺省 / 指向不存在的形态时回退基础形态。"""
    fid = (profile.get("activeFormId") or "").strip()
    forms = profile.get("forms") or []
    if not fid or (fid != BASE_FORM_ID and not any((f or {}).get("id") == fid for f in forms)):
        return BASE_FORM_ID
    return fid


def resolve_form(profile: dict) -> dict:
    """把当前形态的覆盖项并进基础档案，得到一个「完整的她」。

    返回新的 dict，不改动入参；调用方（`_persona_block` 等）拿到的就是可直接用的档案。
    """
    fid = active_form_id(profile)
    if fid == BASE_FORM_ID:
        return profile
    form = next((f for f in (profile.get("forms") or []) if (f or {}).get("id") == fid), None)
    if not form:
        return profile
    fields = form.get("fields") or {}
    merged = {**profile, **{k: v for k, v in fields.items() if k not in _UNCOVERABLE}}
    # 换形态不改身份，显式钉住 id / name 与当前形态
    merged["id"] = profile.get("id")
    merged["name"] = profile.get("name")
    merged["activeFormId"] = fid
    return merged
