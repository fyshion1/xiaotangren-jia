# 通用外设接入层（§9.6）

糖人小窝里的每个功能都是**独立项目**，通过这一层调用「小糖人大脑」：人格、记忆、模型调用、通用队列。
本项目**不实现任何功能的逻辑**（《规划探讨.md》§0 第一原则）。

这一层是原[游戏接入层](./game-integration.md)的**通用化版本**：`game_id` 泛化成 `feature_id`。
游戏专用的 `/api/game/*` **原样保留**，等价于 `feature_id=<game_id>` 的旧协议；新功能一律走 `/api/nest/*`。

## 功能清单

```
GET /api/nest/features
```

返回后端注册表（`backend/app/features_registry.py`，**代码级真相源**）里的全部功能。
前端小窝按它渲染入口列表 —— 加功能只要在注册表加一条 + 给功能建一个独立仓库 `features/<folder>/`。

条目字段：`id`（功能命名空间，也是记忆隔离键）、`name`、`emoji`、`kind`、`status`、`desc`、
`needs_vision`（用不用视觉）、`folder`（独立项目目录，空 = 在本体内）、`runner`（能不能在小窝里启动，见下）、
`settings`（能在小窝前端改哪些开关，见 §9.6.5）。

## 媒体落盘：功能别自己存文件（§9.6.4）

功能从外面（QQ / 别的平台）拿到图 / 表情包 / 视频，**不要自己落盘再自己起静态服务** ——
前端聊天记录只认本体这一套附件引用（`/api/files/<session>/…` + 缩略图 + 画廊收藏 + 删消息级联）。
功能自己另存一份，等于把图片管理劈成两半，删消息时文件就漏了。

```
POST /api/qq-bridge/attachments     # base64 + mime + session_id → 附件管道 → 返回引用 URL
```

- 收的是 **base64 + 声明 mime**（不是 data URL、不是 multipart）—— 平台侧拿到的就是字节；
- **按内容签名去重**：群里反复发同一个表情包，只落一次盘、只占一个 URL（返回值带 `deduped`）；
- 只落盘，**不解析、不转码、不上传任何外部服务**；体积沿用附件管道（图 20MB / 视频 100MB，表情包 5MB 以上降级按普通图）。
- 视频要用视觉：存完后调 `POST /api/media/video/analyze` 抽帧（本体已有，带 15 秒 / 50MB / 8 帧的安全线），
  抽到的帧再当 data URL 传给 `/api/nest/chat`。**别在功能里自己调 ffmpeg** —— 两处实现必然不一致。

> 路径名带 `qq-bridge` 是因为它是第一个提出这个需求的（QQ 里表情包 / 语音的量级最大）。
> 换个平台接入（Telegram / Discord…）同一个需求照用，或者再开一条同构的窄接口。

## QQ 桥（第一个走完这条路的示范）

`features/qq-bridge/` 是「IM 类外设」的完整样板，它示范了几件事该怎么接：

| 要干的事 | 走哪个接口 | 别干什么 |
|---|---|---|
| 收图 / 表情 / 视频 | `POST /api/qq-bridge/attachments` | 别自己落盘、别自己起静态服务 |
| 视频要让小糖人看见 | `POST /api/media/video/analyze` 抽帧 → `/api/nest/chat` 带 `images` | 别在功能里调 ffmpeg |
| 小糖人说话 | `POST /api/nest/chat`（人格 / 记忆 / 密钥都在本体） | 别复制人设、别存 key |
| 小糖人出声 | `POST /api/voice/tts`（edge 晓晓 / piper） | 别自己装一套 TTS |
| 语音转文字 | 用**平台自己的转写**（QQ 网关一般挂在 `record.text` 里） | 别假装听懂 —— 转不出就记 `[语音]` |
| 聊过的同步进前端 | `POST /api/messages`（群聊 → `group`，私聊 → `single-<角色id>`） | 别另开一套存储 |
| 让模型调本地工具 | `POST /api/nest/tool-turn`（只回决定，本体不执行） | 别无中生有一个「功能自己的模型客户端」 |

**ASR 是已知空缺**：本体的语音模块只有 TTS（说），没有识别（听）。大老大拍板：
**用 QQ 自己的转写**（手机上那个「转文字」，网关一般会挂在 `record` 段里）。
QQ 桥的 `asr.engine` 默认就是 `qq`；拿不到转写时可以选 `openai` 在功能侧接外部 whisper
（**音频会过上游、要花钱**），或者干脆记 `[语音]`。**不要往本体里塞一个识别引擎** ——
那是功能的需求，不是大脑的。

## API 配置：两层

功能调用模型时，配置**两层合并**：

