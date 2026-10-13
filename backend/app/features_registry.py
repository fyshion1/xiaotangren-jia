"""小窝功能注册表（§9.6 通用外设接入层）。

**这是「小窝里有哪些功能」的唯一真相源** —— 前端的功能列表、每个功能的 API 配置项、
记忆命名空间都以这里为准，不在数据库里再存一份（功能是代码级资产，不是用户数据）。

设计原则（见《规划探讨.md》§0 第一原则）：
- 本项目是**大脑**：只提供人格 / 记忆 / 模型调用 / 通用队列，不实现任何具体功能的状态机。
- 每个功能是**独立项目**（各自单独 git），通过 HTTP 反向调用大脑的通用接口。
- 功能的实现代码不放在本体仓库里，计划放在 `features/<id>/`（主仓库 gitignore 掉）。

一个功能条目要回答的问题：
- `id`：功能命名空间，同时是记忆隔离键（落进 `memories.game_id` 列，列名历史原因叫 game_id）。
- `needs_vision`：这个功能用不用视觉模型（看图/看视频抽帧）。全局默认带 vision，
  单个功能若不用，可以在这里标 False，前端也会给一个「屏蔽视觉」按钮允许用户手动关。
- `folder`：对应的独立项目目录（`features/<folder>`）；为空表示还没建仓。
"""

from __future__ import annotations

from typing import Literal, TypedDict


class Feature(TypedDict):
    id: str
    name: str
    emoji: str
    kind: Literal["game", "media", "im", "home", "other"]
    status: Literal["available", "planned"]
    desc: str
    needs_vision: bool
    folder: str


# ---- 功能清单 ----
# 顺序 = 前端展示顺序。加新功能就往这里加一条，并在 features/<folder>/ 建独立仓库。
FEATURES: list[Feature] = [
    {
        "id": "dont_starve_together",
        "name": "饥荒联机版",
        "emoji": "🎮",
        "kind": "game",
        "status": "planned",
        "desc": "让小糖人陪你一起玩饥荒：她给建议、吐槽、记住你们建过的基地。游戏本体在独立项目实现。",
        "needs_vision": False,
        "folder": "dont-starve-together",
    },
    {
        "id": "bilibili_scout",
        "name": "小糖人逛 B站",
        "emoji": "📺",
        "kind": "media",
        "status": "planned",
        "desc": "让小糖人去 B站到处看视频，挑出值得大老大看的，攒成推荐。先做「自己刷」，「一起看」留位。",
        "needs_vision": True,
        "folder": "bilibili-scout",
    },
    {
        "id": "qq_bridge",
        "name": "QQ 桥",
        "emoji": "💬",
        "kind": "im",
        "status": "planned",
        "desc": "小糖人无聊时来骚扰你：QQ 消息接入，回复发回 QQ。看图看视频都走大脑的多模态。",
        "needs_vision": True,
        "folder": "qq-bridge",
    },
    {
        "id": "interactive_home",
        "name": "互动小家",
        "emoji": "🏡",
        "kind": "home",
        "status": "available",
        "desc": "把「家」渲染成能走动的三维场景（Unity）。启动入口已接，场景内容在独立工程里做。",
        "needs_vision": False,
        "folder": "",
    },
    {
        "id": "gemini_sync",
        "name": "Gemini 网页同步",
        "emoji": "🔗",
        "kind": "other",
        "status": "available",
        "desc": "采集本机浏览器已打开的 Gemini 会话文字，推进 test 群聊。浏览器扩展在 extensions/ 里。",
        "needs_vision": False,
        "folder": "",
    },
]

_BY_ID = {f["id"]: f for f in FEATURES}


def all_features() -> list[Feature]:
    return list(FEATURES)


def get_feature(feature_id: str) -> Feature | None:
    return _BY_ID.get((feature_id or "").strip())


def known_ids() -> set[str]:
    return set(_BY_ID)


def default_needs_vision(feature_id: str) -> bool:
    """功能在注册表里是否声明需要视觉。未知功能不敢替用户决定，默认关。"""
    f = get_feature(feature_id)
    return bool(f["needs_vision"]) if f else False