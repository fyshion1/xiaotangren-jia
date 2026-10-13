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

from typing import Literal, NotRequired, TypedDict


class RunnerCommand(TypedDict):
    """功能自己提供的子命令（`python -m <module> <name>`）—— 前端按它渲染按钮。"""
    name: str
    label: str
    desc: str
    params: list[str]  # 支持哪些附加参数：limit / characters / memory
    # 有 background = 这个子命令是**常驻循环**（跑起来就不返回）：后端立刻回 pid、日志边跑边刷，
    # 前端显示「停掉」。没有的（如试跑 / 自检）都是跑完就返回，等结果。
    background: NotRequired[bool]


class Runner(TypedDict):
    """怎么把「本体外那个独立项目」跑起来。

    本体**不实现功能逻辑**，只是替大老大按一下启动键：在 `features/<folder>/` 下
    用当前 Python 起 `python -m <module> <子命令>`，把输出收进日志给前端看。
    module / 子命令都来自这份注册表，**不接受前端传来的任意命令**（见 routers/nest.py）。
    """
    folder: str
    module: str
    commands: list[RunnerCommand]


class Feature(TypedDict):
    id: str
    name: str
    emoji: str
    kind: Literal["game", "media", "im", "home", "other"]
    status: Literal["available", "planned"]
    desc: str
    needs_vision: bool
    folder: str
    # 有 runner = 这个功能可以在小窝里直接启动（本体只开进程，逻辑在独立项目里）。
    runner: Runner | None


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
        "runner": None,
    },
    {
        "id": "bilibili_scout",
        "name": "小糖人逛 B站",
        "emoji": "📺",
        "kind": "media",
        "status": "available",
        "desc": "让小糖人去 B站到处看视频，挑出值得大老大看的，攒成推荐。先做「自己刷」，「一起看」留位。",
        "needs_vision": False,  # 只读标题/简介/弹幕，不看图 —— 视觉路留给以后的「一起看」
        "folder": "bilibili-scout",
        # 采集端是独立项目（features/bilibili-scout），本体只负责把它跑起来。
        "runner": {
            "folder": "bilibili-scout",
            "module": "scout",
            "commands": [
                {"name": "dry", "label": "试跑（不花钱）", "desc": "只抓取 + 打分，不调模型、不推小窝 —— 先看挑得准不准", "params": ["limit"]},
                {"name": "run", "label": "逛一轮", "desc": "真的逛一轮：挑出值得看的，请小糖人写一句推荐语，推回小窝", "params": ["limit", "characters", "memory"]},
                {"name": "watch", "label": "一直逛（循环）", "desc": "每 N 分钟一轮，关掉窗口才停；日志在下面滚动", "params": ["interval", "limit", "characters"], "background": True},
            ],
        },
    },
    {
        "id": "qq_bridge",
        "name": "QQ 桥",
        "emoji": "💬",
        "kind": "im",
        "status": "available",
        "desc": "小糖人住进 QQ：私聊 / 群聊都能聊，图、表情包、视频、语音都收得进也发得出，聊的会同步进小窝。",
        "needs_vision": True,
        "folder": "qq-bridge",
        # 桥是常驻进程（run 循环），本体只负责按一下启动键。白名单为空时它会明确说「谁都不理」。
        "runner": {
            "folder": "qq-bridge",
            "module": "qqbridge",
            "commands": [
                {"name": "check", "label": "自检（不连 QQ）", "desc": "查大脑通不通、白名单空不空、模型配没配 —— 出问题先跑这个", "params": []},
                {"name": "run", "label": "接上 QQ（常驻）", "desc": "连 OneBot 网关，收消息、回消息、同步进小窝；关掉窗口才停", "params": ["characters"], "background": True},
                {"name": "whoami", "label": "这个号演谁", "desc": "看看本号对应哪位小糖人 + 家里有哪些人可选", "params": []},
            ],
        },
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
        "runner": None,
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
        "runner": None,
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


def runner_of(feature_id: str) -> Runner | None:
    """这个功能的启动方式（没有 = 前端不给启动按钮）。"""
    f = get_feature(feature_id)
    return f.get("runner") if f else None