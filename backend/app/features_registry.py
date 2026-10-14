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

from typing import Any, Literal, NotRequired, TypedDict


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

    为什么由功能在注册表里声明、值却存在本体：功能是**独立项目**，大老大不该为了
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
    # type=accounts 时：一行里有哪些格子（同一种形状，少 `group`/`secret` 之外都能用）。
    fields: NotRequired[list[dict]]


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
    # 有 settings = 这个功能有「前端可改的配置项」（§9.6.5）；前端按声明渲染表单，
    # 值存本体（`feature_settings` 表），功能自己拉回去用。没有 = 前端不给设置入口。
    settings: NotRequired[list[SettingField]]


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
            {"key": "comment.at_owner", "label": "留言时 @ 上大老大", "type": "bool", "group": "留口子的功能",
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
        },
        # 这个功能的配置项**全部在前端改**（值存本体，桥每轮读一次）——
        # 大老大原话：「这块希望在前端可以自己配置，现在说比较复杂」。
        "settings": [
            # ---- 先定「哪个号演谁」（多账号）----
            {"key": "accounts", "label": "QQ 号 × 小糖人", "type": "accounts", "group": "谁在 QQ 上",
             "desc": "一个 QQ 号 = 一个小糖人。填几个就跑几个（各连各的网关端口），群聊里谁被 @ 谁开口。"
                     "留空 = 用下面「这个号」那一组（单账号）。",
             "default": [],
             "fields": [
                 {"key": "name", "label": "备注名", "type": "text", "desc": "随便写，方便你自己认"},
                 {"key": "self_id", "label": "QQ 号", "type": "text", "desc": "机器人的 QQ 号"},
                 {"key": "persona", "label": "演谁", "type": "character", "desc": "留空 = 名册第一个人"},
                 {"key": "listen_port", "label": "网关端口", "type": "number", "desc": "留空 = 3001 起依次排"},
                 {"key": "access_token", "label": "access_token", "type": "text", "secret": True},
                 {"key": "groups", "label": "接哪些群", "type": "list", "desc": "群号，逗号分隔；留空 = 这个号的群一律不理"},
                 {"key": "private", "label": "接哪些人私聊", "type": "list", "desc": "QQ 号，逗号分隔；留空 = 私聊一律不理"},
                 {"key": "enabled", "label": "启用这个号", "type": "bool"},
             ]},

            # ---- 单账号（accounts 空的时候用这组）----
            {"key": "persona.character_id", "label": "这个号演谁", "type": "character", "group": "这个号",
             "default": "", "desc": "留空 = 角色介绍里的第一个人（启动时会提醒你一次）。"},
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
            {"key": "owner.qq", "label": "大老大的 QQ", "type": "text", "group": "白名单",
             "default": "", "desc": "管理员。私聊不受白名单限制，可发 /reset /silent 这类桥直接执行的管理命令。"},
            {"key": "owner.admin_commands", "label": "允许管理命令", "type": "bool", "group": "白名单",
             "default": True, "desc": "/reset /silent /active /whoami —— **桥直接执行，不过模型**。"},
            {"key": "owner.tools", "label": "允许大老大用本地小工具", "type": "bool", "group": "白名单",
             "default": False, "desc": "让小糖人碰一下本地文件（只在「小工具」那组划定的目录里）。默认关。"},

            # ---- 网关接入 ----
            {"key": "onebot.mode", "label": "连接方式", "type": "select", "group": "接入方式",
             "default": "server", "desc": "反向 WS（推荐）：桥监听端口，网关配地址连过来。正向 WS：桥主动连网关。",
             "options": [{"value": "server", "label": "反向 WS（网关连过来）"},
                         {"value": "client", "label": "正向 WS（我连网关）"}]},
            {"key": "onebot.listen_port", "label": "监听端口", "type": "number", "group": "接入方式",
             "default": 3001, "desc": "反向 WS 用。在网关里把「反向 WS 地址」配成 ws://127.0.0.1:<这个端口>/onebot/v11/ws。"
                                      "**NapCat 自带的 WS 服务默认也爱占 3000/3001**，撞了就把这里改成 3002（网关那边跟着改）。",
             "min": 1, "max": 65535},
            {"key": "onebot.listen_path", "label": "监听路径", "type": "text", "group": "接入方式",
             "default": "/onebot/v11/ws", "desc": "一般不用改，和网关里填的保持一致就行。"},
            {"key": "onebot.ws_url", "label": "网关地址", "type": "text", "group": "接入方式",
             "default": "ws://127.0.0.1:3001", "desc": "「正向 WS」时才用，例如 ws://127.0.0.1:3000。"},
            {"key": "onebot.access_token", "label": "access_token", "type": "text", "secret": True, "group": "接入方式",
             "default": "", "desc": "网关设了才填。**留空 = 不校验**：任何能连到本机这个端口的东西都能指挥小糖人发消息。"
                                     "本机自用一般没事；装了别的软件 / 端口对外开放时强烈建议设一个。"},

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
                         {"value": "openai", "label": "再用中转的 whisper 兜一层"},
                         {"value": "none", "label": "不识别，记成 [语音]"}],
             "desc": "本体没有语音识别。QQ 网关一般自带转写（就是手机上「转文字」那个），"
                     "拿得到就用；拿不到时选 whisper 会多花一点钱、音频也会经过上游。"},
            {"key": "asr.base_url", "label": "识别用哪家中转", "type": "text", "group": "声音",
             "default": "", "desc": "留空 = 用大脑给这个功能配的那份。只在上面选了 whisper 时用。"},
            {"key": "asr.api_key", "label": "识别用的 key", "type": "text", "secret": True, "group": "声音",
             "default": "", "desc": "留空 = 用大脑那份，不另存。"},
            {"key": "asr.model", "label": "识别模型", "type": "text", "group": "声音",
             "default": "whisper-1", "desc": "如 whisper-1 / whisper-large-v3。"},

            # ---- 表情包 ----
            {"key": "sticker.enabled", "label": "会发表情包", "type": "bool", "group": "表情包",
             "default": True, "desc": "大老大很喜欢小糖人的表情包 —— 想让它偶尔来一张就把下面的概率调上。"},
            {"key": "sticker.reply_chance", "label": "每轮回话时来的概率", "type": "number", "group": "表情包",
             "default": 0, "desc": "0 = 只在被点名要的时候发；0.1 差不多十次里来一张。", "min": 0, "max": 1},
            {"key": "sticker.auto_collect", "label": "学到别人的表情包", "type": "bool", "group": "表情包",
             "default": True, "desc": "群里别人发的表情会收进库（只是存下来，不外传）。"},
            {"key": "sticker.treat_small_image_as_sticker", "label": "小图也当表情包收", "type": "bool",
             "group": "表情包", "default": False, "desc": "有些网关把表情包当普通图发，打开这个能兜住。"},
            {"key": "sticker.library", "label": "表情包库", "type": "media_list", "group": "表情包",
             "default": [], "desc": "存的是本体附件库里的引用（删消息 / 清理时一起管），桥不另存一份。"},
            {"key": "sticker.library_session", "label": "表情包存在哪个会话目录", "type": "text", "group": "表情包",
             "default": "single-dalaoda", "desc": "上传表情包时落到哪个附件目录（一般不用改）。"},

            # ---- 小工具（大老大说「可以碰，只要别搞坏东西」）----
            {"key": "tools.enabled", "label": "允许碰本地文件", "type": "bool", "group": "小工具",
             "default": False,
             "desc": "默认关。开了之后小糖人能**在划定的目录里**列目录 / 读文本 / 找文件；"
                     "沙箱外的路径一律拒绝，删除 / 关机 / 格式化这类动作写死在代码里，永远拒绝。"},
            {"key": "tools.root", "label": "只许碰这个目录", "type": "text", "group": "小工具",
             "default": "", "desc": "留空 = 用 features/qq-bridge/data/sandbox/。**越界一律拒绝**，想让它管更大的地方就填绝对路径。"},
            {"key": "tools.allow", "label": "允许它做哪些事", "type": "list", "group": "小工具",
             "default": ["dir", "read", "find", "info"],
             "desc": "只能填 dir（列目录）/ read（读文本）/ find（找文件）/ info（看边界）。"
                     "**加不进别的名字** —— 这份名单是代码里的登记表，配置只能从里面挑。"},
            {"key": "tools.max_bytes", "label": "单次最多读多少字", "type": "number", "group": "小工具",
             "default": 8000, "desc": "读大文件时截断，免得把 token 烧光。", "min": 100, "max": 60000},
            {"key": "tools.require_owner", "label": "只有大老大能用", "type": "bool", "group": "小工具",
             "default": True, "desc": "关掉 = 群里任何人说「让小糖人跑个命令」都能触发。**建议一直开着**。"},

            # ---- 同步与记忆 ----
            {"key": "sync.to_frontend", "label": "QQ 里聊的同步进小窝", "type": "bool", "group": "同步",
             "default": True, "desc": "群聊 → 小窝群聊，私聊 → 对应小糖人的私聊。关掉就只在 QQ 里聊。"},
            {"key": "sync.persona_id", "label": "放进谁的私聊", "type": "character", "group": "同步",
             "default": "", "desc": "留空 = 大老大的身份。填了就写进那位小糖人的私聊会话。"},
            {"key": "memory.isolate", "label": "QQ 的事单独记", "type": "bool", "group": "同步",
             "default": False, "desc": "关着 = QQ 里聊的也进日常记忆（小糖人平时就记得）；打开 = 只在 QQ 场景里记得。"},

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