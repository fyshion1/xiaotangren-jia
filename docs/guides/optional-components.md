# 可选组件：联网与本地语音

在仓库根目录执行 `python install-features.py`，依次询问桌宠、QQ 桥、联网搜索、QQ 语音转写、本地说话与听写、按意思查找记忆和资料，全部默认不安装。先解释功能，再说明下载内容与用途。其他独立功能到 [GitHub](https://github.com/fyshion1) 按需查看。准备好 Git、Python 3.11 和 uv；脚本可以重复执行，已有功能目录和非空模型文件会跳过。

## 按意思查找记忆和资料

想不起原来的用词，也可以用意思相近的话找回记忆与知识资料。不安装仍能用关键词检索；这不是一个聊天模型，也不保证每次都能命中。

安装器单独询问「是否安装按意思查找记忆和资料？」；选 y 后安装后端 `memory` 可选依赖，并下载项目现有默认中文模型 `BAAI/bge-small-zh-v1.5`。模型约 100 MB，CPU 可用，但 sentence-transformers、PyTorch 等运行环境可能占 GB 级磁盘空间，不能把它称作整套极小安装。模型目录为 `backend/data/models/embedding/BAAI__bge-small-zh-v1.5/`，与现有后端离线加载路径一致。下载包含权重、分词器和 Pooling 配置；已存在的非空文件复用。可设置 `HF_MIRROR` 为自己使用的 Hugging Face 兼容源。

安装需联网，本地检索不上传资料，也不产生云端向量调用费用。安装不会覆盖云端/委托算力设置，不会自动换模型或触发索引重建。重启后端后，使用本地模式即可加载；如果原来用别的向量模型，需要在记忆、知识资料对应界面重建索引。`--inexact` 保留同一后端环境中已有可选依赖。这里安装的是现有检索实现，不另引入一套向量服务。

## 联网工具 OmniReach

用途：让小糖人搜索网页及受支持来源。新 clone 的本体不包含工具运行包或 OmniReach。先将独立工具插件安装到 `features/tools`，再按需安装第三方 OmniReach；仅打开开关无法使用联网搜索。目录浏览、读取文本、寻找文件、确认工具边界四项能力已删除。

独立工具插件仓库为 [fyshion1/tools](https://github.com/fyshion1/tools)，需取得访问权限。在本体根目录运行：

```powershell
git clone https://github.com/fyshion1/tools.git features/tools
```

项目费用插件另见 [fyshion1/project-costs](https://github.com/fyshion1/project-costs)，按需克隆到 `features/project-costs`。

选择安装时执行以下命令，也可手动运行：

```powershell
uv tool install --with "httpx>=0.27,<1" omnireach
```

安装后重新打开终端。若找不到 `omnireach`，执行 `uv tool update-shell` 后再重新打开终端。后端也会查找用户目录下的 `.local/bin/omnireach`。

Google 等来源还需要 Chrome 桥接。安装 Chrome 后运行：

```powershell
omnireach bridge install
omnireach bridge path
```

按命令提示在 `chrome://extensions` 开启开发者模式，通过“加载已解压的扩展程序”选择打印出的扩展目录。保持 Chrome 开启；需要登录的来源使用自己的账号登录。使用 `omnireach bridge status` 和 `omnireach doctor` 检查连接及来源状态；其他来源按 `omnireach setup <来源ID>` 的提示配置。Windows 下已有扩展但桥接断开时，可运行 `features/tools/scripts/omnireach-chrome.bat`。

安装后，联网搜索开关分别出现在前端聊天、QQ 桥和桌宠；未安装时隐藏。普通模式只开放联网能力；专家模式还可在工具中心配置其他工具。CLI 已安装不等于每个来源都可用，是否可用还取决于浏览器桥接、来源配置和网络。

## 本地 TTS + ASR

### QQ 语音也需要这些组件

QQ 桥默认先问 QQ 网关转文字，失败再调用本体的本地 Paraformer。修复代码并不包含模型文件；Git clone 到另一台电脑后必须独立安装。QQ 网关的转写可能仍受 QQ / SnowLuma 版本和消息类型影响，本地兜底就用于这条链路失败时。

在 QQ 桥面板「检查安装与 QQ」可同时查看语音依赖：`sherpa_onnx`、`pilk`、`ffmpeg`、`model_files`。缺少模型、空文件和依赖加载失败都会显示未就绪。该检查由实际运行的后端执行，避免误装到另一个 Python 环境。它不进行付费调用、不加载识别模型；静态检查通过后仍应发送一条短语音验证日志中出现「本地语音转写成功」。

安装步骤：仓库根目录运行 `python install-features.py`，看到「是否安装 QQ 语音转写功能？」时按需选 y。安装前会逐项解释用途：

| 安装项 | 用途 |
| --- | --- |
| sherpa-onnx | CPU 上运行识别模型 |
| Paraformer 中英 INT8 模型及 tokens | 将中文、英文声音识别成文字 |
| pilk | 解码 QQ 专用的 SILK 语音 |
| imageio-ffmpeg / FFmpeg | 将音频转成识别所需的 16 kHz 单声道格式 |

该选项使用后端 `qq-asr` 可选依赖，仅下载三个识别模型文件，不下载 TTS 音色；依赖装在后端环境，不修改系统 PATH。优先使用系统 FFmpeg，否则使用 imageio-ffmpeg 提供的可执行文件；受支持平台的发行轮子包含该文件，特殊平台若未提供则仍需手动安装。完成后重启小家。若同时选择完整本地语音，复用识别模型，额外下载音色；已有非空模型文件跳过。安装需联网，识别在本地，不会自动启用云端 ASR 或更改桥设置。仅安装 ONNX 运行库不等于拥有 Paraformer 模型，桌宠能说话也不代表能识别语音。

QQ 桥「声音」选择 QQ 转写、本地 Paraformer 兜底；若希望直接在本地识别，可选择本地识别引擎，省去等待网关转写。不要为了排错自动改成云端 ASR，上传音频需要用户自行选择。仍失败时保存日志中的阶段：网关没有文字 / 音频下载失败 / 缺少本地组件 / SILK 解码失败 / 识别为空，各阶段需分别排查。

| 组件 | 用途 | 本次安装内容 |
| --- | --- | --- |
| TTS（文字转语音） | 把角色回复读出来 | Piper 运行依赖与华燕中文音色 |
| ASR（语音转文字） | 识别你说的话，供语音通话及本地语音识别使用 | sherpa-onnx、Paraformer 中英 INT8 模型 |

无需独立显卡；需要下载数百 MB 文件并占用本地磁盘和 CPU。安装和下载需要联网，安装后识别与合成在本地运行；聊天模型仍使用你配置的服务，不代表整个聊天流程离线。只用文字聊天不需要此组件，已有云端语音服务也可继续使用。

安装器在 `backend/` 执行 `uv sync --locked --inexact --extra local-voice --python 3.11`，保留环境内已安装的其他可选依赖。模型来自各自公开仓库：

- [Paraformer 中英模型](https://huggingface.co/csukuangfj/sherpa-onnx-streaming-paraformer-bilingual-zh-en)：下载 `tokens.txt`、`encoder.int8.onnx`、`decoder.int8.onnx` 到 `backend/data/asr/paraformer-zh-en/`。
- [Piper 音色](https://huggingface.co/rhasspy/piper-voices/tree/main/zh/zh_CN/huayan/medium)：下载 `zh_CN-huayan-medium.onnx` 及同名 `.onnx.json` 到 `backend/data/tts/piper/`。

默认从 Hugging Face 下载。访问不通时可将环境变量 `VOICE_MODEL_MIRROR` 设置为自己使用的兼容镜像根地址，再重新运行安装器。下载失败不会将未完成文件当成模型，重新运行可补齐缺少的文件。

完成后重启后端：朗读选择 **Piper / 华燕**，持续通话选择 **本地 Paraformer / Piper**，并允许浏览器使用麦克风。识别模型支持中文、英文，本次安装的朗读音色为中文。更多配置见[语音通话说明](../voice-call.md)。
