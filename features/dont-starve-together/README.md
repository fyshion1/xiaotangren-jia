# 饥荒联机版 · 小糖人陪伴（DST adapter）

`feature_id = dont_starve_together` · 独立项目，不随小糖人之家本体提交。

实现代码目前在本机 `C:\Users\32437\Desktop\dont starve mod`（DST Mod + Python 适配器），
接大脑的客户端是 `adapter/brain_client.py`。

## 接大脑

向小糖人之家后端（`http://127.0.0.1:8000`）要配置与对话，**不要硬编码 key**：

```python
BrainClient().game_api_configs()        # 取本功能的模型配置（api_key 只留内存）
BrainClient().chat(world_id, player_id, character_id, text, state=..., character_ids=[...])
```

对应协议：
- 配置 `GET /api/nest/features/dont_starve_together/api-config`（合并全局默认 + 本功能覆盖；默认带视觉）
- 对话 `POST /api/nest/chat`（`feature_id` 即隔离键）
- 状态 / 命令队列 / 玩法会话沿用 `/api/game/*`（与具体游戏无关的通用能力）

> 迁移提示：现有 `brain_client.py` 走的是旧的 `/api/game/*` 协议（仍兼容）。
> 想让「屏蔽视觉 / 全局默认」这些新配置生效，把 `game_api_configs()` 与 `chat()`
> 的路径换成上面的 `/api/nest/*`；`game_id` 参数改叫 `feature_id`，值仍是 `dont_starve_together`。

## 记忆隔离

游戏内做自动记忆提炼时，调 `POST /api/memories/extract` **要带 `feature_id: "dont_starve_together"`**，
这样游戏里的事只进游戏记忆，不会漏进日常聊天。玩法会话总结提交（`/api/game/play-sessions/{id}/summary/commit`）
本来就按 `game_id` 落隔离记忆，保持不动。