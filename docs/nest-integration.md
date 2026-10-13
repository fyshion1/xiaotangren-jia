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
`conversation_id`、`messages`、`state`、`stream`、`max_tokens`。

- 上游由**该功能合并后的配置**决定；没配任何上游 → 409，**不回退到普通聊天配置**。
- 不调用普通聊天组装器，避免把家庭记忆和私人聊天上下文带进功能会话。
- `stream: true` 走 SSE，事件 `token` / `done` / `error`，每帧带 `conversation_id`。
- 多角色回复的 `message.content` 是 JSON 字符串：`{"replies":[{"character_id":"…","text":"…"}]}`。

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