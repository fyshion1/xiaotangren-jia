# 小糖人之家

小糖人专属的本地优先、无审查的多模态 AI 聊天客户端。
核心是小糖人角色（大诗音、小诗音、小白、小红薯头），并配有 Live2D / 3D 可视化形象。

> 需求与设计的唯一来源见 [`项目要求.txt`](./项目要求.txt)，本文档只讲「怎么跑起来」。

---

## 技术栈

- 前端：React + TypeScript + Vite + Tailwind CSS
- 后端：FastAPI（Python 3.10+）
- 存储：SQLite（人设 / 世界书 / 越狱设置 / 聊天记录 / 记忆 / 画廊；库文件 `backend/data/xiaotangren.db`，已加入 .gitignore）
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

### 手机 / 其他设备访问（同一 Wi-Fi 或校园网）

前端 dev server 已监听所有网卡（`server.host: true`），所以**同一局域网内的手机**可以直接打开。
启动时脚本会打印可用地址，形如：

```
http://192.168.x.x:5173
```

把那串地址在手机浏览器里打开即可（**保持电脑上两个服务开着**）。

> 代理发生在电脑本机，手机只跟 Vite 打交道，`/api` 由 Vite 转发给后端 —— 所以
> 手机侧**不需要**、也**不应该**直连 `:8000`，后端仍可只绑 `127.0.0.1`。
> 若打不开：确认手机与电脑在同一网段、电脑防火墙放行 5173、路由器未开启「AP 隔离」。
> ⚠️ 该配置面向本地/局域网开发，**请勿把 5173 直接暴露到公网**。

**手机端界面**：聊天页在窄屏（<768px）自动切为**底部 Tab**（💬 会话 / 🐾 聊天 / 📊 状态），
一次只显示一栏，桌面端仍是三栏并排。启动脚本打印的地址里，`169.254.x.x` 是系统自分配
的无效地址、`172.x` 多为虚拟网卡（WSL/Hyper-V），**用手机所连网段对应的那个 IP**。

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

## 记忆 RAG（三层记忆）

记忆检索走本地 embedding，默认用 `BAAI/bge-small-zh-v1.5`（约 100MB，CPU 可跑）。
模型文件同样**不进 git**，换机器 / 新 clone 后需先下载一次：

- Linux / macOS：`./download_embedding.sh`
- Windows：`./download_embedding.sh`（Git Bash / WSL 均可；纯 `curl` + `git-lfs` 回退）

脚本默认走 hf-mirror（可设 `HF_MIRROR` 换源；可设 `EMBED_MODEL` 换模型），把模型下到 `backend/data/models/embedding/`。
下好后记忆 RAG 立刻生效。若本地模型没下（或缺依赖），可在 `.env` 里切云端 embedding：

```
EMBED_ENGINE=cloud                  # local（默认）| cloud
EMBED_BASE_URL=https://vsllm.cc/v1  # 留空 = 复用 MODEL_BASE_URL
EMBED_CLOUD_MODEL=text-embedding-3-small
# key 复用 MODEL_API_KEY
```

### ⚠ 换 embedding engine 需重建向量库

本地小模型与云端 `/v1/embeddings` 产出的向量**口径不同**（不同模型向量空间不同，余弦相似度不可比）。
换 engine 后请务必清空并重建记忆索引，否则检索会乱掉（见 [`项目要求.txt` §16.6](./项目要求.txt)）。
最简单方式：删掉 `backend/data/xiaotangren.db` 里的 `memories` 表，重新触发记忆存储即可。

---

## 生图

`POST /api/images/generate` —— 转发 OpenAI 兼容 `/images/generations`（`{prompt, size, n}`）。
**当前 vsllm 中转没有生图通道**，需在「模型设置」里另填一个支持生图的中转地址 + 模型名；
本地 ComfyUI / SD WebUI 的接入按《项目要求》§7 后续补。

聊天页「🎨 生成照片」浮层顶部有**生图方式切换器**（三选一，选择会记住）：

| 方式 | 状态 | 说明 |
|---|---|---|
| 腾讯云 | 占位 | 默认项；实机接入排在生图通道就绪之后 |
| 本地 ComfyUI / SD | 占位 | 3060 4GB 本地跑；填本地 `/v1` 地址即可接入 |
| 第三方生图 API | ✅ 可用 | 任意支持 `/images/generations` 的中转，现在就接得通 |

- `GET  /api/images/engines` —— 生图方式列表 + 当前选中项
- `POST /api/images/engines/select` —— `{id}` 记住选择（仅记录，实机接入前不改变上游调用）

---

## 画廊与照片记忆

聊天里的图片气泡右上角点 **⭐** 存入画廊（「🖼 画廊」按钮可管理）。画廊图 = 图片文件 + 一段文字描述。

- **照片记忆（A 方案，默认）**：画廊图的文字描述会作为一条记忆走 §9.2 的 embedding/RAG，
  聊到相关话题时注入「你有一张照片：〈描述〉」。每条画廊图带「是否进小糖人记忆」勾选
  （默认进，可关掉过于私密的）。
- **照片记忆（B 方案，留口子）**：多模态 embedding（中文 CLIP），图片与文字进同一向量空间 ——
  目前只留 Provider 接口占位，默认不用。
- 描述可手写，也可点「自动描述」让 vision 模型看图写一句。

接口：`GET/POST /api/gallery`、`POST /api/gallery/{id}/describe`、`PATCH/DELETE /api/gallery/{id}`。

---

## 已实现（MVP + 第二阶段部分）

- [x] 文字聊天（SSE 流式、平滑打字机、错误透明化）
- [x] 看图（`POST /api/images/chat`，图片 Base64 → vision 模型）
- [x] 人设 / 世界书 / 越狱 Prompt 组装引擎（SQLite 存储，阶段 2）
- [x] 语音 TTS（多引擎：edge 晓晓 / piper 本地 / sovits 占位，自动朗读 + 手动朗读/停止 + 音色切换）
- [x] 语音 ASR（浏览器 Web Speech 占位，语音转文字）
- [x] 生图接口（`/api/images/generate`，转发 OpenAI 兼容生图）+ 生图方式切换器（腾讯云/ComfyUI/第三方，占位）
- [x] 聊天记录持久化（§15：SQLite + SSE 落库 + 附件落盘/缩略图 + 向上翻页）
- [x] 记忆三层 RAG（§9.2：家记忆 / 个人记忆 / 会话上下文；本地 embedding 检索注入）
- [x] 自动记忆提炼（§9.3：一条回复结束后规则预筛 + LLM 提炼落库）
- [x] 画廊 + 照片记忆（§9.4：图片气泡 ⭐ 收藏、描述走 RAG 注入、B 方案多模态占位）
- [ ] 语音 ASR 唤醒词 / Live2D 立绘（下一阶段）

## 规划中

- Live2D / VRM 3D 可视化
- 画廊 → LoRA → 生图认人（排期靠后：需生图通道实机 + 画廊攒图）
- 生图（NSFW）实机接入（本地 ComfyUI / 腾讯云）

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