| 层 | 存哪 | 说明 |
|---|---|---|
| **全局默认** | `settings.nest_brain_default` | 「小窝大脑默认」，**默认带视觉路** |
| **功能覆盖** | `game_api_configs` 表（`game_id = feature_id`） | 可覆盖任意字段，留空 = 用全局默认 |

```
GET    /api/nest/api-config                          # 读全局默认
PUT    /api/nest/api-config                          # 写全局默认（字段同下）
GET    /api/nest/features/{feature_id}/api-config    # 读该功能**合并后**的生效配置
PUT    /api/nest/features/{feature_id}/api-config    # 写该功能的独立覆盖
DELETE /api/nest/features/{feature_id}/api-config/{config_id}   # 删覆盖 → 回落全局默认
```

字段：`name`、`base_url`、`api_key`、`model`、`vision_base_url`、`vision_api_key`、`vision_model`、`needs_vision`。

- **视觉路**：`vision_*` 留空则回退到普通路（`base_url`/`api_key`）；全局默认建议都填上 ——
  QQ 也会看图看视频（大老大批注）。
- **屏蔽视觉**：`needs_vision: false` = 这个功能不读视觉那一路（前端小窝里有对应勾选）。
  屏蔽时生效配置里 `vision_*` 会返回空串，避免误用。

生效配置的返回值里 `source` 是 `global_default` 或 `feature_override`，`override` 带当前覆盖的名字/ id。

> ⚠ 返回值**包含 api_key 明文**，仅限本机桥接端调用。禁止写入日志、禁止发给别的 Agent、禁止进浏览器。
> 部署在可信本机环境（后端只绑 `127.0.0.1`）。

**不要读浏览器 localStorage 的 `xiaotangren.config`** —— 那是聊天页的配置，和小窝大脑**故意分开**。

## 通用对话

```
POST /api/nest/chat
```

与游戏层 `POST /api/game/chat` 同构，`game_id` → `feature_id`。字段：
`feature_id`、`world_id`（可空）、`player_id`（可空）、`character_id`、`character_ids`（可选，最多 8 位，一次模型调用分饰多角）、
`conversation_id`、`messages`、`images`（可选）、`state`、`stream`、`max_tokens`、`memory_recall`（见下）。

- 上游由**该功能合并后的配置**决定；没配任何上游 → 409。
  **不会回退到服务端的 .env 或聊天页配置** —— 小窝大脑和聊天接口是两份独立的配置，这是刻意的。
- 默认不调用普通聊天组装器，不主动把家庭记忆和私人聊天上下文带进功能会话（人设和规则由本条接口自己组装）。
- **长期记忆召回**：请求里传 `memory_recall: true` 才召回；另外 `nest.py` 的 `MEMORY_RECALL_FEATURES`
  内建登记了 `qq_bridge` —— 它和群聊 / 私聊是同一个大脑，换个入口不该失忆（QQ 桥自己也显式传这个字段，
  两边任一处都够）。召回规则与普通聊天相同（最近几轮拼 query →
  家记忆 + 每位在场角色个人记忆 → 排版进 system），检索失败静默跳过，不影响回话。
  召回的就是**日常聊天那一桶**（`game_id=''`），和群聊 / 私聊共用；`memory.isolate` 只管写入侧
  （提炼进哪个命名空间），不影响这里的召回。
- `stream: true` 走 SSE，事件 `token` / `done` / `error`，每帧带 `conversation_id`。
- 多角色回复的 `message.content` 是 JSON 字符串：`{"replies":[{"character_id":"…","text":"…"}]}`。

### 带图调用（视觉路）

`images` 是 **data URL** 列表（`data:image/png;base64,…`），最多 8 张 —— 与视频抽帧同一条 token 安全线。

- 传了 `images` → 走该功能的**视觉路**（`vision_model` / `vision_base_url` / `vision_api_key`）；
  没传 → 走普通路。两条路可以完全不同的中转站和模型。
- 该功能 `needs_vision: false`（被「屏蔽视觉」）或没配视觉模型时，带图直接 **409**，不默默降级。
- **必须 data URL**：裸 base64 会被 vsllm / New API 这类中转打成 400（和 `/api/media/video/chat` 同一个坑）。
- 非 `data:image/` 开头 → 422；单张超 8 MB → 413。不接受任意外链，防 SSRF。

> 这就是「一起看」的口子：把视频抽成 ≤8 帧（ffmpeg）转 data URL 传进来即可。
> 实时逐帧 token 太贵，按 §9.6.3 暂不做。

## 刻意留的口子（做了要花钱 / 有风险，默认关）

