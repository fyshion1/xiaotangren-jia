# 我的档案 → 记忆（§22.4）

每个用户身份（大老大、汐子……）**各挑各的**：这个身份带进对话的长期记忆，由它在「私人空间 → 我的档案 → 🧠 记忆」里自己勾。

## 两个来源

| 来源 | 表/目录 | `kind` | `ref_id` |
|---|---|---|---|
| 长期记忆 03（日常聊天、QQ 里攒下并经确认的结论） | `memories` 表 | `memory` | 记忆 id |
| 现实真实信息（个人数据库 AI 注入层） | `个人数据库/03_AI注入层/**/*.md`，只取 `review_status: approved` | `db` | 相对路径，如 `现实/住址.md` |

## 三种状态（**没有兜底**）

- **挑中 + 开** → 强制注入 system prompt（不参与相关度打分，「大老大特意叮嘱过要记住的」一节）；`db` 条目写成「确定的真实信息」。
- **挑中 + 关** → 不出现，连普通召回结果里也剔掉。
- **没挑中** → 不出现，也不会因为「相关」被召回。

新身份开出来是空的，要哪些自己点 —— 宁可暂时想不起，也不要两个身份的记忆互相串。

## 入口是否一致

同一个大脑、同一套挑选：聊天（`/api/chat`、`/api/sessions/...`）、糖人小窝（`/api/nest/chat`，含 QQ 桥）都用**当前身份**的挑选。

唯一例外：完全没有身份档案的调用（例如直接调 `/api/chat` 不带 persona）维持旧行为——只按相关度召回。

## 接口

- `GET  /api/profiles/{persona_id}/memory-picks` —— 两个池子全量 + `picked` / `enabled`
- `PUT  /api/profiles/{persona_id}/memory-picks/{kind}/{ref_id}`，body `{"enabled": true|false}` —— 挑中 / 打开 / 关掉
- `DELETE /api/profiles/{persona_id}/memory-picks/{kind}/{ref_id}` —— 取消挑选

`ref_id` 带 `/` 时由前端按段 `encodeURIComponent`，后端路由用 `{ref_id:path}` 接收。

## 代码位置

- 表：`persona_memory_picks`（`backend/app/db.py`）
- 业务：`backend/app/services/persona_memory.py`
- 注入：`backend/app/services/prompt/assembler.py`、`backend/app/routers/nest.py::_recall_memory_block`
- 前端：`frontend/src/components/PersonaMemorySection.tsx`（私人空间），聊天页「🧠 记忆」按钮直接跳到这里；每条显示到秒（`YYYY/MM/DD HH:MM:SS`），🗑 真删（`DELETE /api/memories/{id}`，连带清掉挑中行），× 只取消挑选
