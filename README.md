# Shionarium · 源码试用版

本地优先的 AI 聊天与记忆框架，从“小糖人之家”拆分而来。本体提供通用聊天、档案和记忆能力；小糖人品牌外观、字体、角色图片及默认设定由可选项目 `features/xiaotangren-theme` 提供。未安装主题时使用中性界面、助手和用户默认档案，已有角色、聊天与记忆继续保留。见[主题拆分说明](docs/guides/theme-feature.md)。

这是仍在迭代的源码试用版，安装指南更新于 **2026-10-24**。推荐先在 Windows 电脑或 Windows 平板上跑通网页聊天，再按需配置语音、QQ、桌宠和自主活动。模型服务和可选功能需要自行配置，不附带可直接使用的 API 额度。插件接口与部署体验仍会调整，请先用测试数据体验并备份需要保留的资料。

本体原创代码采用 [Apache-2.0](LICENSE)，允许依许可修改、商用与再分发。第三方代码、素材、模型和独立插件分别遵循各自许可，适用范围见 [LICENSE_SCOPE.md](LICENSE_SCOPE.md)。

## 现在可以体验什么

| 功能 | 当前范围与前提 |
| --- | --- |
| 角色聊天 | 单角色私聊、多人群聊、流式回复、身份档案、提示词查看与角色编辑。需要可用的聊天模型。 |
| 小糖人主题（可选） | 独立项目 `features/xiaotangren-theme` 提供现有配色、装饰、素材和默认角色设定；安装变更后需重启后端并重新构建前端。 |
| 酒馆兼容插件（可选） | 独立项目 `features/tavern` 提供角色卡导入、开场白、HTML/正则显示和世界书；未安装不影响本体。见[安装说明](docs/guides/tavern-feature.md)与[兼容范围](docs/guides/card-html-preview.md)。 |
| 图片与视频 | 上传附件、看图、视频关键帧、画廊收藏和存储管理。看图需要视觉模型；视频处理还需 FFmpeg。 |
| 个人记忆 | 原始聊天归档、清洗、每日事件整理、长期记忆候选、人工审核、注入与来源管理。AI 整理会调用模型。 |
| 个人数据库与知识资料 | 管理个人事实、知识文档、出处检索与待确认草案；支持独立 Embedding API。 |
| 工具中心 | 专家模式按插件抽屉授权联网、知识资料、项目费用和提醒工具；需另行安装 features/tools。联网依赖第三方 OmniReach，部分来源需 Chrome 扩展。 |
| 语音 | Edge/Piper 朗读；单角色持续通话支持本地或云端识别与合成、插话打断。需另配模型文件或语音服务。 |
| 生图 | 本地/云端 ComfyUI、OpenAI 兼容生图接口。需自备对应服务；NovelAI 目前为预留适配。 |
| QQ 与桌宠 | 本体有接入、配置与共享对话能力；桥客户端、桌宠应用及网关属于额外安装内容。 |
| 自主活动与小工作室 | 自主活动设置、项目申请、预算、成果与隔离工作区管理；容器执行需要 Docker 和配套镜像。 |
| 轻量与委托运行 | 可选轻量常驻主机和独立算力端，见[部署指南](docs/guides/delegated-mode.md)。 |

## 首次安装：推荐 Windows 网页测试