功能项目里有些能力在代码上留了**位置**但**不实现**，免得哪天有人误触。目前两个：

| 口子 | 位置 | 状态 |
| --- | --- | --- |
| 「一起看」（同步看视频） | `scout/runner.py::watch_together_stub` | **只抛 `NotImplementedError`** —— 路是通的（同 `chat` 的 `images`），实时逐帧 token 太贵，按 §9.6.3 不做 |
| 去**别人的视频下**发评论并 @ 主人 | `scout/runner.py::post_comment` | **默认关**（`POST_COMMENT_ENABLED = False`）；默认只生成「评论草稿」推回小窝，**有话在小窝前端说**，别去污染别人的评论区 |

这两个现在在小窝前端「⚙ 功能开关 → 留口子的功能」里有开关（`watch.enabled` / `comment.enabled`
/ `comment.at_owner` / `comment.max_per_day`），**但开关只是记下「大老大想要」，不会让它们真的开始工作**：

- 「一起看」：打开也是抛（路标摆着，代码没写）。
- 发评论：`comment_enabled()` 要求**前端开关 + 代码常量 `POST_COMMENT_ENABLED` 都为真**。
  常量现在写死 `False`，所以前端打开也发不出去 —— 免得一个开关给了「已经能发了」的错觉。

要真开评论，得自己补：B站登录 Cookie（`SESSDATA`，**绝不进仓库**）、频控（每天几条，前端 `comment.max_per_day`）、
前端二次确认。**这些不该由大脑代劳**，是功能项目自己的责任。

## 功能配置项：开关搬进前端（§9.6.5）

独立功能以前要改白名单 / 演谁 / 音色，只能去开终端编辑 `features/<folder>/config.json`
（终端里中文还乱码）。大老大原话：「这块希望在前端可以自己配置，现在说比较复杂」。所以：

```
GET /api/nest/features/{feature_id}/settings    # 能配什么（schema）+ 现在是什么（values）
PUT /api/nest/features/{feature_id}/settings    # 整份提交，只认声明过的 key
```

**声明归功能，值归本体**：

- 「有哪些项、什么类型、默认值」由功能在 `backend/app/features_registry.py` 里**声明** —— 跟着功能代码走，
  前端**不写死任何字段**，加一条声明就自动长出一个开关（后端改注册表，前端不用动）。
- 「值是多少」存本体（`feature_settings` 表，一个功能一行 JSON），因为值要在前端改。
- 功能侧 `GET` 这一条拉回去**覆盖自己的 config.json**，改完立刻生效、不用重启
  （QQ 桥每 30 秒 pull 一次，逛 B站 每轮 pull 一次）。
- 合并顺序（功能侧自己实现）：`代码默认` → `config.json` → `前端设置`。**前端最高**。
- 拉不到不算错：大脑没起时功能照常用本地 `config.json` 跑 —— 单向依赖，不反向拖累。

字段声明的形状（`SettingField`）：

| 键 | 说明 |
| --- | --- |
| `key` / `label` / `desc` | 前端显示的标题和人话说明 |
| `type` | `text` / `textarea` / `number` / `bool` / `list` / `select` / `accounts` / `character` / `media_list` |
| `default` | 没配过时前端显示、后端补上的值 |
| `group` | 前端按这个分组（同一组放一起） |
| `secret` | 前端用密码框（**只是不明文晃眼，不加密、也不回显遮蔽**） |
| `options` / `min` / `max` | `select` 的候选项 / `number` 的取值范围（越界 422） |
| `fields` | `type=accounts` 时每一行里的格子（见下） |
| `invert` | 只给 `bool`：**前端显示成存储值的反**（名字反着写的开关，如 `memory.isolate`） |

两个特殊类型：

- **`character`** —— 下拉选一位小糖人，候选项由前端现拉 `/api/characters`。
- **`accounts`** —— 「多个账号各演一个人」的重复行编辑器，`fields` 声明每行有哪些格子
  （QQ 桥用它做「一个 QQ 号 = 一个小糖人」，最多 20 行）。

`invert` 值得单独说一句：`memory.isolate` 这种 key **名字是反着写的**（true = 不共享），
可大老大要看的是正面那句「和群聊 / 私聊共享记忆」。所以声明里标 `invert: true`，
前端把勾选框和「恢复默认」的提示都翻过来显示 —— **`default` 和 `values` 一律还是存储语义**
（`default: False` = 不隔离 = 共享 = 默认开着），后端 `_coerce` / `_settings_payload` 也不认这个标记。
功能侧拉回去直接覆盖 `config.json`，它同样不认 —— 别名只活在显示层。

