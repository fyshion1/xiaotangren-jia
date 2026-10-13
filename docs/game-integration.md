# 通用游戏接入层

本项目只提供小糖人的大脑 API，不实现任何具体游戏 Mod、Lua、引擎插件或游戏内动作。
具体游戏项目通过 HTTP 调用本层，负责自己的状态采集、动作执行和联机同步。

## 协议

### 游戏独立 API 配置

游戏端按 `game_id` 获取专属模型配置，不读取普通聊天配置，也不读取浏览器 localStorage：

- `GET /api/game/api-configs?game_id=dont_starve_together`
- `POST /api/game/api-configs`，body：`{game_id,name,base_url,api_key,model}`

配置按游戏隔离；当前接口部署在可信本机环境，返回值包含 API key，仅允许本机桥接端调用，禁止写入日志或发送给其他 Agent。

基础地址为 `/api/game`：

- `POST /events`：适配器上报 `{game_id, world_id, state, event}`。服务只保存最新状态并回显事件。
- `GET /sessions/{game_id}/{world_id}`：读取最新状态。
- `POST /commands`：上层排入抽象命令 `{game_id, world_id, character_id, command}`。
- `GET /commands?game_id=&world_id=&status=queued`：适配器拉取命令。
- `POST /commands/{id}/result`：适配器回报 `completed / failed / cancelled` 与结果。

`command` 只是一份协议数据，后端不会解释、执行或生成具体游戏代码。建议具体适配器自行维护动作白名单。

## 游戏聊天与多角色合并回复

`POST /api/game/chat` 使用 `game_id` 对应的最近更新启用 API 配置；没有配置返回 409，不回退到普通聊天配置。密钥由后端用于模型调用，适配器无需读取。

聊天请求携带 `game_id`、`world_id`、`player_id`、`character_id`、`messages`、`state`、`stream` 和 `max_tokens`。可选 `character_ids` 将多个人格放入一次模型请求（最多 8 位，ID 唯一、都存在且包含主角色）；省略该字段则保持单角色纯文字回复。

```json
{
  "game_id": "example-game",
  "world_id": "world-001",
  "player_id": "player-001",
  "character_id": "character-a",
  "character_ids": ["character-a", "character-b", "character-c"],
  "messages": [{"role": "user", "content": "大家晚上好"}],
  "state": {},
  "stream": false,
  "max_tokens": 4096
}
```

多角色回复的 `message.content` 为 JSON 字符串，内容格式为 `{"replies":[{"character_id":"character-a","text":"台词"}, ...]}`。后端读取各人格并在一次模型生成中输出所有角色；外部适配器负责校验格式、显示台词和维护历史。不包含任何具体游戏的实体、贴图或控制逻辑。

推理模型可能将思考计入 token 上限，应为完整结构预留预算；请求次数减少不等于费用按角色数量等比例下降。当前仍为调用方提供近期历史，没有启用普通聊天记忆召回。

## 记忆隔离

记忆接口支持 `game_id` 与 `world_id`：

```json
{
  "text": "我们把基地建在河边",
  "session_kind": "group",
  "character_ids": ["dashiyin"],
  "game_id": "example-game",
  "world_id": "world-001"
}
```

普通聊天使用空字符串；游戏适配器必须始终传入自己的游戏和世界标识。检索时用同样的两个字段过滤，游戏经历不会进入普通聊天记忆。

**自动提炼也要带命名空间**：`POST /api/memories/extract` 接受可选 `feature_id`，透传到 `memories.game_id` 列。
不传 = 普通聊天记忆（`game_id=''`）。**普通聊天的自动提炼走的是 `game_id=''`，所以游戏内提炼必须显式传 `feature_id`**，
否则这段经历会被当成日常聊天记住，下次闲聊时被召回 —— 这是隔离的关键一环。
召回侧：`recall_for` / `list_memories` 的 `game_id` 默认 `""`（只命中普通聊天），传具体值才命中该功能的记忆。

## 推荐的独立适配器职责

适配器项目自行实现：游戏事件采集、状态压缩、协议重试、命令白名单、游戏动作执行、多人权限和断线恢复。本项目只提供人格、记忆、模型调用和通用队列。

## Agent 协作

跨项目 Agent 使用 /api/agents/messages 通信。消息包含 sender、recipient、conversation_id、correlation_id、kind 和不透明 payload；本项目不解析具体游戏字段，也不共享模型上下文。收件方处理后调用 /api/agents/messages/{id}/handled。
