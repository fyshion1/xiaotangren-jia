"""小窝功能注册表（§9.6 通用外设接入层）。

**这是「小窝里有哪些功能」的唯一真相源** —— 前端的功能列表、每个功能的 API 配置项、
记忆命名空间都以这里为准，不在数据库里再存一份（功能是代码级资产，不是用户数据）。

设计原则（内核与插件的职责边界）：
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
from pathlib import Path
from . import theme_feature


def folder_has_payload(folder: Path, depth: int = 0) -> bool:
    """A README/empty checkout is not an installed plugin; readiness is checked separately."""
    ignored = {'node_modules','.git','.venv','venv','data','logs','docs','tests','__pycache__','dist','build'}
    try:
        for item in folder.iterdir():
            if item.is_symlink() or item.name in ignored:
                continue
            if item.is_file() and (item.name in {'plugin.json','package.json','pyproject.toml'}
                                   or item.suffix.lower() in {'.py','.js','.mjs','.cjs','.ts','.tsx'}):
                return True
            if depth < 2 and item.is_dir() and folder_has_payload(item,depth+1):
                return True
    except OSError:
        pass
    return False

# NotRequired 在 Python 3.11 才进 typing；本项目跑 3.10，从 typing_extensions 拿（已装）。
try:
    from typing import NotRequired  # noqa: F401 —— 3.11+ 直接用标准库
except ImportError:
    from typing_extensions import NotRequired
from typing import Any, Literal, TypedDict


class RunnerCommand(TypedDict):
    """功能自己提供的子命令（`python -m <module> <name>`）—— 前端按它渲染按钮。"""
    name: str
    label: str
    desc: str
    params: list[str]  # 支持哪些附加参数：limit / characters / memory / account
    # 有 background = 这个子命令是**常驻循环**（跑起来就不返回）：后端立刻回 pid、日志边跑边刷，
    # 前端显示「停掉」。没有的（如试跑 / 自检）都是跑完就返回，等结果。
    background: NotRequired[bool]


class SettingField(TypedDict):
    """功能自己声明的**可配置项**（§9.6.5）—— 前端按 type 渲染成表单，值存在本体。

    为什么由功能在注册表里声明、值却存在本体：功能是**独立项目**，你不该为了
    改个白名单去开终端编辑 `features/<folder>/config.json`（还会遇到中文乱码）。
    声明放注册表（代码级资产，跟着功能走），值放数据库（用户数据，改完立刻生效）。

    `type` 决定前端渲染什么：
    - `text` / `textarea` / `number` / `bool` / `list`（逗号分隔的字符串列表）
    - `select`：配 `options: [{"value","label"}]`
    - `accounts`：QQ 桥那种「多个账号各演一个人」的重复行编辑器（见 qq_bridge 的声明）
    - `character`：下拉选一位小糖人（选项来自角色介绍，前端现拉）
    """
    key: str
    label: str
    type: Literal["text", "textarea", "number", "bool", "list", "select",
                  "accounts", "character", "media_list"]
    desc: str
    default: Any
    group: str                      # 前端按这个分组显示（同一组的字段放一起）
    # 标了 secret 的字段前端用密码框显示（**只是不明文晃眼，不加密、不回显遮蔽** ——
    # 读回接口返回真实值，否则前端一保存就把没改的密钥冲掉了，和本体的 api_key 一个态度）。
    secret: NotRequired[bool]
    options: NotRequired[list[dict]]  # type=select 时用
    min: NotRequired[float]
    max: NotRequired[float]
    # 只给 `bool` 用：**前端显示的是这个值的反**（存的还是 `default` 那一套语义）。
    # 为什么要有它：有些开关的名字天生是反着写的（`memory.isolate` = 「单独记」），
    # 而你要看的是正面那句「和群聊 / 私聊共享记忆」。前端勾上 = 存进去 False。
    # 值本身（`values`）**始终是存储语义** —— 功能侧拉回去直接覆盖 config.json，
    # 不认得这个标记，也不该认得。
    # ⚠ 只在**顶层字段**上生效；`accounts` 行里的格子不认它（目前也没人用，别指望）。
    invert: NotRequired[bool]
    # type=accounts 时：一行里有哪些格子（同一种形状，少 `group`/`secret` 之外都能用）。
    fields: NotRequired[list[dict]]


class RunnerGateway(TypedDict):
    """功能**要先有个外部的服务**才连得上时，那个服务怎么开（现在只有 QQ 桥的 SnowLuma）。

    桥报「Cannot connect to host 127.0.0.1:3001」十有八九就是网关根本没开 —— 以前得自己去
    D:\\SnowLuma 双击 launcher.bat，再回来点启动。现在小窝替你按这一下。
    - `folder`：网关目录（可在功能设置 `gateway.folder` 里覆盖，见 routers/nest.py 的 `_gateway_spec`）。
    - `node`：node 可执行文件路径（相对 folder，默认用网关自带的 `node.exe`，不吃系统 node 版本）。
    - `script`：入口脚本（相对 folder）。不走 launcher.bat —— 它最后有个 pause，会一直挂着。
    - `port`：开好之后该有东西在听的端口（轮询它判断「真的起来了」）。
    """
    label: str
    folder: str
    node: str
    script: str
    port: int


class Runner(TypedDict):
    """怎么把「本体外那个独立项目」跑起来。

    本体**不实现功能逻辑**，只是替你按一下启动键：在 `features/<folder>/` 下
    用当前 Python 起 `python -m <module> <子命令>`，把输出收进日志给前端看。
    module / 子命令都来自这份注册表，**不接受前端传来的任意命令**（见 routers/nest.py）。
    """
    folder: str
    module: str
    host_plugin: NotRequired[bool]
    commands: list[RunnerCommand]
    # 有 gateway = 这个功能连的是外部服务，面板上给一个「开网关」按钮（见 routers/nest.py 的 gateway 接口）。
    gateway: NotRequired[RunnerGateway]


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
    # 有 settings = 这个功能有「前端可改的配置项」（§9.6.5）；前端按声明渲染表单，
    # 值存本体（`feature_settings` 表），功能自己拉回去用。没有 = 前端不给设置入口。
    settings: NotRequired[list[SettingField]]


# ---- 功能清单 ----
# 顺序 = 前端展示顺序。加新功能就往这里加一条，并在 features/<folder>/ 建独立仓库。
FEATURES: list[Feature] = [
    {"id": "personal_database", "name": "个人数据库", "emoji": "📚", "kind": "other",
     "status": "available", "desc": "可选的个人文件管理与资料收录；停用后停止资料目录巡检及个人数据库条目读取，聊天记忆仍由本体提供。",
     "needs_vision": False, "folder": "personal-database", "runner": None, "settings": []},
    {"id": "personal_profile", "name": "个人档案管理", "emoji": "📋", "kind": "other",
     "status": "available", "desc": "私人空间的 Markdown 额外档案；停用暂停读取和注入，资料及原有勾选保留，原生记忆不受影响。",
     "needs_vision": False, "folder": "personal-profile", "runner": None, "settings": []},
    {"id": "xiaotangren_theme", "name": "小糖人主题与设定", "emoji": "🎨", "kind": "other",
     "status": "available", "desc": "可选外观、角色图片、默认角色和交流风格；安装变更后需重启并重新构建前端。",
     "needs_vision": False, "folder": "xiaotangren-theme", "runner": None, "settings": []},
    {"id": "tavern", "name": "酒馆模式", "emoji": "🎴", "kind": "other",
     "status": "available", "desc": "可选角色卡导入、显示与世界书",
     "needs_vision": False, "folder": "tavern", "runner": None, "settings": []},
    {
        "id": "tools", "name": "工具插件", "emoji": "🧰", "kind": "other",
        "status": "available", "desc": "按插件授权工具能力。联网依赖需另外安装，不随本体提供。",
        "needs_vision": False, "folder": "tools",
    },
    {
        "id": "autonomous_activity", "name": "自主活动与沙盒", "emoji": "🚀", "kind": "other",
        "status": "available", "desc": "专家模式独立插件：自主探索、独立钱包、项目审批与隔离工作区。",
        "needs_vision": False, "folder": "autonomous-activity",
        "runner": {"folder": "autonomous-activity", "module": "app.plugin_worker", "host_plugin": True,
                   "commands": [{"name": "run", "label": "启动自主活动插件", "desc": "运行独立插件后台；活动仍遵守自己的开关与预算。", "params": [], "background": True}]},
    },
    {
        "id": "project_costs", "name": "项目费用", "emoji": "🧾", "kind": "other",
        "status": "available", "desc": "记录 API 充值、订阅和临时购买，导入微信/支付宝账单并确认对账。",
        "needs_vision": False, "folder": "project-costs",
        "runner": {"folder": "project-costs", "module": "costs", "commands": [
            {"name": "serve", "label": "启动费用服务", "desc": "本地账本与账单对账服务，不调用付费模型。", "params": [], "background": True},
        ]},
    },
    {
        "id": "desktop_pet", "name": "桌边的小糖人", "emoji": "🐾", "kind": "home",
        "status": "available", "desc": "摸摸她，在桌面直接聊天；与小窝共用群聊、私聊和记忆。",
        "needs_vision": False, "folder": "desktop-pet",
        "runner": {"folder": "desktop-pet", "module": "pet", "commands": [
            {"name": "run", "label": "来到桌面", "desc": "启动 Electron 桌宠", "params": [], "background": True},
            {"name": "doctor", "label": "检查准备情况", "desc": "检查 Electron、构建与本机素材", "params": []},
        ]},
        "settings": [
            {"key": "auto_speak", "label": "自动播放 TTS", "type": "bool", "group": "声音",
             "default": False, "desc": "主动开启后才自动朗读桌面新回复；气泡 ♪ 可单次朗读或停止。"},
            {"key": "voice_engine", "label": "语音引擎", "type": "select", "group": "声音",
             "default": "edge", "options": [{"value": "edge", "label": "Edge 在线"}, {"value": "piper", "label": "Piper 本地"}], "desc": "沿用小窝语音接口；本地音色需已安装。"},
            {"key": "voice", "label": "音色 ID", "type": "text", "group": "声音",
             "default": "zh-CN-XiaoxiaoNeural", "desc": "Edge 默认晓晓；Piper 可填 zh_CN-huayan-medium 等已安装音色。"},
            {"key": "voice_volume", "label": "朗读音量", "type": "number", "group": "声音",
             "default": 0.8, "min": 0, "max": 1, "desc": "0 为静音，1 为最大音量。"},
            {"key": "font_size", "label": "聊天字号", "type": "number", "group": "气泡",
             "default": 13, "min": 11, "max": 20, "desc": "桌面聊天正文字号。"},
            {"key": "bubble_opacity", "label": "气泡不透明度", "type": "number", "group": "气泡",
             "default": 0.98, "min": 0.65, "max": 1, "desc": "降低后可透出桌面，文字保持清晰。"},
            {"key": "bubble_width", "label": "聊天框宽度", "type": "number", "group": "气泡",
             "default": 488, "min": 340, "max": 760, "desc": "单位为逻辑像素；桌面也可拖动气泡右下角调整。"},
            {"key": "bubble_height", "label": "聊天框高度", "type": "number", "group": "气泡",
             "default": 360, "min": 260, "max": 620, "desc": "单位为逻辑像素，小屏幕自动缩小。"},
            {"key": "theme", "label": "气泡配色", "type": "select", "group": "气泡",
             "default": "lilac", "options": [{"value": "lilac", "label": "丁香紫"}, {"value": "rose", "label": "樱花粉"}, {"value": "mint", "label": "薄荷绿"}, {"value": "night", "label": "静夜"}, {"value": "paper", "label": "奶油纸笺"}], "desc": "桌面气泡底部也可直接切换。"},
            {"key": "character", "label": "陪在桌边的角色", "type": "character", "group": "陪伴",
             "default": theme_feature.default_character_id(), "desc": "使用小窝角色的人设与记忆；样例模型只作临时形象。"},
            {"key": "session", "label": "桌面消息发到哪里", "type": "select", "group": "陪伴",
             "default": "single", "options": [{"value": "single", "label": "她的私聊"}, {"value": "group", "label": "家庭群聊"}],
             "desc": "沿用当前用户身份与现有聊天记录。群聊沿用小窝成员名单。"},
            {"key": "model", "label": "桌宠模型（Live2D / 3D VRM）", "type": "select", "group": "外观",
             "default": "hiyori", "options": [{"value": "haru", "label": "Live2D · Haru"}, {"value": "hiyori", "label": "Live2D · Hiyori · 米黄色开衫"}, {"value": "teto", "label": "Live2D · Teto（D盘本地）"}, {"value": "furina", "label": "Live2D · 芙宁娜（D盘本地）"}, {"value": "alicia", "label": "3D VRM · Alicia Solid"}, {"value": "vrm1", "label": "3D VRM · 1.0 技术样例"}],
             "desc": "从本机 assets 加载公开样例，不复制或打包模型。"},
            {"key": "scale", "label": "人物大小", "type": "number", "group": "外观",
             "default": 1.0, "min": 0.15, "max": 3.0, "desc": "滚轮缩放范围15%–300%，允许人物超出屏幕；保存后桌面自动更新。"},
            {"key": "always_on_top", "label": "保持在其他窗口上方", "type": "bool", "group": "窗口",
             "default": True, "desc": "关闭后桌宠作为普通窗口显示。"},
            {"key": "dock_auto_hide", "label": "停靠后自动收起", "type": "bool", "group": "窗口",
             "default": False, "desc": "默认保持常驻。开启后离开约 3 秒收起，保留边缘标签；靠近展开。桌面底部可切换。"},
            {"key": "auto_memory", "label": "自动提炼记忆", "type": "bool", "group": "陪伴",
             "default": True, "desc": "沿用普通聊天规则：私聊写入个人记忆，群聊写入相应记忆桶。"},
            {"key": "poke_to_chat", "label": "触碰发送到小窝并调用大模型", "type": "bool", "group": "陪伴",
             "default": False, "desc": "默认双击人物只显示本地预设台词；开启后将触碰发到当前私聊/群聊并生成回应。拖动优先，不会自动重试。"},
        ],
    },
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
        "desc": "让小糖人去 B站到处看视频，挑出值得你看的，攒成推荐。先做「自己刷」，「一起看」留位。",
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
        # 能在前端改的口味与开关（§9.6.5）。改完**下一轮**就生效（循环里每轮读一次）。
        "settings": [
            {"key": "taste.character", "label": "默认谁去看", "type": "character", "group": "谁去看",
             "default": "", "desc": "没在小窝「选谁去看」里点名时用这位。留空 = 名册第一个人。"},
            {"key": "taste.min_score", "label": "多少分才推", "type": "number", "group": "挑片口味",
             "default": 6.0, "desc": "低于这个分数不进小窝动态。调高 = 更挑，调低 = 推得更多。", "min": 0, "max": 20},
            {"key": "taste.max_age_days", "label": "只挑多新的", "type": "number", "group": "挑片口味",
             "default": 30, "desc": "太旧的除非很热门，不然不推。", "min": 1, "max": 3650},
            {"key": "taste.per_source", "label": "每个源抓几个", "type": "number", "group": "挑片口味",
             "default": 12, "desc": "热门 / 排行榜 / 分区各抓多少个来打分。抓多了只是多花点时间。", "min": 3, "max": 50},
            {"key": "memory.enabled", "label": "把这轮经历记成记忆", "type": "bool", "group": "挑片口味",
             "default": False, "desc": "记成记忆（隔离在 bilibili_scout 里，不会漏进日常聊天）。也按轮花钱，默认关。"},

            # ---- 两个「留口子」的开关（§9.6.3）----
            {"key": "watch.enabled", "label": "「一起看」", "type": "bool", "group": "留口子的功能",
             "default": False, "desc": "**还没实现**：真正的做法是把视频抽成 ≤8 张帧走视觉路，"
                                      "实时逐帧 token 太贵，一直没做。这个开关只是把「要不要」记下来。"},
            {"key": "comment.enabled", "label": "去别人的视频下留言", "type": "bool", "group": "留口子的功能",
             "default": False, "desc": "**默认不发**（有话在小窝里说就行）。真发需要 B站登录 Cookie 和频控，"
                                     "还有风控 / 封号风险 —— 打开这个开关也不会真的发，只是把意愿记下来。"},
            {"key": "comment.at_owner", "label": "留言时 @ 上你", "type": "bool", "group": "留口子的功能",
             "default": True, "desc": "真开启发评论时，@ 一下主人（别人家的小糖人是这么干的）。"},
            {"key": "comment.max_per_day", "label": "每天最多几条", "type": "number", "group": "留口子的功能",
             "default": 3, "desc": "就算真开了也限流，别把评论区刷成广告位。", "min": 0, "max": 20},
        ],
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
            # 网关（SnowLuma）没开的时候，桥连 3001 必然是「拒绝连接」—— 面板上给个按钮直接开。
            "gateway": {
                "label": "SnowLuma 网关",
                "folder": r"D:\SnowLuma",
                "node": "node.exe",
                "script": "index.mjs",
                "port": 3001,
            },
        },
        # 这个功能的配置项**全部在前端改**（值存本体，桥每轮读一次）——
        # 你原话：「这块希望在前端可以自己配置，现在说比较复杂」。
        "settings": [
            # ---- 先定「哪个号演谁」（多账号）----
            {"key": "accounts", "label": "QQ 号 × 小糖人", "type": "accounts", "group": "谁在 QQ 上",
             "desc": "每个 QQ 号可演一位小糖人，或选择「群聊」按小窝当前群聊成员分饰多角。填几个就跑几个。"
                     "推荐使用正向 WS：先读取已登录 QQ，再点「自动配置连接并读取名单」，连接信息自动填好，群和好友下拉勾选。"
                     "留空整张表 = 用下面「这个号」那一组（单账号）。",
             "default": [],
             "fields": [
                 {"key": "name", "label": "备注名", "type": "text", "desc": "随便写，方便你自己认"},
                 {"key": "self_id", "label": "QQ 号", "type": "text", "desc": "机器人的 QQ 号"},
                 {"key": "persona", "label": "演谁", "type": "character", "desc": "群聊 = 小窝当前在场成员，使用群聊会话和记忆；留空 = 名册第一个人",
                  "options": [{"value": "group", "label": "🏠 群聊（按当前在场成员）"}]},
                 {"key": "ws_url", "label": "网关地址", "type": "text", "desc": "正向 WS 用，如 ws://127.0.0.1:3001/；留空 = 用顶层那个"},
                 {"key": "listen_port", "label": "监听端口", "type": "number", "desc": "反向 WS 用；留空 = 3010 起依次排"},
                 {"key": "access_token", "label": "access_token", "type": "text", "secret": True},
                 {"key": "groups", "label": "接哪些群", "type": "list", "desc": "群号，逗号分隔；留空 = 这个号的群一律不理"},
                 {"key": "private", "label": "接哪些人私聊", "type": "list", "desc": "QQ 号，逗号分隔；留空 = 私聊一律不理"},
                 {"key": "enabled", "label": "启用这个号", "type": "bool"},
             ]},

            # ---- 单账号（accounts 空的时候用这组）----
            {"key": "persona.character_id", "label": "这个号演谁", "type": "character", "group": "这个号",
             "options": [{"value": "group", "label": "🏠 群聊（按当前在场成员）"}],
             "default": "", "desc": "群聊 = 按小窝当前群聊成员分饰多角，QQ 私聊也进入群聊会话与记忆。留空 = 角色介绍里的第一个人。"},
            {"key": "onebot.self_id", "label": "机器人 QQ 号", "type": "text", "group": "这个号",
             "default": "", "desc": "留空也能用：连上网关后会自动问它（get_login_info）。"},

            # ---- 白名单（原来只能改 config.json 的那一块）----
            {"key": "allow.groups", "label": "接哪些群", "type": "list", "group": "白名单",
             "default": [], "desc": "群号，逗号分隔。留空 = 谁都不理（故意的：防刚装好就被拉进陌生群）。"},
            {"key": "allow.private", "label": "接哪些人私聊", "type": "list", "group": "白名单",
             "default": [], "desc": "QQ 号，逗号分隔。留空 = 私聊一律不理。"},
            {"key": "allow.require_mention_in_group", "label": "群里要 @ 才回", "type": "bool", "group": "白名单",
             "default": True, "desc": "关掉 = 群里每句话都插嘴（会很吵）。不 @ 的时候仍然同步进小窝，只是不开口。"},
            {"key": "allow.ignore_bots", "label": "不理别的机器人", "type": "bool", "group": "白名单",
             "default": True, "desc": "防两个机器人互相聊到天荒地老。"},
            {"key": "owner.qq", "label": "用户 QQ", "type": "text", "group": "白名单",
             "default": "", "desc": "管理员。私聊不受白名单限制，可发 /reset /silent 这类桥直接执行的管理命令。"},
            {"key": "owner.admin_commands", "label": "允许管理命令", "type": "bool", "group": "白名单",
             "default": True, "desc": "/reset /silent /active /whoami —— **桥直接执行，不过模型**。"},

            # ---- 网关接入 ----
            {"key": "onebot.mode", "label": "连接方式", "type": "select", "group": "接入方式",
             "default": "client", "desc": "**正向 WS（推荐，正在用的）**：桥主动连网关 —— 网关不用配、不用重启。"
                                          "反向 WS：桥监听端口，网关配「反向 WS 地址」指过来。",
             "options": [{"value": "client", "label": "我连网关（正向，推荐）"},
                         {"value": "server", "label": "网关连我（反向）"}]},
            {"key": "onebot.ws_url", "label": "网关地址", "type": "text", "group": "接入方式",
             "default": "ws://127.0.0.1:3001/",
             "desc": "正向 WS 用。**SnowLuma 默认的 WS 服务端口就是 3001**，所以默认值直接能用。"
                     "多号时在「谁在 QQ 上」那张表里给每个号填自己的地址。"},
            {"key": "onebot.listen_port", "label": "监听端口", "type": "number", "group": "接入方式",
             "default": 3010, "desc": "反向 WS 用。在网关里把「反向 WS 地址」配成 ws://127.0.0.1:<这个端口>/onebot/v11/ws。"
                                      "**故意用 3010**：3000/3001 是 SnowLuma（和 NapCat）默认占的，撞上就连不上。",
             "min": 1, "max": 65535},
            {"key": "onebot.listen_path", "label": "监听路径", "type": "text", "group": "接入方式",
             "default": "/onebot/v11/ws", "desc": "反回 WS 用，一般不用改，和网关里填的保持一致就行。"},
            {"key": "onebot.access_token", "label": "access_token", "type": "text", "secret": True, "group": "接入方式",
             "default": "", "desc": "网关设了才填，**两边要填一样的**。"
                                     "SnowLuma 的 token 在 WebUI「配置 → 网络」里能看到（默认会生成一个）。"
                                     "留空 = 不校验：任何能连到本机这个端口的东西都能指挥小糖人发消息。"},
            {"key": "gateway.folder", "label": "网关装在哪个目录", "type": "text", "group": "接入方式",
             "default": r"D:\SnowLuma",
             "desc": "「开网关」按钮去这儿起 SnowLuma（用它自带的 node.exe 跑 index.mjs）。"
                     "换过位置就填新的绝对路径。"},
            {"key": "gateway.webui_port", "label": "网关网页端口", "type": "number", "group": "接入方式",
             "default": 5099, "min": 1, "max": 65535,
             "desc": "SnowLuma 的 WebUI 端口。开网关时小窝用它来问「现在是哪个号挂上了」"
                     "并自动换到上面那个机器人号。没改过就别动。"},
            {"key": "gateway.password", "label": "网关网页密码", "type": "text", "secret": True, "group": "接入方式",
             "default": "",
             "desc": "SnowLuma WebUI 的登录密码（打开 http://127.0.0.1:5099 时输的那个）。"
                     "**填了才能自动换号**：同时登着两个 QQ 时，两个号的配置抢同一对端口 "
                     "3000/3001，谁先被挂上谁赢 —— 小窝会用这个密码把抢到端口的**别的号**摘下来，"
                     "让机器人号顶上去。不填就只提醒、手动换。只存在本机数据库，不进日志、不进 git。"},

            # ---- 语音 ----
            {"key": "voice.enabled", "label": "会发语音条", "type": "bool", "group": "声音",
             "default": True, "desc": "走大脑的 TTS（edge 晓晓 / piper），桥不自己装一套。"},
            {"key": "voice.engine", "label": "语音引擎", "type": "select", "group": "声音",
             "default": "edge", "options": [{"value": "edge", "label": "edge（晓晓）"},
                                            {"value": "piper", "label": "piper（华燕/小雅/超文）"}]},
            {"key": "voice.voice", "label": "音色", "type": "text", "group": "声音",
             "default": "zh-CN-XiaoxiaoNeural", "desc": "edge 只留晓晓；piper 可填 huayan / xiaoya / chaowen。"},
            {"key": "voice.auto", "label": "什么时候出声", "type": "select", "group": "声音",
             "default": "mirror", "options": [{"value": "off", "label": "只打字"},
                                              {"value": "mirror", "label": "对方发语音我才发"},
                                              {"value": "always", "label": "总是发语音"}]},
            {"key": "voice.max_chars", "label": "最长几个字", "type": "number", "group": "声音",
             "default": 80, "desc": "超过就改打字（太长了不像语音条）。", "min": 1, "max": 500},
            {"key": "voice.max_per_minute", "label": "每分钟最多几条", "type": "number", "group": "声音",
             "default": 3, "desc": "语音额度，防刷屏。", "min": 1, "max": 20},
            {"key": "asr.engine", "label": "听不懂的语音怎么办", "type": "select", "group": "声音",
             "default": "qq",
             "options": [{"value": "qq", "label": "用 QQ 自己的转写（推荐）"},
                         {"value": "local", "label": "本地识别（Paraformer，不走云端）"},
                         {"value": "openai", "label": "再用中转的 whisper 兜一层"},
                         {"value": "none", "label": "不识别，记成 [语音]"}],
             "desc": "本地识别复用桌宠的 Paraformer 模型，不上传音频。QQ 模式可配置兜底；云端识别可能计费。"},
            {"key": "asr.fallback", "label": "QQ 转写失败后", "type": "select", "group": "声音",
             "default": "local", "options": [{"value": "local", "label": "本地 Paraformer"},
             {"value": "none", "label": "不识别"}, {"value": "openai", "label": "已配置的云端 ASR"}]},
            {"key": "asr.base_url", "label": "识别用哪家中转", "type": "text", "group": "声音",
             "default": "", "desc": "留空 = 用大脑给这个功能配的那份。只在上面选了 whisper 时用。"},
            {"key": "asr.api_key", "label": "识别用的 key", "type": "text", "secret": True, "group": "声音",
             "default": "", "desc": "留空 = 用大脑那份，不另存。"},
            {"key": "asr.model", "label": "识别模型", "type": "text", "group": "声音",
             "default": "whisper-1", "desc": "如 whisper-1 / whisper-large-v3。"},

            # ---- 连续输入与多气泡 ----
            {"key": "proactive.enabled", "label": "偶尔主动来找你", "type": "bool", "group": "主动联系",
             "default": False, "desc": "可以闲聊、感叹、轻轻吐槽或去 B 站找发现；没人回复就不追发。所有活动共用累计 token 预算，开启后会后台调用模型。"},
            {"key": "proactive.account_index", "label": "主动联系使用的 QQ 账号", "type": "number", "group": "主动联系",
             "default": 0, "min": 0, "max": 20},
            {"key": "proactive.persona_id", "label": "绑定的用户身份 ID", "type": "text", "group": "主动联系",
             "default": "", "desc": "留空首次绑定当前身份。身份或 QQ 变更会停止发送；关闭主动联系、等待设置同步后再开启可重新绑定。"},
            {"key": "proactive.min_minutes", "label": "随机机会最短间隔（分钟）", "type": "number", "group": "主动联系",
             "default": 90, "min": 30, "max": 1440},
            {"key": "proactive.max_minutes", "label": "随机机会最长间隔（分钟）", "type": "number", "group": "主动联系",
             "default": 180, "min": 30, "max": 1440},
            {"key": "proactive.daily_limit", "label": "每天最多主动几轮", "type": "number", "group": "主动联系",
             "default": 3, "min": 0, "max": 10, "desc": "所有在场角色共用。发送超时也占额度，避免反复打扰。"},
            {"key": "proactive.start_hour", "label": "北京时间几点后可以来", "type": "number", "group": "主动联系",
             "default": 10, "min": 0, "max": 23},
            {"key": "proactive.end_hour", "label": "北京时间几点后不打扰", "type": "number", "group": "主动联系",
             "default": 23, "min": 0, "max": 23},
            {"key": "proactive.bilibili", "label": "允许找 B 站链接分享", "type": "bool", "group": "主动联系",
             "default": True, "desc": "只读公开标题和简介，复用逛 B 站的口味与排除项。每天最多分享一次官方链接，不下载或发送视频。"},
            {"key": "proactive.run_tokens", "label": "每次活动 token 总预算", "type": "number", "group": "自主活动",
             "default": 12000, "min": 0, "max": 50000, "desc": "累计输入＋输出；顾问请教也算。0 = 不调用。缺失用量或预留不足会停下。"},
            {"key": "proactive.day_tokens", "label": "每天 token 总预算", "type": "number", "group": "自主活动",
             "default": 24000, "min": 0, "max": 200000, "desc": "所有角色共用，北京时间每天重置；重启不重置用量。"},
            {"key": "proactive.group_id", "label": "允许主动 @ 你的群号", "type": "text", "group": "自主活动",
             "default": "", "desc": "留空关闭。还必须在群白名单内，并能确认你是群成员；公共分享不读取私聊与私密记忆。"},
            {"key": "proactive.qzone", "label": "允许发 QQ 空间感想", "type": "bool", "group": "自主活动",
             "default": False, "desc": "需要 SnowLuma 支持；每周最多 2 条，只发文字与链接。所有渠道共用每日主动轮数，不跨渠道重复发。"},
            {"key": "proactive.qzone_right", "label": "空间感想给谁看", "type": "select", "group": "自主活动",
             "default": "64", "options": [{"value": "64", "label": "仅自己可见（先试用）"},
                                            {"value": "16", "label": "仅你可见"},
                                            {"value": "4", "label": "好友可见"}],
             "desc": "每次发送显式设置，绝不沿用网关默认的所有人可见；失败不降低可见限制。"},
            {"key": "reply.debounce_seconds", "label": "等我把话说完（秒）", "type": "number", "group": "聊天节奏",
             "default": 2, "min": 0, "max": 10, "desc": "短暂停顿后再一起理解连续发送的文字与表情；0 = 不等待。"},
            {"key": "reply.max_wait_seconds", "label": "一轮最长收集（秒）", "type": "number", "group": "聊天节奏",
             "default": 10, "min": 1, "max": 30, "desc": "持续续发也不会一直等下去。"},
            {"key": "reply.max_bubbles", "label": "一轮最多几个气泡", "type": "number", "group": "聊天节奏",
             "default": 4, "min": 1, "max": 8, "desc": "文字和表情合计；当前先生成整轮，再按语义分段发送。"},
            {"key": "reply.interval_seconds", "label": "气泡间隔（秒）", "type": "number", "group": "聊天节奏",
             "default": 1.2, "min": 0, "max": 5},

            # ---- 表情包 ----
            {"key": "sticker.enabled", "label": "会发表情包", "type": "bool", "group": "表情包",
             "default": True, "desc": "调整发送表情包的概率；设为 0 可关闭。"},
            {"key": "sticker.reply_chance", "label": "每轮回话时来的概率", "type": "number", "group": "表情包",
             "default": 0, "desc": "0 = 只在用户要表情时提供候选；0.1 = 约十分之一的普通回复可选表情，最终仍由语义决定是否发送。", "min": 0, "max": 1},
            {"key": "sticker.auto_collect", "label": "学到别人的表情包", "type": "bool", "group": "表情包",
             "default": True, "desc": "将收到的表情原图保存到本体附件库；情绪识别由下一个开关控制。"},
            {"key": "sticker.auto_describe", "label": "识别新表情的情绪和动作", "type": "bool", "group": "表情包",
             "default": True, "desc": "将少量关键帧交给配置的视觉模型，每张新原图标注一次。后续选图不另调模型、不用向量检索；可手动修订。失败不会反复自动重试。"},
            {"key": "sticker.treat_small_image_as_sticker", "label": "小图也当表情包收", "type": "bool",
             "group": "表情包", "default": False, "desc": "有些网关把表情包当普通图发，打开这个能兜住。"},
            {"key": "sticker.library", "label": "表情包库", "type": "media_list", "group": "表情包",
             "default": [], "desc": "存的是本体附件库里的引用（删消息 / 清理时一起管），桥不另存一份。"},
            {"key": "sticker.library_session", "label": "表情包存在哪个会话目录", "type": "text", "group": "表情包",
             "default": "single-dalaoda", "desc": "上传表情包时落到哪个附件目录（一般不用改）。"},

            # ---- 小工具（你说「可以碰，只要别搞坏东西」）----
            # ---- 同步与记忆 ----
            {"key": "sync.to_qq", "label": "网页消息同步到 QQ", "type": "bool", "default": True, "group": "同步",
             "desc": "网页用户消息、角色回复与附件发往本账号最近使用的对应 QQ 会话；首次关联不补发历史。"},
            {"key": "sync.persona_id", "label": "用户身份 ID", "type": "text", "group": "同步",
             "default": "", "desc": "留空跟随小窝当前用户身份；填写已有身份 ID 可固定归属。原始聊天与附件始终保存到对应会话，群聊模式跟随当前成员。"},
            {"key": "memory.enabled", "label": "整理每日记忆草稿", "type": "bool", "group": "同步",
             "default": True, "desc": "复用现行记忆库：原文归档 → 清洗 → 每日事件草稿 → 人工审核启用。关闭仅停止自动整理，仍保存聊天原文；表情标签独立存放。"},

            # ---- 高级：事件与媒体 ----
            {"key": "events.poke", "label": "被戳一戳有反应", "type": "bool", "group": "高级",
             "default": True, "desc": "有人在群里戳它，它会回一句（不刷屏：同一个人 30 秒内只理一次）。"},
            {"key": "events.notice", "label": "群成员变动记一笔", "type": "bool", "group": "高级",
             "default": False, "desc": "有人进群 / 退群 / 撤回消息时，往小窝同步一条记录（不让它开口）。"},
            {"key": "media.video_frames", "label": "视频抽几帧给小糖人看", "type": "number", "group": "高级",
             "default": 4, "desc": "走本体的抽帧（≤15 秒 / ≤50MB / 最多 8 帧），桥不自己调 ffmpeg。", "min": 0, "max": 8},
            {"key": "modes.group", "label": "群聊模式", "type": "select", "group": "高级",
             "default": "chat", "options": [{"value": "chat", "label": "正常聊"}, {"value": "silent", "label": "只看不说（静音）"}]},
            {"key": "modes.dm", "label": "私聊模式", "type": "select", "group": "高级",
             "default": "chat", "options": [{"value": "chat", "label": "正常聊"}, {"value": "silent", "label": "只看不说（静音）"}]},
        ],
    },
    {
        "id": "japanese_lab",
        "name": "小糖人日语实验室",
        "emoji": "🌸",
        "kind": "other",
        "status": "available",
        "desc": "用自己攒的例句和插图学日语：旧单词表导进来抽卡背，不懂的语法当场问小糖人，日语成绩记下来让她写分析。",
        "needs_vision": False,  # 讲词 / 答疑 / 写分析都是文字路；插图只落本地，不外发
        "folder": "japanese-lab",
        "runner": {
            "folder": "japanese-lab",
            "module": "jplab",
            "commands": [
                {"name": "check", "label": "自检", "desc": "查学习库、大脑通不通、模型配没配 —— 出问题先跑这个", "params": []},
                {"name": "scan", "label": "找找有什么能导", "desc": "扫「个人数据库」里的日语资料，只列出来不读内容", "params": []},
                {"name": "serve", "label": "打开实验室（常驻）", "desc": "起本地的学习服务 —— 小窝里的面板和独立网页都连它；关掉窗口才停",
                 "params": [], "background": True},
            ],
        },
        # 能在前端改的开关（§9.6.5）：改完立刻生效，不用去编辑功能里的 config.json。
        "settings": [
            {"key": "study.levels", "label": "现在学哪几级", "type": "list", "group": "学什么",
             "default": ["N5"], "desc": "逗号分隔，例如 N5,N4。抽卡只从这几级里出 —— 别一上来就全开。"},
            {"key": "study.daily_new", "label": "每天背几个新词", "type": "number", "group": "学什么",
             "default": 10, "desc": "一天认识多少个新词（复习不算在内）。", "min": 1, "max": 200},
            {"key": "study.character", "label": "谁来陪你学", "type": "character", "group": "谁陪你",
             "default": "", "desc": "讲词 / 答疑 / 记例句用这位的口吻。留空 = 名册第一个人。"},
            {"key": "coach.enabled", "label": "让她讲词和答疑", "type": "bool", "group": "谁陪你",
             "default": True, "desc": "关掉 = 卡片上不出「问她」按钮，纯自己背（也省 token）。"},
            {"key": "coach.style", "label": "要她用什么调子", "type": "textarea", "group": "谁陪你",
             "default": "", "desc": "留空 = 用她本来的性格。想让她更严厉 / 更啰嗦就写一句，会加进讲词和答疑里。"},
            {"key": "score.analyze", "label": "成绩分析怎么写", "type": "select", "group": "成绩",
             "default": "llm",
             "options": [{"value": "llm", "label": "让小糖人写（有人设味，花 token）"},
                         {"value": "rule", "label": "只用规则算（不花钱）"}],
             "desc": "规则版只讲数据里明摆着的事，不做解读。"},
            {"key": "score.character", "label": "谁来看你的成绩", "type": "character", "group": "成绩",
             "default": "", "desc": "留空 = 跟着上面「谁来陪你学」那位。"},
            {"key": "media.auto_generate", "label": "自动给例句配图", "type": "bool", "group": "例句插图",
             "default": False, "desc": "**还没接**：以后接本体的生图引擎，给例句自动生成插图。"
                                      "现在打开只是记下意愿 —— 自己拍的、网上找的图照样能配。"},
            {"key": "import.source_dir", "label": "还去哪个目录找单词表", "type": "text", "group": "导入",
             "default": "", "desc": "留空 = 只看「个人数据库」里的日语资料。填绝对路径的话会加进去一起扫。"},
            {"key": "memory.enabled", "label": "把学日语的事记成记忆", "type": "bool", "group": "导入",
             "default": False, "desc": "将实际答疑、复习自评和成绩同步到本体当天经历，可在 QQ/桌宠回忆。不开启时保留原有本地学习方式；同步本身不调用模型。来源总开关在个人记忆库。"},
        ],
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
        "desc": "可选插件：同步手动开启的 Gemini 网页会话文字，不调用模型或写入记忆。浏览器扩展位于插件目录。",
        "needs_vision": False,
        "folder": "gemini-sync",
        "runner": None,
    },
    {
        "id": "english_study",
        "name": "英语学习",
        "emoji": "📖",
        "kind": "other",
        "status": "available",
        "desc": "用你自己的单词表背四六级：导入旧词表、伪随机抽卡复习、让小糖人给每个词写有她味道的"
                "例句和插图、做完记成绩并按分类找出薄弱点。语法那边给英语兔讲解的目录树，"
                "中译英 / 填空 / 改写 / 造句都由 AI 批改；不懂的直接问她。",
        # 插图靠「让小糖人画一张」——前端调 /api/images/generate，那条路跟视觉路无关；
        # 这个功能自己不读图（不需要 vision 模型）。
        "needs_vision": False,
        # **独立项目**（2026-10-16 从本体内搬出来的）：自己的 git 仓库、自己的库、自己的端口。
        # 和隔壁 japanese-lab 是姐妹项目，只是各认各的词表。
        "folder": "english-study",
        "runner": {
            "folder": "english-study",
            "module": "english",
            "commands": [
                {"name": "check", "label": "自检", "desc": "查学习库、大脑通不通、模型配没配 —— 出问题先跑这个", "params": []},
                {"name": "scan", "label": "找找有什么能导", "desc": "扫「个人数据库」里的英语资料，只列出来不读内容", "params": []},
                {"name": "stats", "label": "看一眼进度", "desc": "多少词、今天该背几个、连刷几天", "params": []},
                {"name": "serve", "label": "打开学习服务（常驻）", "desc": "起本地的学习服务 —— 小窝里的面板和独立网页都连它；关掉窗口才停",
                 "params": [], "background": True},
            ],
        },
        # 能在前端改的开关（§9.6.5）：改完立刻生效，不用去编辑功能里的 config.json。
        # key 必须和 `english/settings.py` 的 REMOTE_KEYS 一一对上。
        "settings": [
            {"key": "study.tag", "label": "只看哪个分类", "type": "text", "group": "学什么",
             "default": "", "desc": "留空 = 全部一起背（推荐）。填「四级」这种就只从这一分类抽卡。"},
            {"key": "study.daily_new", "label": "每天背几个新词", "type": "number", "group": "学什么",
             "default": 50, "desc": "一天认识多少个新词（复习不算在内）。", "min": 1, "max": 500},
            {"key": "quiz.batch", "label": "一屏背几个", "type": "number", "group": "学什么",
             "default": 50, "desc": "复习时一屏显示几张卡，背完一屏点「再看下一屏」。", "min": 10, "max": 200},
            {"key": "study.character", "label": "谁来陪你学", "type": "character", "group": "谁陪你",
             "default": "", "desc": "写例句 / 答疑用这位的口吻。留空 = 名册第一个人。"},
            {"key": "grammar.character", "label": "谁陪你练语法", "type": "character", "group": "谁陪你",
             "default": "", "desc": "讲语法 / 出题批改用她的口吻。留空 = 跟着上面「谁来陪你学」那位。"},
            {"key": "coach.enabled", "label": "让她讲词和答疑", "type": "bool", "group": "谁陪你",
             "default": True, "desc": "关掉 = 卡片上不出「问她」按钮，纯自己背（也省 token）。"},
            {"key": "coach.style", "label": "要她用什么调子", "type": "textarea", "group": "谁陪你",
             "default": "", "desc": "留空 = 用她本来的性格。想让她更严厉 / 更啰嗦就写一句，会加进讲词、答疑和批改里。"},
            {"key": "import.source_dir", "label": "还去哪个目录找单词表", "type": "text", "group": "导入",
             "default": "", "desc": "留空 = 只看「个人数据库」里的英语资料。填绝对路径的话会加进去一起扫。"},
            {"key": "memory.enabled", "label": "把学英语的事记成记忆", "type": "bool", "group": "导入",
             "default": False, "desc": "隔离在 english_study 里，不会漏进日常闲聊。也按轮花钱，默认关。"},
        ],
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