后端只做四件事，**不解释字段的业务含义**：① 把声明和值拼成一份给前端；② 丢了没声明过的 key
（返回 `ignored`）；③ 按 `type` 粗校验（收不拢就 422，宁可拒绝不静默改）；④ 按声明补默认值。
**字段的含义、怎么用、什么时候生效，全是功能自己的事。**

## 工具调用：模型做决定，功能去执行（§9.6.6）

大老大批注：「不碰本地工具的话，我倒是希望他能碰一下，只要别搞坏东西」。做法是**给能力 + 画硬边界**：

```
POST /api/nest/tool-turn    # 带 tools 声明问一次模型，返回它的决定
```

请求：`feature_id`、`character_id`、`messages`、`tools`（OpenAI function calling 格式）、`images`、`state`。
返回：`{conversation_id, content, tool_calls: [{id, name, arguments}], finish_reason}`。

**本体一个动作都不执行** —— 它只是「会说工具话的模型客户端」。循环由功能自己转：

```
功能 ─ tools 声明 ─▶ 本体 ─▶ 模型
                          ◀── tool_calls（模型想调什么）
功能在本进程里执行（白名单 + 沙箱）─▶ role="tool" 的结果 ─▶ 再问一次
```

为什么执行权必须留在功能那侧：**只有功能进程知道沙箱在哪**。QQ 桥的 `qqbridge/tools.py` 是示范：

1. **谁能触发**（`tools.require_owner`，默认只有大老大的消息）—— 群里别人说「删个文件」是提示注入，不是授权；
2. **白名单动作**（登记表是代码常量，配置只能从里面**挑**名字，加不进新动作）；
3. **沙箱路径**（`resolve()` 之后的真实路径必须仍在根里，`..` / 符号链接 / 绝对路径一律拒绝）；
4. 兜底：删除 / 关机 / 格式化 / 改注册表这类**写死在代码里永远拒绝**，配置改不动。

被拒也要**如实告诉模型**（返回 `(False, 原因)`，不抛异常）—— 否则它会以为「沉默 = 成功了」。

## 在本体里把功能跑起来（前端「🚀 让功能跑起来」）

独立功能的实现不在本体里，但大老大不想为了跑它去开终端（终端里中文还会变乱码）。
本体只当**按一下启动键的人**：

```
POST   /api/nest/features/{feature_id}/run         # 启动（非流式命令等它跑完，循环命令立刻回 pid）
GET    /api/nest/features/{feature_id}/run         # 在不在跑
GET    /api/nest/features/{feature_id}/run-log     # 读最近的输出（?lines=）
DELETE /api/nest/features/{feature_id}/run         # 停掉循环进程
```

**怎么知道一个功能能不能启动**：`GET /api/nest/features` 里那条功能带不带 `runner`。

```json
{
  "folder": "bilibili-scout",
  "module": "scout",
  "commands": [
    {"name": "dry",   "label": "试跑（不花钱）", "desc": "只抓取 + 打分",        "params": ["limit"]},
    {"name": "run",   "label": "逛一轮",        "desc": "挑出来推回小窝",       "params": ["limit", "characters", "memory"]},
    {"name": "watch", "label": "一直逛（循环）", "desc": "每 N 分钟一轮",       "params": ["interval", "limit", "characters"], "background": true}
  ]
}
```

`background: true` = **常驻子命令**（跑起来就不返回的那种，比如「一直逛」「接上 QQ」）：
后端立刻回 `pid`，前端显示「停掉」、日志边跑边刷。没标的（试跑 / 自检 / 逛一轮）都是跑完才返回。
**别拿命令名去猜要不要后台跑** —— 由功能自己在注册表里声明（`bilibili_scout` 的 `watch` 和
`qq_bridge` 的 `run` 是常驻，两者的名字并不一样）。

请求体：`command`（必须是上面列出的名字）、`limit`、`interval`、`character_ids`、`memory`。
**只传参数，不传命令** —— 真 argv 是后端按 `runner` 拼的：`[python, -m, <module>, <command>, ...白名单参数]`。

安全边界（别放开）：

- 命令名 / 路径 / 参数名**全部**来自 `backend/app/features_registry.py`，白名单之外一律 422；
- 进程 cwd 锁在 `features/<folder>/` 内（`resolve()` 后必须还在 `features/` 下），日志落 `backend/data/nest_runs/<feature_id>.log`；
- 同一功能已在跑 → 409，避免点出一堆进程；循环进程用 `DELETE` 停。
- 日志一律按 **utf-8** 读回（`PYTHONIOENCODING=utf-8` 起进程），前端不会看到乱码。

