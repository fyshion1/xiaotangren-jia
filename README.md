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

### 双通道：常规 / 无审查（NSFW）

聊天页头部有 **「常规 / 🔓 无审查」** 两个 chip，一键切换当前通道（切换即作用于聊天、看图、自动记忆提炼、画廊「自动描述」；生图本轮仍走常规通道）：

- **常规通道**：上面那组 base_url / key / chat / vision，日常对话与看图最稳。
- **无审查通道**：在「⚙ 模型设置 → 🔓 无审查通道」里单独填一份 base_url / api_key / chat 模型 / vision 模型，指向第三方无审查中转或本地无审查模型。
  - 字段**留空 = 沿用常规通道**（例如只填地址和模型名，key 复用同一把）。

后端无需为第二条通道改路由 —— `providers/openai.py` 是无状态的，每次调用都由请求显式带上 `base_url/api_key/model`。切到无审查通道时前端额外带 `uncensored: true`，后端会在 System Prompt 末尾追加「🔓 无审查专属规则」（在「规则 / 越狱」页单独编辑，可用「✨ 填入推荐预设」一键填一版角色扮演向范例）。

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

四个**可插拔引擎**，聊天页「🎨 生成照片」浮层顶部一键切换（选择会记住，存后端）：

| 引擎 | 状态 | 说明 |
|---|---|---|
| `local` 本地 ComfyUI | ✅ 可用 | 3050 4GB 本地跑，免费无限。填 `COMFYUI_URL` 即可 |
| `cloud` 云端 ComfyUI | ✅ 可用 | **与本地同一套协议**，只是地址不同（如 CNB 转发地址）。填 `COMFYUI_CLOUD_URL` |
| `thirdparty` 第三方 API | ✅ 可用 | 任意 OpenAI 兼容 `/images/generations` 中转 |
| `novelai` NovelAI | 🚧 插槽 | 协议不兼容 OpenAI，需独立适配器，本轮未实接 |

- `GET  /api/images/engines` —— 引擎列表（`ready` 为**实时探测**结果）+ 当前选中项
- `POST /api/images/engines/select` —— `{id}` 记住选择
- `POST /api/images/generate` —— 按当前引擎出图，结果**直接落附件库**（`source="generated"`），返回 `{images: [{id, orig, thumb}]}`

浮层里可调：提示词、负向提示词、尺寸、张数（上限 4）、步数、CFG、seed（后四项在「更多参数」里，留空 = 用工作流自带值）。
出图后点 **⤓** 下载、**⭐** 存入画廊（同聊天图片那条路）。

### 外观提示词自动拼装

浮层的提示词框会按**当前会话在场角色的当前形态**（§17）自动拼一句外貌描述（发色 / 发型 / 瞳色 / 服装…）。
「自动拼装外貌」可关；你手改过的内容**不会被覆盖**（换角色 / 换形态时会重拼，但你写的东西留着），点 **↺ 重置** 可恢复当前形态的自动版本。

### 连本地 ComfyUI

在 ComfyUI 里画好工作流 → 菜单 **`Workflow` → `Export (API)`**（旧版点齿轮开 Dev Mode 后是 **`Save (API Format)`**）
→ 导出成 `*_api.json`（形如 `{"3": {"class_type": "KSampler", "inputs": {...}}, ...}`）。
**导成带 `nodes` 数组的普通格式是错的**，那是有向图 UI 序列化，后端识别不了。

把它放进 `backend/.env`：

```
IMAGE_ENGINE=local
COMFYUI_URL=http://127.0.0.1:8188       # ComfyUI 默认端口
COMFYUI_CLOUD_URL=                      # 云端转发地址（填了就能切 cloud 引擎）
COMFYUI_WORKFLOW=                       # 留空 = 用 backend/examples/comfyui/ 里的内置示例
COMFYUI_TIMEOUT=180                     # 单张图总预算（秒）
```

不填 `COMFYUI_WORKFLOW` 就用内置的 SD1.5 示例（`backend/examples/comfyui/sd15_basic.json`）——
**用之前记得把里面的 `ckpt_name` 改成你本地实际有的模型名**，否则 ComfyUI 会直接报节点错误。
示例与导出说明见 [`backend/examples/comfyui/README.md`](./backend/examples/comfyui/README.md)。

工作流里的节点**按拓扑定位，不按 id**：正向提示词取 `KSampler.positive` 连着的 `CLIPTextEncode`、
宽高取 `latent_image` 连着的 `EmptyLatentImage`、出图取 `SaveImage` ——
所以你换模型、加 LoRA、改组节点 id 都不会崩（详见 [`项目要求.txt` §16.13](./项目要求.txt)）。

