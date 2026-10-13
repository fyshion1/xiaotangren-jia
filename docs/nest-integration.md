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
`needs_vision`（用不用视觉）、`folder`（独立项目目录，空 = 在本体内）。

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
`conversation_id`、`messages`、`images`（可选）、`state`、`stream`、`max_tokens`。

- 上游由**该功能合并后的配置**决定；没配任何上游 → 409。
  **不会回退到服务端的 .env 或聊天页配置** —— 小窝大脑和聊天接口是两份独立的配置，这是刻意的。
- 不调用普通聊天组装器，避免把家庭记忆和私人聊天上下文带进功能会话。
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

要真开评论，得自己补：B站登录 Cookie（`SESSDATA`，**绝不进仓库**）、频控（每天几条）、前端二次确认。
**这些不该由大脑代劳**，是功能项目自己的责任。

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
    {"name": "watch", "label": "一直逛（循环）", "desc": "每 N 分钟一轮",       "params": ["interval", "limit", "characters"]}
  ]
}
```

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