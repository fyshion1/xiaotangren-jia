# 小糖人之家

小糖人专属的本地优先、无审查的多模态 AI 聊天客户端。
核心是小糖人角色（大诗音、小诗音、小白、小红薯头），并配有 Live2D / 3D 可视化形象。

> 需求与设计的唯一来源见 [`项目要求.txt`](./项目要求.txt)，本文档只讲「怎么跑起来」。

---

## 技术栈

- 前端：React + TypeScript + Vite + Tailwind CSS
- 后端：FastAPI（Python 3.10+）
- 存储：SQLite（人设 / 世界书 / 越狱设置；库文件 `backend/data/xiaotangren.db`，已加入 .gitignore）
- 模型接入：OpenAI 兼容接口（商业 API / 第三方中转 / 本地 Ollama 通用）

---

## 环境要求

| 依赖 | 版本 |
|---|---|
| Python | >= 3.10 |
| uv（推荐，用于后端依赖） | 最新 |
| Node.js | >= 18 |

---

## 快速开始（本地开发）

### 1. 后端

```bash
cd backend
cp .env.example .env      # Windows 下：copy .env.example .env
# 编辑 .env，填入你的 model_base_url / model_api_key / model_chat / model_vision
uv sync                   # 安装依赖
uv run uvicorn app.main:app --reload --port 8000
```

### 2. 前端

```bash
cd frontend
npm install
npm run dev               # 默认 http://localhost:5173
```

前端已配置代理，把 `/api` 转发到后端 `http://127.0.0.1:8000`。
打开 http://localhost:5173 即可聊天。

---

## 一键启动（开箱即用）

安装好 Python + uv 与 Node 后：

- Windows：双击 [`start.bat`](./start.bat)
- Linux / macOS：`./start.sh`

脚本会并行拉起后端（:8000）与前端（:5173）。

### Docker（可选）

```bash
docker compose up --build
```

首次构建会较慢；构建完成后前端会自动构建进静态产物，由后端统一对外提供（http://localhost:8000）。

---

## 模型配置

后端配置在 `backend/.env`（本地敏感信息，已被 .gitignore 忽略，不会提交）：

```
MODEL_BASE_URL=https://api.openai.com/v1   # OpenAI 兼容端点（/v1）
MODEL_API_KEY=sk-...                        # 你的 key；本地 Ollama 填 ollama
MODEL_CHAT=gpt-4o-mini                      # 文字聊天模型
MODEL_VISION=gpt-4o-mini                    # 看图模型
```

支持任意 OpenAI 兼容来源：

| 来源 | `MODEL_BASE_URL` 示例 |
|---|---|
| 商业 API | `https://api.openai.com/v1` |
| 第三方无审查中转 | 中转方提供的 `/v1` 地址 |
| 本地 Ollama | `http://localhost:11434/v1`（key 填 `ollama`） |

---

## 已实现（MVP）

- [x] 文字聊天（SSE 流式、打字机效果）
- [x] 看图（`POST /api/images/chat`，图片 Base64 → vision 模型）
- [ ] 多模型切换界面 / 聊天记录持久化（下一阶段）

## 规划中

- 人设 / 世界书 / 越狱 + 记忆（三层 RAG）
- 语音（ASR + TTS，与毕设联动）
- Live2D / VRM 3D 可视化
- 生图（NSFW）

详见 [`项目要求.txt`](./项目要求.txt)。

---

## 目录结构

```
小糖人之家/
├── 项目要求.txt          # 唯一需求源
├── start.bat / start.sh  # 一键启动脚本
├── docker-compose.yml    # Docker（可选）
├── backend/              # FastAPI
│   ├── app/
│   │   ├── main.py       # 入口
│   │   ├── config.py     # 配置（.env）
│   │   ├── routers/      # chat / images
│   │   ├── providers/    # OpenAI 兼容适配器（多路切换）
│   │   └── services/     # prompt 组装（占位）
│   └── pyproject.toml
├── frontend/             # React + TS + Vite
└── models/               # 角色模型文件（Live2D / .vrm，本地）
```