前端「选谁去看」的候选来自 `GET /api/characters`（= 角色介绍里的人），传的就是 `character_ids`。
**人设只有角色介绍一个来源**：功能项目不许复制人设，只传 `character_id`，人格由大脑组装。

## 功能动态流（推给人看的东西）

```
POST   /api/nest/feed                 # 功能推一条动态
GET    /api/nest/feed                 # 列出（?feature_id=&status=&limit=）
PUT    /api/nest/feed/{item_id}       # 改状态：new / seen / saved / dismissed
DELETE /api/nest/feed/{item_id}       # 删
```

独立功能（B站刷到的视频、QQ 里聊到的…）把**给人看的产出**推进来，小窝渲染成卡片。
后端**只当中转站**：不解释 `payload`、不校验业务含义、不替功能决定什么值得推。

字段：`feature_id`、`kind`（`video` / `note` / 任意短串）、`title`、`url`、`summary`、
`cover`、`payload`（不透明 JSON，原样存回）。

- **同一个功能下 `url` 相同 → 覆盖更新**，不会把同一个视频堆两条。
- `status` 是大老大的反馈：`saved` / `dismissed` 是给功能的偏好信号，
  功能可以 `GET …?status=saved` 读回去（例如 B站采集端用它把口味画像养准）。
- 未登记的功能 id 也照收，返回 `registered: false` 提醒调用方 —— 方便接自己写的功能。

## 功能方向说明（大老大写一句「主要看什么」）

```
GET    /api/nest/features/{feature_id}/directive   # 读（没写过返回空串）
PUT    /api/nest/features/{feature_id}/directive   # 写（{look_for, avoid}，各 ≤4000 字）
```

小窝前端「🚀 让功能跑起来」面板里的 **🎯 主要看什么** 两个框写的就是这里，存 `feature_directives` 表。

**本体只存原文，不解释** —— 怎么用完全由功能自己定（和 feed 的 `payload` 同一个态度）：

- 逛 B站 把它当**最高权重**的方向（`DIRECTIVE_WEIGHT = 8.0`，压过从收藏行为学来的兴趣词），
  `avoid` 命中直接淘汰，并且**每轮重读一次** —— 大老大改完下一轮生效，不用重启循环；
- 别的功能可以完全无视它（不读就是没这个需求）。

功能侧读不到（大脑没起 / 没写过）时**照常跑**，别把这一项做成硬依赖。

## 记忆隔离

记忆按**功能命名空间**存 —— 列名历史原因叫 `game_id`，语义是「功能隔离键」：

- 普通聊天：`game_id = ''`
- 功能（游戏 / B站 / QQ…）：传自己的 `feature_id`

两个关键点：

1. **召回**：`recall_for` / `list_memories` 的 `game_id` 默认 `""`（只命中普通聊天），传具体值才命中该功能。
   所以游戏里攒的记忆**不会**出现在日常闲聊里。
2. **写入**：`POST /api/memories/extract` 接受可选 `feature_id`，透传到 `memories.game_id`。
   **功能内做自动提炼时必须显式传 `feature_id`** —— 不传就会被当成日常聊天记忆。

```json
{
  "text": "我们把基地建在河边",
  "session_kind": "group",
  "character_ids": ["dashiyin"],
  "feature_id": "dont_starve_together"
}
```

> 特殊：QQ 这类「消息接入 IM」的功能，如果要让小糖人**记住和你在 QQ 里聊的事**（大老大批注：可同步到群聊/私聊记忆），
> 就**不传** `feature_id`（或传空）—— 让它落成普通记忆。要隔离就别传。这是功能自己的选择，大脑不替你决定。

## 通用队列与状态（沿用游戏层）

世界状态、命令队列、玩法会话这些与具体功能无关的通用能力，继续用 `/api/game/*`：

- `POST /api/game/events` / `GET /api/game/sessions/{game_id}/{world_id}` —— 上报 / 读取状态
- `POST /api/game/commands` / `GET /api/game/commands` / `POST /api/game/commands/{id}/result` —— 命令队列

`command` 只是一份协议数据，后端不解释、不执行。建议适配器自行维护动作白名单。

## Agent 协作

跨项目 Agent 用 `/api/agents/messages` 通信：`sender`、`recipient`、`conversation_id`、`correlation_id`、
`kind` 和不透明 `payload`。本项目不解析具体字段，也不共享模型上下文。收件方处理完调 `/api/agents/messages/{id}/handled`。

## 推荐的独立适配器职责

功能项目自行实现：状态采集、状态压缩、协议重试、命令白名单、动作执行、多人权限、断线恢复。
本项目只提供人格、记忆、模型调用和通用队列。目录约定见 [`features/README.md`](../features/README.md)。