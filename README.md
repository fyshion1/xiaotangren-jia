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
MODEL_BASE_URL=https://vsllm.cc/v1   # OpenAI 兼容端点（/v1）
MODEL_API_KEY=sk-...                  # 你的 key；本地 Ollama 填 ollama
MODEL_CHAT=gemini-3.8-flash           # 文字聊天模型
MODEL_VISION=gemini-3.8-flash         # 看图模型
MODEL_IMAGE=                          # 生图模型（vsllm 无生图通道，需另配中转）
IMAGE_BASE_URL=                       # 生图中转地址（留空 = 用 MODEL_BASE_URL）
```

聊天页「⚙ 模型设置」也可在浏览器里直接填（base_url / key / chat / vision / 生图模型），
存入本地浏览器；Key 留空 = 走服务端 `.env` 里的 key。

支持任意 OpenAI 兼容来源：

| 来源 | `MODEL_BASE_URL` 示例 |
|---|---|
| 商业 API | `https://api.openai.com/v1` |
| 第三方无审查中转 | 中转方提供的 `/v1` 地址 |
| 本地 Ollama | `http://localhost:11434/v1`（key 填 `ollama`） |

---

## 语音（TTS）

多引擎 TTS，**先选引擎、后选音色**（聊天页右栏「🗣 语音」）：

| 引擎 | 说明 | 音色 |
|---|---|---|
| `edge` | 微软在线 Neural TTS（edge-tts，免费、需网络） | 晓晓（默认） |
| `piper` | 本地离线轻量合成（piper-tts + onnx，无需网络、低算力友好） | 华燕 / 小雅 / 超文 |
| `sovits` | GPT-SoVITS 专属音色（**留按钮、尚未安装**） | —— |

- `GET  /api/voice/engines` —— 引擎列表
- `GET  /api/voice/voices?engine=xx` —— 某引擎的音色
- `POST /api/voice/tts` —— `{text, engine, voice}` → 音频（edge=audio/mpeg，piper=audio/wav）

右栏开关：「🔊 朗读/停止」（最近一条）、「🎙 自动朗读」（每条回复自动播）。
同一时刻只会有一条语音：新朗读会作废在途旧请求并停掉上一条，「⏹ 停止」可立即停下。

piper 音色文件放在 `backend/data/tts/piper/*.onnx`（约 60MB/个，已 gitignore，不随仓库提交）。
**换机器 / 新 clone 后需先下载一次**：

- Windows：双击 [`download_piper_voices.bat`](./download_piper_voices.bat)
- Linux / macOS：`./download_piper_voices.sh`

脚本默认走国内镜像 hf-mirror（可设 `PIPER_MIRROR` 换源）。下好后 `GET /api/voice/voices?engine=piper` 才会列出对应音色。

---

## 生图

`POST /api/images/generate` —— 转发 OpenAI 兼容 `/images/generations`（`{prompt, size, n}`）。
**当前 vsllm 中转没有生图通道**，需在「模型设置」里另填一个支持生图的中转地址 + 模型名；
本地 ComfyUI / SD WebUI 的接入按《项目要求》§7 后续补。

---

## 已实现（MVP + 第二阶段部分）

- [x] 文字聊天（SSE 流式、平滑打字机、错误透明化）
- [x] 看图（`POST /api/images/chat`，图片 Base64 → vision 模型）
- [x] 人设 / 世界书 / 越狱 Prompt 组装引擎（SQLite 存储，阶段 2）
- [x] 语音 TTS（多引擎：edge 晓晓 / piper 本地 / sovits 占位，自动朗读 + 手动朗读/停止 + 音色切换）
- [x] 语音 ASR（浏览器 Web Speech 占位，语音转文字）
- [x] 生图接口（`/api/images/generate`，转发 OpenAI 兼容生图）
- [ ] 记忆三层 RAG（下一阶段）
- [ ] 语音 ASR / 唤醒词（下一阶段）

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