> 云端各种算力方案仍在逐个试（CNB 按核计费不合算 / vast.ai 需信用卡 / AutoDL 禁 NSFW / NovelAI 待适配），
> 引擎抽象已就位，**试出哪个就填哪个地址，不用改代码**。

### 第三方生图 API

`IMAGE_BASE_URL`（留空 = 用 `MODEL_BASE_URL`）+ `MODEL_IMAGE` 填一个支持 `/images/generations` 的中转即可
（当前 vsllm 中转没有生图通道）。也可在聊天页「⚙ 模型设置」里临时填。

---

## 画廊与照片记忆

聊天里的图片气泡右上角点 **⭐** 存入画廊（「🖼 画廊」按钮可管理）。画廊图 = 图片文件 + 一段文字描述。

### 画廊是私人的：按归属分开放（§9.4.1）

每张画廊图有一个**归属**，决定它「属于谁」：

| 归属 | 看到它的地方 |
|---|---|
| **家 · 共用** | 「糖人小窝」的「共同回忆」 |
| **某个角色**（如大诗音） | 那个角色的**介绍页**下方 |

- **自动归属**：私聊里 ⭐ 收藏的图，自动归给对话里的那位；群聊 / 导入会话收藏的归「家 · 共用」。
- **手动改**：画廊面板里每张图带一个归属下拉，随时改到别的角色或「家 · 共用」——
  **不做自动识别，分类由你自己定**。聊天里的 🖼 浮层还是全量视图（带归属筛选），是「整理」的地方。
- **自己上传图进画廊**：画廊面板有「**＋ 上传图片**」。在别的地方生的图也能收进来，成为记忆的一部分 ——
  不再只能「先发出去再收藏」。
- **照片记忆跟着归属走**：私人画廊的描述进 `personal/<角色>` 桶，**只有她本人在场时**才检索得到
  （群里聊到这个话题，其他小糖人不会知道）；家共用的描述进 `home` 桶。改归属会连带重建记忆。

### 照片记忆

- **照片记忆（A 方案，默认）**：画廊图的文字描述会作为一条记忆走 §9.2 的 embedding/RAG，
  聊到相关话题时注入「你有一张照片：〈描述〉」。每条画廊图带「是否进小糖人记忆」勾选
  （默认进，可关掉过于私密的）。
- **照片记忆（B 方案，留口子）**：多模态 embedding（中文 CLIP），图片与文字进同一向量空间 ——
  目前只留 Provider 接口占位，默认不用。
- 描述可手写，也可点「自动描述」让 vision 模型看图写一句。

接口：`GET/POST /api/gallery`（`GET` 支持 `?owner=` 过滤）、`POST /api/gallery/{id}/describe`、`PATCH/DELETE /api/gallery/{id}`。
上传走 `POST /api/attachments`（`session_id="gallery"`）落盘后再 `POST /api/gallery`，后端无新增上传接口。

---

## 删除聊天记录（真删）

聊天页在任意**你自己发的**消息上**右键**：

- **删除这条** —— 直接删
- **多选…** —— 进入多选模式，每条消息左侧出现复选框，顶部浮出「已选 N 条 · 删除 · 取消」

也可以点顶部的「🗑 删除」按钮直接进多选模式。**这是真删，删掉找不回来**：

1. 消息记录从库里删掉
2. 图片若**再没有别的消息引用**，连带删掉画廊里的收藏（含它的照片记忆）和磁盘上的原图 / 缩略图
3. 删除前的确认框会如实告诉你「N 条记录 + M 张图片 + 画廊 K 张」

同一张图被两条消息共用时，只删其中一条 → **图片文件会保留**，另一条照常显示。

助手回复不提供删除入口；流式生成中禁用删除。

---

## 立绘与头像

**角色介绍页 → ✎ 编辑资料** 里，「立绘（静态 / GIF）」和「头像」两个字段都可以：

- 点「**🖼 选择本地图片**」从浏览器选图上传（立绘支持 GIF），或
- 直接手填一个外链 URL

头像**留空就回退 emoji**。头像会出现在：聊天头部、**群聊里分段说话人的头像 + 名字**（QQ 式）、
助手气泡上方的名字行、左侧会话列表。

Live2D / 3D 形象还没做（§5 远期计划），素材先攒着。

---

## 糖人小窝 🏠

全家的**共同回忆**与以后要接的**共同玩法**入口。两个地方都能进：

- 顶部导航的「🏠 糖人小窝」
- **角色介绍页成员切换行最左边**（四位小糖人前面）的那个按钮

里面现在有：