准备 Git、**Python 3.11**（项目声明支持 3.10+）、**Node.js 22 LTS** 和 [uv](https://docs.astral.sh/uv/getting-started/installation/)。网页基础聊天不要求独立显卡、Docker、QQ 或桌宠。

### 1. 获取项目

在 PowerShell 中运行：

```powershell
git clone https://github.com/fyshion1/xiaotangren-jia.git
cd xiaotangren-jia
python install-features.py
```

下载询问依次提供 **桌宠、QQ 桥、联网搜索、QQ 语音转写、本地说话与听写、按意思查找记忆和资料**，全部默认不安装（直接回车）。提示先解释能做什么，再介绍依赖。QQ 语音转写不下载朗读音色；完整本地语音另含中文音色。「按意思查找」安装本地 embedding 模型，模型约 100 MB，但运行依赖可能占 GB 级空间；不安装仍可关键词检索。安装及首次配置见[可选组件说明](docs/guides/optional-components.md)。其他功能不在安装器中提供选项，请到 [GitHub](https://github.com/fyshion1) 按需求查看各仓库。下载不等于已完成账号配置；私有仓库需要访问权限。以后也可再次运行 `python install-features.py`，已有目录会跳过。

维护者首次部署验收记录、已发现问题及已推送版本的验证范围，见[从 GitHub 开始的首次部署验收](docs/guides/fresh-github-install-2026-10-24.md)。

已有项目时先保存自己的改动，再运行 `git pull`。不要用另一台机器的私人数据覆盖自己的配置。

未安装主题时，首次创建一个“用户”身份和一个“助手”，不预填生日、身体数据、职业或亲密关系。可在私人空间自行编辑，身体尺寸字段默认隐藏，可在编辑器中取消隐藏。更新程序会保留已有档案；旧档案的称呼和介绍需要在私人空间自行修改。

### 2. 安装后端依赖并配置模型

```powershell
cd backend
uv sync --locked --inexact --python 3.11
Copy-Item .env.example .env
notepad .env
```

`Copy-Item` 只在首次安装时执行，已有 `.env` 请直接编辑。至少将以下四项替换成自己服务商实际提供的配置；样例文件中的地址、模型名和占位密钥不代表可用服务：

```dotenv
MODEL_BASE_URL=https://你的服务商地址/v1
MODEL_API_KEY=你的密钥
MODEL_CHAT=服务商提供的聊天模型名
MODEL_VISION=服务商提供的视觉模型名
```

只测试文字时可以先配置聊天模型，视觉功能稍后再配。使用本地 Ollama 时，兼容地址通常为 `http://127.0.0.1:11434/v1`，密钥可填 `ollama`，模型名填写已下载的模型。

聊天页的「模型设置」也能填写连接配置；聊天配置与「糖人小窝 → 小窝设置 → 小窝大脑」供外部功能使用的配置是分开的。修改 `.env` 后重启后端。API 地址填写根地址，通常以 `/v1` 结尾，不要填完整 `/chat/completions` 路径。

### 3. 安装前端依赖

```powershell
cd ../frontend
npm ci
cd ..
```

启动脚本不会代替上述依赖安装。以后更新代码，如果依赖清单有变化，重新执行后端 `uv sync --locked --inexact` 和前端 `npm ci`。`--inexact` 保留安装器此前选装的语音、转写或记忆依赖；普通 `uv sync` 会移除未在本次命令中指定的可选依赖。

### 4. 启动小窝

普通模式自动启动前端、大脑，以及已安装的 QQ 桥、桌宠和常驻功能后端；未安装的功能会跳过。
双击 `start.bat`，或运行：

```powershell
.\start.bat
```

需要同时验收一份全新副本时，可在该副本运行 `.\start.bat --backend-port 18002 --frontend-port 15174`，前端代理会跟随本窗口的后端端口。副本需独立安装依赖，不复制 `.env`、数据目录、模型或私人插件；不要在同一目录重复启动。

打开 **http://localhost:5173**。后端地址为 `http://127.0.0.1:8000`，健康检查为 `http://127.0.0.1:8000/api/health`，接口文档为 `http://127.0.0.1:8000/docs`。

保持启动窗口开启；直接叉掉主 CMD 会关闭它管理的全部子进程，无需先按 Ctrl+C。普通模式不显示进程管理；开发者可通过隐藏入口开启[专家模式](docs/guides/expert-mode.md)，在进程管理调整下一次启动偏好。自主活动与沙盒已迁至独立插件 `features/autonomous-activity`，只有安装插件并开启专家模式后才显示。

### Linux / macOS 或手动启动

同样先安装依赖、从样例创建 `backend/.env`。Linux/macOS 使用 `cp` 替代 `Copy-Item`。装好后在仓库根目录运行 `bash start.sh`；这个脚本只启动前后端，与 Windows 总启动器的服务管理不同。

也可以开两个终端分别执行：

```bash
# 终端一：仓库根目录
cd backend
uv run --no-sync uvicorn app.main:app --host 127.0.0.1 --port 8000
```

```bash
# 终端二：仓库根目录
cd frontend
npm run dev
```

开发后端时可另加 `--reload`；日常使用推荐启动器默认的非热重载方式。

## 给测试朋友的体验顺序

1. **先跑通文字**：打开角色介绍，进入一位角色的私聊，连续聊几轮；刷新网页确认记录保留，再测试群聊与停止生成。
2. **试角色与身份**：修改角色资料或导入一张自己的角色卡，查看导入预览、开场白、世界书和提示词；在私人空间确认当前身份。
3. **试多模态**：上传一张普通图片，询问具体内容；再试画廊收藏。视频、生图等服务配好后再测试。
4. **试记忆**：聊一件带时间、人物的合成小事，在「私人空间 → 个人记忆库」查看整理与候选，核对后批准并启用，换话题后检查能否正确引用。个人事实资料在「个人数据库」管理。

聊天输入框上方的候选回复随角色本次回复一起生成，最多 3 条，不单独请求模型；候选字段不会写入聊天正文。点击候选只填入输入框，收起候选会停止后续回合的候选生成。模型未返回有效候选时留空，不额外请求补生成。此功能仍会消耗少量附录提示和输出 token。
5. **试工具与提醒**：在「糖人小窝 → 小窝设置 → 工具中心」启用需要的能力，指定测试目录，用测试文件检查读取结果和执行记录；再测试一次性提醒。
6. **最后试扩展**：语音通话、QQ、桌宠和自主活动分别配置后单独测试，方便定位问题。

反馈时请附上：系统与浏览器版本、代码版本（`git rev-parse --short HEAD`）、复现步骤、预期/实际表现、报错截图，以及相关时间段的终端或 `backend/logs/` 日志。模型问题请说明服务商与模型名，分享前去掉密钥和私人聊天。

## 可选配置与功能边界

### 记忆和知识库

当前流程为 **原文归档 → 清洗 → AI 每日事件 → 长期候选 → 人工核对与启用**。保存聊天与生成长期记忆是不同步骤；未批准的长期候选不会直接作为正式记忆注入。自动整理会额外调用所选模型，首轮测试可先检查整理设置。

基础安装不包含 `sentence-transformers` 本地向量依赖。未配置向量服务时可使用关键词检索；需要语义检索可选：

- 在「个人数据库 → Embedding 设置」配置外部 Embedding API，不必下载本地向量模型。
- 本地方案：在 `backend/` 执行 `uv sync --locked --inexact --extra memory`，再按需运行根目录 `download_embedding.sh` 下载模型。此方案会安装较大的机器学习依赖。

更换 Embedding 来源或模型后，通过界面重建索引。**不需要删除聊天数据库或记忆表。** 重建会向所选服务发送参与索引的文本，使用自己的测试资料即可。

详见[记忆工作流](docs/guides/memory-workflow.md)、[Embedding 配置](docs/guides/embedding-api.md)、[身份与长期记忆](docs/guides/persona-memory.md)。

### 语音、视频和生图

- **朗读**：基础安装不含 Edge/Piper 运行库。按需在 `backend/` 执行 `uv sync --locked --inexact --extra online-voice` 安装 Edge 在线朗读；需要联网。Piper 随安装器的本地说话与听写选项安装，需要本地音色。
- **持续通话**：目前支持单角色私聊。可用本地 Paraformer/Piper 或云端 ASR/TTS；新 clone 不含本机已下载的识别与音色文件。本地语音可选依赖安装命令为 `uv sync --locked --inexact --extra local-voice`（在 `backend/` 执行），模型位置与服务配置见[通话说明](docs/voice-call.md)和[本地语音评估](docs/research/local-streaming-voice-options.md)。未安装语音运行库、未配置云端语音时，聊天页不显示通话、音色和语音输入入口；安装后需要重启后端并刷新页面。入口可见表示可以配置，不保证识别与合成链路均已就绪。按住说话使用浏览器识别服务，不能当成本地 Paraformer。视频通话尚未实现，不显示占位按钮。
- **视频**：安装 FFmpeg 并加入 PATH，先用短视频测试；视觉模型仍需另外配置。见[聊天附件说明](docs/guides/chat-media.md)。
- **生图**：ComfyUI 需要 API 格式工作流及实际安装的模型；示例中的 checkpoint 名称要按自己的环境修改。第三方生图需要支持 `/images/generations` 的服务与 `IMAGE_BASE_URL`、`MODEL_IMAGE` 配置。见[工作流示例](backend/examples/comfyui/README.md)。

### QQ、桌宠和其他独立功能

**`features/` 中的应用是独立 Git 仓库，本体 clone 不会将它们下载，也没有自动安装全部功能的子模块。** 功能页仅显示已安装并开启的独立功能，未安装的日语、英语和 Gemini 同步等不显示；Gemini 同步实现已迁至独立插件。

2026-10-22 已将桌宠首次提交 `101df58` 推送到私有仓库 [fyshion1/desktop-pet](https://github.com/fyshion1/desktop-pet)，QQ 桥更新 `bf8f092` 已推送到私有仓库 [fyshion1/qq-bridge](https://github.com/fyshion1/qq-bridge)。朋友需先取得两个仓库的访问权限并接受邀请。本体与两个功能分别提交、分别更新；仅拉取本体不会更新它们。

#### 桌宠安装

取得仓库访问权限后，朋友将桌宠克隆到本体的 `features/desktop-pet/`，不要另建一层同名目录。

在本体根目录打开 PowerShell：

```powershell
git clone https://github.com/fyshion1/desktop-pet.git features/desktop-pet
cd features/desktop-pet
npm ci
npm run build
..\..\backend\.venv\Scripts\python.exe -m pet doctor
```

自检通过后，保持本体后端运行，在「糖人小窝 → 一起玩 → 桌边的小糖人」配置角色、模型与小窝大脑，点击启动；也可在桌宠目录执行 `..\..\backend\.venv\Scripts\python.exe -m pet run`。这是源码运行，目前没有可直接下载的一键安装包。

`doctor` 会检查 Electron、构建产物、Cubism Core 与 Haru 模型。缺模型或 Core 时，依照本体素材授权清单从原作者渠道准备到规定路径；本机有文件不等于允许打包给别人。完整交互与模型路径见桌宠仓库自己的 README。

#### QQ 桥：先取得私有仓库权限

维护者将朋友的 GitHub 账号加入 QQ 桥仓库协作者，朋友接受邀请并登录 Git 后，在本体根目录运行：

```powershell
git clone https://github.com/fyshion1/qq-bridge.git features/qq-bridge
cd backend
uv sync --locked
cd ../features/qq-bridge
..\..\backend\.venv\Scripts\python.exe -m qqbridge check
```

若提示仓库不存在，先检查私有仓库访问权限。本体环境已提供桥所需的 aiohttp；使用本体解释器运行即可。工具插件位于可选的 features/tools，普通 QQ 聊天不依赖它。

接下来依次配置：

1. 另行安装 OneBot v11 网关（本项目使用 SnowLuma），登录自己的测试 QQ。网关不包含在 QQ 桥仓库中；安装方式见[网关接入文档](docs/integrations/qq-gateway-snowluma.md)。
2. 在「小窝设置 → 小窝大脑」填写可用的聊天/视觉模型；进入「一起玩 → QQ 糖人」配置网关安装目录、机器人账号、角色和允许联系的 QQ/群号。
3. 正向 WebSocket 地址填写网关实际开放的地址（常见示例 `ws://127.0.0.1:3001/`），有 token 时两端保持一致；不要照搬维护者本机的 `D:\SnowLuma` 路径。
4. 先运行自检，再在 QQ 面板启动桥；命令行可在桥目录运行 `..\..\backend\.venv\Scripts\python.exe -m qqbridge run`。只有收到白名单内的测试消息后才检查真实回复。

首次只配置一个机器人账号和一个测试联系人；同一账号由一份桥负责收发。朋友需要自行登录 QQ、填白名单和配置模型，维护者的 `config.json`、网关登录态和密钥不随源码分发。配置完成后再在 `start.bat --configure` 开启 QQ 桥或桌宠自动启动。

QQ 需要桥客户端、网关与登录配置；桌宠需要独立桌面应用；日语、英语、项目费用等面板也依赖各自功能项目。需要这些功能时向项目维护者取得对应仓库与安装说明，按 `backend/app/features_registry.py` 的目录约定放入 `features/`。本体仅保留接口、配置与展示层；未安装的功能不会出现在功能列表中。

入口文档：[独立功能约定](features/README.md)、[QQ 网关接入](docs/integrations/qq-gateway-snowluma.md)、[QQ 排查](docs/qq-bridge-troubleshooting.md)、[桌宠方案与接入](docs/plans/desktop-pet-mvp.md)、[Gemini 网页扩展](extensions/gemini-sync/README.md)。

自主活动、联网和容器执行按界面配置与授权使用；活动循环会产生额外模型调用。第一次建议先完成普通聊天测试，再配置模型、预算和所需运行环境。见[小工作室](docs/guides/exploration-workshop.md)与[沙盒系统地图](docs/guides/sandbox-development-map.md)。

### 手机与局域网

电脑运行前后端，手机连接同一 Wi-Fi，打开 `http://电脑的局域网IP:5173`，必要时放行电脑防火墙的 5173 端口。前端已配置监听所有网卡，并将 `/api` 代理到电脑本机的后端；手机不必直连 8000。

麦克风通常只允许 **localhost 或 HTTPS**；手机通过局域网 HTTP 能聊天，但可能无法开麦。已有 `start-tunnel.bat` 可配合自行安装的 cloudflared 测试 HTTPS。应用目前按本地单用户使用设计，隧道链接会让持有者访问这套数据及模型调用能力，请仅分享给受信任的测试者，用完关闭。

### Docker 与常驻部署

首次试用推荐上面的本地启动流程。仓库当前的 `docker-compose.yml` 前端使用静态 `serve`，没有配套将 `/api` 转发到后端的反向代理；也没有把前端构建产物复制进后端镜像。因此，现有 Compose **不能按一键完整网页部署使用**，需要补充静态资源与同源代理配置后再部署。

低配置 Debian 主机、静态前端托管与独立算力端可参考[委托模式与 Debian 部署](docs/guides/delegated-mode.md)，样例在 `deploy/`。这部分不属于基础网页测试的必需步骤。

## 数据、备份与素材

角色图片现由本体用户资源层持久保存，入口为「设置 → 角色资源」（`/#character-assets`）；已有头像、立绘会从主题素材、上传附件或内嵌图片转存，源文件保留，修改前生成数据库快照。关闭主题不再中断已保存图片的服务。人设仍以角色编辑器保存的档案为准。见[资源管理与 API](docs/guides/user-assets.md)。


聊天记录主要位于 `backend/data/xiaotangren.db`，附件、配置和下载模型位于 `backend/data/`；个人资料与正式记忆还使用仓库根目录的 `个人数据库/`、`个人记忆库/` 等本地目录。网页保存的部分偏好在当前浏览器中，不会随 Git 同步。

备份前关闭服务，至少保留 **`backend/data/`、`个人数据库/`、`个人记忆库/` 和自己的 `backend/.env`**，以及自行配置到其他路径的资料。Git push 不会备份这些忽略目录。给朋友测试应让对方生成自己的数据，分享源码不需要复制本机聊天、身份、账单或密钥。

Live2D、VRM、Piper、ASR 和 Embedding 等本机模型不保证随仓库提供。部分 `assets/` 仅由 Vite 开发服务提供，不会打进前端构建产物；缺少模型时不要将形象加载失败误判为聊天服务故障。素材的使用与转发范围见[素材授权清单](assets/LICENSE.md)，不要直接把整份本机素材目录打包转发。

## 常见问题

| 现象 | 优先检查 |
| --- | --- |
| 双击启动提示没有后端 Python | 在 `backend/` 完成 `uv sync --locked --python 3.11`，确认 `.venv` 已生成。 |
| 找不到 Node / Vite | 确认 Node 已加入 PATH，并在 `frontend/` 完成 `npm ci`。 |
| 5173 或 8000 被占用 | 先关旧启动窗口或占用端口的进程；前端固定使用 5173，不会自动换端口。 |
| 页面能开但“大脑”离线 | 检查后端终端和 `/api/health`；确认后端在 8000 启动。 |
| 聊天返回 401 / 403 / 404 | 核对密钥权限、额度、API 根地址和模型名；不要直接沿用样例服务配置。 |
| 能聊天但不能看图或用工具 | 核对视觉模型与 tools/tool_calls 支持情况、工具开关及目录授权。 |
| QQ / 桌宠 / 费用面板不能启动 | 检查对应独立功能是否已安装，以及它自己的依赖、端口与网关。 |
| 记忆没有出现在回复里 | 确认身份、角色范围、审批与注入开关，再查看实际提示词；向量检索可另外配置。 |
| 形象空白或模型 404 | 检查本机素材、模型路径及是否使用开发服务；模型通常不是基础安装内容。 |
| 回复中断 | 查看页面给出的上游长度限制、过滤或连接中断提示；回复上限设为 0 表示上游默认值。 |

## 开发与测试

技术栈：React 18、TypeScript、Vite 5、Tailwind CSS 4；FastAPI、Pydantic、SQLite；本地工具 SDK 位于 `features/tools/`。

```powershell
# 前端：在 frontend/ 执行
npm run build
node --test tests/stream.test.mjs tests/voice-call.test.mjs tests/message-merge.test.mjs

# 后端：在 backend/ 执行
.\.venv\Scripts\python.exe -m unittest discover -s tests
```

最近一次全量检查（2026-10-22，提交 `f19fc27` 前）：前端构建和上述 12 项测试通过；后端执行 596 项，2 项失败、7 项跳过。失败项为 `test_schema_comes_from_registry_with_defaults` 与 `test_proactive_short_plan_does_not_create_fake_user_or_assistant`，分别涉及 QQ 配置字段和主动消息提示词断言。这是当时的验证记录，后续代码更新需重新确认，不能视为全量测试已通过。

浏览器测试、真实模型联调、真实 QQ 收发和 Docker 测试有各自环境要求，不包含在上述前端单测中。

## 代码与文档导航

```text
backend/app/           后端接口、对话、记忆、语音、工具和启动器
backend/tests/         后端自动化测试
frontend/src/          页面、组件、API 与视觉资源
frontend/tests/        单元测试与浏览器测试脚本
features/tools/ 本地工具 SDK
features/              另外安装的独立功能项目（本仓库仅收录说明）
extensions/            浏览器扩展
assets/、models/        素材与本机模型，留意授权与忽略规则
deploy/                常驻主机及算力端配置样例
evals/                 记忆等评测数据与运行器
docs/                  使用指南、协议、研究、方案和评测记录
```

完整索引见 [docs/README.md](docs/README.md)。其他常用说明：[工具中心](docs/guides/tool-agent.md)、[一次性提醒](docs/guides/reminders.md)、[跨端共享对话](docs/integrations/shared-conversation-runtime.md)。`项目要求.txt` 和 `docs/plans/` 中的历史设计不等于当前已经实现的功能，实际行为以代码和对应使用说明为准。
