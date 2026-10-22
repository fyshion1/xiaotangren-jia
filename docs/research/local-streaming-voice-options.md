# 本地连续语音方案评估与试跑

2026-10-20。目标：减少 ASR/TTS 服务费用，保留百炼、Soniox、Fish Audio 入口；复用现有语音通话的会话、记忆、打断与播放确认。聊天模型费用不受本地语音切换影响。

## 候选

| 环节 | 候选 | 流式含义 | 本机取舍 |
| --- | --- | --- | --- |
| ASR | sherpa-onnx Zipformer 中英 INT8 | 输入音频持续解码，返回 partial；静音端点触发 final | 已对照，同一句合成音频有较多重复字 |
| ASR | sherpa-onnx Paraformer streaming | 原生在线模型，中文优先 | **首轮选择**；同一测试样本识别较准，走 CPU |
| ASR | SenseVoice Small + VAD | 句末短音频块识别，原版非持续解码 | 适合二次校正，不作为首轮打断信号 |
| TTS | Piper | 句子内可逐块传输合成结果，通常仍要先得到足够文本 | 已有三个中文模型，低资源保底，音色较机械 |
| TTS | CosyVoice 2/3 | `stream=True` 逐块出 PCM，支持文本与音频双流 | 音质优先试验；独立进程，Windows 依赖及 4GB 显存需实测 |
| TTS | Kokoro 82M | 常按文本片段合成输出；不等于句内原生流式 | 轻量音质备选，中文效果需实际试听 |
| TTS | Qwen3-TTS 0.6B | 模型支持流式；部署接口必须提供音频块 | 音质对照，先确认 Windows/4GB 稳定性 |

不能把“HTTP 分块传输完整 WAV”算作流式生成。现有通话本来按句触发 TTS、PCM 分块播放；这次本地适配继续使用同一套回合编号、打断和播放确认。Piper 当前 `/api/voice/tts` 完整 WAV 接口仍可供普通朗读，通话专用路径直接输出 PCM。

## 首轮实现

