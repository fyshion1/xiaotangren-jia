# 小糖人唱歌：现成方案与训练路线

调研日期：2026-10-21。当前为资料评估，未安装或实测新的唱歌模型；本机为 RTX 3050 Laptop 4GB。以下显存支持来自项目说明，不代表本机速度保证。

## 结论

已有成熟轮子，不需要从零训练。第一步建议 Seed-VC 零样本歌声音色转换；若希望长期固定音色，再比较 RVC/Applio 训练。原创歌曲生成是另一条路线，可后续考虑 ACE-Step。现有 ASR、Kokoro、CosyVoice 通话链路继续承担说话，不应把普通 TTS 当作可控歌声合成。

## 三类能力

| 能力 | 输入与输出 | 适合用途 |
| --- | --- | --- |
| 歌曲生成 | 歌词、风格 → 人声与伴奏 | 即兴创作一首歌，但未必保持角色音色 |
| SVC 歌声音色转换 | 源唱人声、目标音色 → 目标声线演唱 | 最快实现“她用自己的声音唱” |
| SVS 歌声合成 | 歌词、旋律/MIDI、声库 → 歌声 | 精确指定音符，准备成本更高 |

## 方案对比

| 项目 | 能做什么 | 训练与本机适配 | 许可注意 |
| --- | --- | --- | --- |
| [Seed-VC](https://github.com/Plachtaa/seed-vc) | 零样本歌声音色转换，44.1k F0 条件模型 | 官方支持 1–30 秒目标说话参考；先不训练即可试。官方性能测试含 3060 Laptop，4GB 本机需另测 | GPL-3.0，先保持独立实验环境；发布时另核对代码与权重 |
| [RVC](https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI) | 成熟的歌声转换和固定音色训练 | README 推荐至少约 10 分钟低噪音频；建议准备 10–20 分钟干净参考，再测小批次训练显存 | MIT；第三方模型许可分别核对 |
| [Applio](https://github.com/IAHispano/Applio) | 更易用的 RVC 工作流 | 适合整理数据、训练、试听，产品端仍应调用独立服务 | MIT；模型另计 |
| [DiffSinger](https://github.com/openvpi/DiffSinger) | 真正的歌词+旋律歌声合成 | 需声库及曲谱工作流；不作为首轮 | Apache-2.0；声库另计 |
| [ACE-Step 1.5](https://github.com/ace-step/ACE-Step-1.5) | 生成原创歌曲，有 API 工作流 | 官方 ≤4GB 档使用 INT8、CPU/DiT offload、不启用 LM；只按离线等待任务评估 | MIT；权重、素材另核对 |
| [so-vits-svc](https://github.com/svc-develop-team/so-vits-svc) | 歌声音色转换 | 有成熟生态，但本项目已有更合适候选 | AGPL-3.0 |

ACE-Step 低显存依据：[GPU_COMPATIBILITY.md](https://github.com/ace-step/ACE-Step-1.5/blob/main/docs/en/GPU_COMPATIBILITY.md)。其中分钟数为支持的音频长度配置，不是生成耗时，不能据此推算实时速度。

## Fish 与豆包

[Fish S2](https://fish.audio/s2/) 的资料包含 singing 等表达标签，但表达性 TTS 不等于可指定旋律、节奏、音准的完整歌曲生成。可以以后用保留的收费入口测短句唱腔，不适合作为当前低成本本地主路线。其许可应按具体模型版本和官方 Research License 核对，不能因为权重可下载就按 MIT 使用。

[Seed-Music](https://seed.bytedance.com/en/seed-music) 展示了音乐生成、音符级编辑和参考音频歌声转换能力。但豆包 App 演示不等于已有公开、可调用且适合本项目的同等 API；本轮未确认可直接接入的价格及接口。

## B站社区资料

- [Seed-VC 对比 RVC](https://www.bilibili.com/video/BV1tc1jYjEgS)：主观试听参考，不作为通用性能结论。
- [RVC 训练入门](https://www.bilibili.com/video/BV1FW4y1w7Rn)：可参考数据和训练流程。
- [实时 AI 翻唱演示](https://www.bilibili.com/video/BV1xvtU6DEjV)：社区使用案例；视频或网盘整合包不能替代可审计依赖。

B站视频说明生态存在，不代表本机可实时运行。优先采用上游仓库与官方模型，不直接运行不明整合包。

## 建议验证顺序

1. D 盘 `.local-voice` 下建立独立 Seed-VC 环境，缓存也落 D 盘，不改已有语音环境。
2. 用一段自制或可用的 10–15 秒清唱，加现有角色音色参考，先测零样本转换。需源唱；它不能只凭歌词作曲。
3. 测量加载时间、生成耗时、峰值显存、音高保持、咬字和音色相似度。先低步数验证，再按官方建议 30–50 steps 比较质量。
4. 效果不足时，再用有使用权的干净目标音频比较 RVC 训练；先验证数据质量和短样本，不从零训练基础模型。
5. 若需要原创歌，再单独测试 ACE-Step，之后可将人声交给 SVC 统一音色。两者叠加会增加耗时和失真，不能预先保证效果。

## 产品接入边界

唱歌作为异步任务：排队、生成、成功后出现歌曲卡片，用户点击才播放，遵守现有不自动外放的设置。失败明确提示；大脑不能仅凭文字回复声称音频已经生成。角色、私聊/群聊和记忆复用现有契约，模型推理放独立进程，避免阻塞 ASR/TTS 通话。首轮不改桌宠，也不调用付费生成。
