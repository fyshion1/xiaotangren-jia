# features 共享活动契约

2026-10-19 第一版。功能来源保留在 `source_feature_id`，不决定记忆隔离；身份和角色可见范围由本体检查。原有 `feature_id` 的模型配置/旧命名空间协议继续兼容，不应批量清空历史字段。

## 接入步骤

1. 在 `backend/app/features_registry.py` 注册功能；实现仍放独立功能仓库。
2. 动作开始前确定明确 `persona_id`（本机当前身份可读 `GET /api/profiles` 的 `active_id`），保存到本次动作和待同步记录，重试时不重新取当前身份。
3. 实际问答/活动先持久化到功能自己的待同步队列，用稳定事件编号调用事件入口；本体确认后再移除待办。角色讲解、用户提问、实际工具回执分别上报，不能把教学模板伪装成用户原话。
4. 同事件修改递增 `revision`；不同问题即使文本一样也使用不同编号。保留原发生时间，时区必须明确。不要把每次重试都当成新事件。

## 上报事件

`POST /api/memory/events`，以下仅是协议示例，不代表真实经历：

```json
{
  "persona_id": "dalaoda",
  "source_feature_id": "japanese_lab",
  "event_id": "thread-42-question-3",
  "revision": 1,
  "occurred_at": "2026-10-19T14:03:05+08:00",
  "kind": "learning",
  "role": "user",
  "text": "は和が怎么区分？",
  "topic": "日语助词",
  "character_ids": ["dashiyin"],
  "scope": "personal",
  "context": "real"
}
```

返回 `seq`（本体全局序号）和 `replayed`。重复的同编号同修订同内容返回原序号；异内容或版本倒退返回 409。版本更新保留原版本，当前时间线只显示有效最新版本。被删除事件不会因旧待办重试而复活，新活动需要新编号。

助手回答使用单独事件编号、`role=assistant`，用 `reply_to` 指向问题编号。`role=activity` 用于实际活动结果。`scope=personal` 必须指定已有角色；`shared` 表示当前身份下共同可见，不表示跨用户身份公开。可选 `session_id` 必须与身份一致。附件只接受本体 `/api/files/` 引用。

可选 `context_text`（最多 4000 字）保存提问时正在看的词汇/例句背景，让“这里为什么这样用”保留指代；它是资料背景，不是系统指令。`context` 则仍是 real/fiction/exercise 的语境标签。

`context` 可选 `real`、`fiction`、`exercise`。真实讨论过某个语法点属于 real；例句中的虚构事件属于 exercise，游戏世界事实属于 fiction。近期现实回忆不会自动注入 fiction/exercise 原文，管理页仍能检索；可另上报真实“今天一起玩了某游戏”的活动。

来源已停止接收时返回 409，保留待办等待用户重新开启；不要自动替换成 core 或空来源绕过策略。功能已取消注册时新上报返回 422，历史仍可管理。

## 管理与检索

| 接口 | 用途 |
|---|---|
| `GET /api/memory/sources?persona_id=...` | 来源、安装状态、活动/候选/正式记忆计数与策略 |
| `PUT /api/memory/sources/{source}` | 显式提交 persona_id、receive、organize、recall、archived |
| `GET /api/memory/events?persona_id=...&day=2026-10-19&source=japanese_lab&query=助词&offset=0&limit=100` | 管理用原文时间线；day/source/query 可省，返回 next_offset |
| `GET /api/memory/daily?persona_id=...&day=2026-10-19` | 跨来源当天归纳、证据序号和投影版本 |
| `POST /api/memory/events/{seq}/candidate` | persona_id＋用户确认的 text，进入现有长期待审核流程 |
| `GET /api/memory/events/{seq}/delete-preview?persona_id=...` | 删除影响预览 |
| `DELETE /api/memory/events/{seq}?persona_id=...` | 清除该活动原文；关联聊天按既有规则清理，正式记忆独立管理 |

管理查询面向本机当前用户的资料管理，允许查看已关闭召回的原文；不要把管理 API 全量响应直接塞给角色。角色聊天通过本体提示词流程使用受身份、角色、来源开关、现实语境及预算限制的近期依据。通用 `/api/nest/chat` 可传明确 `persona_id`，`memory_recall=true` 时另带已审核的共享长期记忆；调用模型不等于自动归档用户真实活动，插件仍须上报实际原文。

同秒用全局序号提供稳定顺序，并不声称不同设备的秒级时钟能证明真实先后。`received_at` 独立保存接收时间；因果关系依赖 reply_to 和事件修订，不能只靠时间较新就覆盖事实。

参考适配器：`features/japanese-lab/jplab/memory_sync.py`。原来的记忆开关仍控制是否采集新学习活动，已经进入 outbox 的待办会继续尝试交付；本体 receive 开关可暂缓其接收。