- **共同回忆 · 画廊** —— 只放归属为「家 · 共用」的图（每人专属的在各自介绍页里）
- 🎮 **一起玩的小游戏** / 🏡 **互动小家（Unity 渲染）** —— 占位卡片，点击提示「规划中」，**不做假功能**

---

## 大老大 🐻

用户本人的角色卡（`id: dalaoda`），和四位小糖人一样有介绍页、立绘、头像、两个形态
（`日常` / `战斗模式`）和专属画廊。

**但她不会自动出现在群聊里** —— 单模型分饰多角时，把用户自己列进「在场角色」会让模型以为要替用户说话，
和用户亲手发的消息打架。想让她在场的话，改群聊默认阵容即可。

老库启动时会**逐条幂等补种**（已有角色绝不被覆盖），所以升级后会自动多出这张卡，不用改代码。
想加新角色也可以直接 `POST /api/characters`。

---

## 已实现（MVP + 第二阶段部分）

- [x] 文字聊天（SSE 流式、平滑打字机、错误透明化）
- [x] 看图（`POST /api/images/chat`，图片 Base64 → vision 模型）
- [x] 人设 / 世界书 / 越狱 Prompt 组装引擎（SQLite 存储，阶段 2）
- [x] 语音 TTS（多引擎：edge 晓晓 / piper 本地 / sovits 占位，自动朗读 + 手动朗读/停止 + 音色切换）
- [x] 语音 ASR（浏览器 Web Speech 占位，语音转文字）
- [x] 生图（§7：四引擎插槽 —— 本地/云端 ComfyUI 通用客户端 + 第三方 API + NovelAI 预留；参数区、外观提示词自动拼装、结果落附件库 + ⭐ 存画廊）
- [x] 形态切换（§17：一个角色多套人设，`id` 不变；生图外观提示词跟着当前形态走）
- [x] 聊天记录持久化（§15：SQLite + SSE 落库 + 附件落盘/缩略图 + 向上翻页）
- [x] 记忆三层 RAG（§9.2：家记忆 / 个人记忆 / 会话上下文；本地 embedding 检索注入）
- [x] 自动记忆提炼（§9.3：一条回复结束后规则预筛 + LLM 提炼落库）
- [x] 画廊 + 照片记忆（§9.4：图片气泡 ⭐ 收藏、描述走 RAG 注入、B 方案多模态占位）
- [x] 画廊归属（§9.4.1：私聊自动归属 + 手动改；私人画廊的描述只进那位的记忆）+ 自定义上传图片进画廊
- [x] 消息真删（§15.4：右键「删除这条」/ 多选批量，连带图片文件 + 画廊收藏 + 照片记忆；共享图有引用就保留）
- [x] 立绘 / 头像上传（§8.6：浏览器选图，立绘吃 GIF；头像接入聊天 / 群聊分段 / 会话列表）
- [x] 大老大角色卡（§8.5：用户本人，两个形态；老库逐条幂等补种，不覆盖已有修改）
- [x] 糖人小窝（§9.6：共同回忆画廊 + 小游戏 / Unity 互动小家占位入口）
- [x] 无审查通道（§7.1：常规 / 🔓 无审查双通道独立配 base_url/key/model，聊天·看图·画廊自动描述一键切；无审查专属越狱规则）
- [x] 人设「粘贴模板填充」（编辑器里粘贴《角色设定.md》某角色整段或「标签：值」逐行，解析 → 预览勾选 → 填入表单）
- [ ] 语音 ASR 唤醒词 / Live2D 立绘（下一阶段）

## 规划中

- Live2D / VRM 3D 可视化
- 提示词词典（§9.5：中文→英文标签映射、可扩展、按类别分，存后端 SQLite）+ 提示词预览图（小类手动裁剪上传 / 大类前端拼贴；自动生成留钩子）
- 糖人小窝里的小游戏 / Unity 渲染的互动小家（§9.6 占位）
- 画廊 → LoRA → 生图认人（排期靠后：需生图通道实机 + 画廊攒图）
- 生图引擎实机接入（用户试出后端后填地址：本地 3050 无审查模型 / NovelAI / 其他云算力）

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
│   │   ├── routers/      # chat / images / imagegen / voice / memory / gallery / attachments
│   │   ├── providers/    # OpenAI 兼容适配器（多路切换）+ novelai 插槽
│   │   └── services/     # prompt 组装、附件存储、comfyui 客户端、语音/记忆、cleanup（真删级联）
│   ├── examples/comfyui/ # 内置 API 格式示例工作流（导出说明见其 README）
│   └── pyproject.toml
├── frontend/             # React + TS + Vite（components/Avatar.tsx、NestView.tsx；lib/owner.ts）
└── models/               # 角色模型文件（Live2D / .vrm，本地）
```