- 本地识别：sherpa-onnx、[Paraformer 中英 INT8 权重](https://huggingface.co/csukuangfj/sherpa-onnx-streaming-paraformer-bilingual-zh-en)，浏览器仍发送 16 kHz PCM；后端在线解码、端点检测。权重放在 `backend/data/asr/paraformer-zh-en/`，不提交到仓库。[Zipformer 对照模型](https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20)也保存在本机 `backend/data/asr/zipformer-zh-en/`。
- 本地合成：已有 Piper 华燕/小雅/超文音色；按合成块发 PCM，浏览器按返回采样率播放。
- CosyVoice：对接 `backend/tools/cosyvoice_sft_sidecar.py` 的本机 `127.0.0.1:50000/inference_sft_stream`，该服务显式传 `stream=True`，并在启动时校验 **CosyVoice-300M-SFT 的 22050 Hz**。官方示例 `/inference_sft` 默认 `stream=False`，虽使用 StreamingResponse，但不能算句内流式；CosyVoice 2/3 默认模型的接口和采样率不同，需另接适配器。没有启动服务或真实模型前，不算 CosyVoice 运行验证。
- 云端 ASR、Fish TTS 保持独立选项，可混搭。服务端对本地音色采用白名单；CosyVoice 地址固定回环，不接受浏览器传入 URL。

本机安装：`cd backend; uv sync --extra local-voice`。模型文件名固定为 `encoder.int8.onnx`、`decoder.int8.onnx`、`tokens.txt`。部署到其他机器需单独下载权重；未安装时面板不显示本地识别。

## 这台机器的离线试跑

- 采用 Piper 华燕生成“你好，我是小糖人，今天想和你聊天。”，经 ffmpeg 转成 16 kHz PCM，按 100 ms 分包喂给模型。Zipformer 在 CPU 上加载约 **4.2 秒**，final 为“你好我是小唐唐唐人人今天天想和你聊天天”；Paraformer 加载约 **2.4 秒**，补足句末静音后的 final 为“你好我是小唐人今天想和你聊天”。仍需真人语音验证口音、噪声和误触发。
- Piper 同句约 3.5 秒语音：冷加载首块约 **2.4～3.1 秒**；模型已加载时首块约 **0.1 秒**，完整合成约 **0.2 秒**。通话接通时预热音色，避免首轮承担加载时间。
- 上述不涉及聊天 API，也没有真实麦克风、扬声器、外放回声或 CosyVoice 模型性能结果。

可重复测试：从 `backend/` 执行 `.venv/Scripts/python.exe tools/benchmark_local_voice.py`。该脚本按真实时间每 100 ms 喂一包 PCM；一次记录为音频长 3.09 秒、首个 partial 在 0.70 秒、final 在 4.62 秒（约在输入音频结束后 1.53 秒）。Piper 热运行首块 0.197 秒。硬件同时有其他任务时结果会变化，这些是局部阶段计时，不能相加就称为完整通话时延。

独立 CosyVoice 试验环境放在 `D:\ai+2d+3d+unity+vrchat\.local-voice\`，避免 C 盘剩余空间不足；小窝代码和本报告仍在本项目。官方 requirements 使用多个包源，uv 默认优先级会导致 onnxruntime==1.18.0 解析失败，试验时使用 `--index-strategy unsafe-best-match` 后解析通过；不改小窝后端的解释器或依赖版本。

## 本轮验收状态

Paraformer + Piper 已接入通话面板，保留收费服务选项。后端 15 项语音离线测试、前端 2 项语音测试、生产构建和浏览器语音流程测试通过；未调用付费模型。浏览器测试使用虚拟麦克风及模拟回复，不能代替真人试听。

后续续测：CosyVoice-300M-SFT 独立依赖已安装，使用 PyTorch 2.3.1+cu121、Python 3.10 和 `--fp16`，服务在本机 50000 端口运行。旧 openai-whisper 构建缺少 pkg_resources，通过独立环境安装 setuptools<81、wheel，再用 --no-build-isolation 解决。没有更改小窝后端依赖。

实测中文女声：短句首包约 4.23～8.97 秒（4.23 秒为充分预热后的再次测试），输出约 1.25～1.95 秒语音。虽然调用 stream=True，但这几条短句模型实际只 yield 一块，HTTP 网络分包不能算多块推理；当前不适合实时通话。启动后显卡总占用约 2.5 GB（含桌面及其他程序，非模型独占/峰值）。生成的 PCM 非静音，但尚未试听确认音质；文本规范化 wetext 的额外资源下载遭遇 ModelScope 403，当前回退到基础文本处理，数字等朗读未验证。Piper 继续作为默认，CosyVoice 作为手动可选对照。

面板会从 sidecar `/speakers` 读取实际音色列表，关闭并重新打开通话面板刷新；服务停止后不显示 CosyVoice。重启电脑后需用独立环境重新启动 `backend/tools/cosyvoice_sft_sidecar.py`，传入上述模型目录、源码目录及 `--fp16`。

## 待测指标

真实麦克风和扬声器下记录：开口到首个 partial、停顿到 final、文本首句到首块 PCM、打断到静音、CPU/内存/显存占用；中文、英文、混说、外放回声各测多轮。官方宣传的 97/150 ms 数字不能套到这台 i5-13500H/RTX 3050 Laptop 4GB 上。不得用离线单句合成速度代替整条通话延迟。

参考：[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)、[CosyVoice](https://github.com/FunAudioLLM/CosyVoice)、[Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS)、[Kokoro](https://github.com/hexgrad/kokoro)、[SenseVoice](https://github.com/FunAudioLLM/SenseVoice)。

## 2026-10-20 续测：句内衔接与 Kokoro

CosyVoice-300M-SFT 在这台电脑上生成约 9.08 秒语音耗时 28.72 秒；音频约在 9.3、15.2、21.3、26.7、28.7 秒抵达，块间有 5～6 秒等待。此前浏览器只提前排队 60 ms，无法掩盖生成速度不足。通话面板现提供 CosyVoice 的 **平滑播放**（默认，等单句合成结束后一次排队播放）与 **边生成边播** 两种方式。前者减轻句内卡顿，代价是首声等待更久；句间仍可能停顿。两者沿用原有播放确认和打断，平滑模式限制单句缓存至两分钟 PCM。状态会在真正收到首块 PCM 时才显示“正在说”。

Kokoro-onnx 0.6.1 另装在 `D:\ai+2d+3d+unity+vrchat\.local-voice\kokoro-venv`，中文 v1.1 权重和音色保存在同目录 `kokoro` 下，原 CosyVoice 环境及权重均未删除。使用 `misaki-fork[zh]`、CPU ONNX Runtime、本机 i5-13500H；模型与 G2P 冷加载合计约 7.6 秒。官方 INT8 权重虽通过 SHA-256 校验，但 ONNX Runtime CPU 对其中 `ConvInteger` 节点报 `NOT_IMPLEMENTED`，保留文件供后续 GPU/运行时对照。官方 FP16 权重在 CPU 上能正常合成，SHA-256 与发布页一致。

| 中文女声 | 句子 | 合成耗时 | 音频时长 | 实时率 | 本地试听文件 |
| --- | --- | ---: | ---: | ---: | --- |
| `zf_001` | 你好，我是小糖人，今天想和你聊天。 | 2.83 s | 3.66 s | 0.77 | `kokoro/zf_001-0.wav` |
| `zf_001` | 今天有点累，不过和你说说话就好多了。 | 2.08 s | 3.94 s | 0.53 | `kokoro/zf_001-1.wav` |
| `zf_002` | 第一、二句 | 2.21 / 2.14 s | 4.04 / 4.44 s | 0.55 / 0.48 | `kokoro/zf_002-0.wav`、`zf_002-1.wav` |

这些是整句生成耗时，**不是首包延迟**；Kokoro 尚未接入通话，需要先试听音色。其官方 `create_stream` 是按文本分段合成，不能仅凭接口名称认定句内真流式。按实测实时率，热运行的单句连续播放比本机 CosyVoice 更有希望。对照脚本为 `D:\ai+2d+3d+unity+vrchat\.local-voice\benchmark_kokoro.py`。

Qwen3-TTS 0.6B CustomVoice 官方提供中文女声 Vivian、Serena，也宣称流式，但官方常用 Python 示例返回整段数组；当前尚未在这台 4 GB 显卡电脑上安装或测量，因此不填写性能或听感结论。下一轮应先听 Kokoro 样本，再决定是否将其做成独立 sidecar 接入通话；Qwen3-TTS 另做资源占用对照。三者权重均不会提交到小窝仓库。[Kokoro-onnx 发布页](https://github.com/thewh1teagle/kokoro-onnx/releases)、[Qwen3-TTS 官方仓库](https://github.com/QwenLM/Qwen3-TTS)。

## 2026-10-21：桌宠语音和 Kokoro 接入

Kokoro 已通过 `backend/tools/kokoro_sidecar.py` 接入现有通话协议，固定使用回环地址 50001、24000Hz PCM。网页通话面板可选择四个中文女声音色；桌宠本地通话优先选择已就绪的 Kokoro。首次接入请求“你好，我是桌边的小糖人。”返回 121696 字节 PCM，耗时 3.11 秒，约 2.54 秒语音。采用整句生成后播放，支持原有打断/播放确认，不能称为句内原生流式。

桌宠 ● 为点击录文字，再点取消；识别结果追加到草稿，不自动发送。3 秒无输入自动取消，结合连续 200ms 的 PCM 能量和 ASR 文本识别开口，避免单纯等待 partial 导致误取消。☎ 为通话，沿用选定私聊/群聊与记忆；关闭气泡、隐藏窗口和切换会话时释放麦克风。录文字不调用聊天或 TTS，桌宠不会自动回退到付费语音。

验收：后端语音 22 项测试、桌宠 6 项测试、前后端生产构建通过；真实 Electron 普通/DPR2 使用虚拟麦克风验证 PCM 跨 IPC/WebSocket、3 秒静音取消、转写追加草稿、Kokoro 通话配置和再次点击取消。截图已检查；不等同于真人麦克风、外放回声或完整聊天模型延迟实测。

Kokoro 服务当前已启动。重启机器后，在项目目录使用 D 盘环境运行：

```powershell
& 'D:\ai+2d+3d+unity+vrchat\.local-voice\kokoro-venv\Scripts\python.exe' backend/tools/kokoro_sidecar.py --model-dir 'D:\ai+2d+3d+unity+vrchat\.local-voice\kokoro'
```

Qwen3-TTS 使用独立 `qwen3-tts-venv`，模型在 `qwen3-tts-0.6b-customvoice`，均位于上述 D 盘 `.local-voice`。官方 qwen-tts 0.1.1、PyTorch 2.7.1+cu128、SDPA；跳过仅供 demo 使用的 Gradio，未修改小窝或 CosyVoice 环境。0.6B 支持固定音色，官方表格明确不支持 1.7B 的自然语言语气指令。对照脚本为 `.local-voice/benchmark_qwen3.py`，生成完整 WAV 的时间不能当作首包延迟。

Qwen 实测：FP16/SDPA 首次生成触发 CUDA 概率断言，换 BF16/SDPA 后成功，无需删除或重下载模型。BF16 冷加载 5.90 秒；文本“你好，今天想和你聊聊天。”结果如下。当前官方 Python 接口返回整段数组，没有得到句内首包时间。

| 音色 | 生成耗时 | 音频时长 | 实时率 | 模型峰值分配显存 | 试听文件（D 盘 `.local-voice`） |
| --- | ---: | ---: | ---: | ---: | --- |
| Vivian | 19.14s | 3.20s | 5.98 | 2159MiB | `qwen3-Vivian-cuda-0.wav` |
| Serena | 15.80s | 2.72s | 5.81 | 2145MiB | `qwen3-Serena-cuda-0.wav` |

测试时其他桌面程序和 CosyVoice 仍在运行，显卡总占用约 3.57GB；表中是 PyTorch 进程自身分配峰值，不是整机显存峰值。两份音频已保存，尚未由用户试听评价音色。当前配置下 Qwen 生成明显慢于播放，仅保留音质对照，不自动切换通话默认。SoX 命令缺失提示不阻止本次固定音色生成，参考音频处理未验证。结果 JSON 为 `.local-voice/qwen3-benchmark.json`。
