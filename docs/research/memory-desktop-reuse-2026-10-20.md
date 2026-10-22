# 记忆与桌宠：开源复用调研

调研日期：2026-10-20。范围：读取本项目文档、依赖和服务目录，并在线读取下列仓库当前 README、部分源码与目录。未部署第三方项目，未验证其中文记忆准确率、延迟或长期稳定性。成熟度判断依据公开实现和工程入口，不以演示效果或作者榜单代替实测。

## 结论与推荐顺序

1. 桌宠优先研究 AIRI，先接一个独立嘴型驱动，再研究模型加载、释放与动画状态。现有 Electron 壳无需整体替换。
2. 记忆优先用 Hindsight 做独立对照，其次对照 Mem0。用本项目已有反例测试，确认收益后再决定接 SDK、独立服务还是仅移植算法。
3. 当前最具体的记忆缺口是事实纠正与历史有效期，优先研究 Graphiti 的时间模型。MemOS 本地核心适合参考运行经历、混合检索、后台处理和观测界面。
4. 角色权限、人工审核、多端共享会话继续由本体负责；第三方记忆引擎的用户 ID、bank 或 namespace 不能直接当成完整授权机制。

## 本项目已有基础

- FastAPI / Python + SQLite；记忆已有提炼、日事件、来源、关联、审核、身份隔离和评测。既有交接说明跨日纠正仍需人工暂停旧事实，主题漂移仍有反例。
- 独立 Electron 桌宠已有透明窗口、像素穿透、停靠、Live2D/VRM、流式聊天、音频能量嘴型，并与本体共享普通会话和记忆。
- 因此最有价值的复用是检索排序、事实生命周期、模型动作与资源管理，而不是再造一套存聊天记录或透明窗口。

## 桌宠候选

| 项目 | 已核实的基础 | 建议复用 | 接入代价与边界 |
| --- | --- | --- | --- |
| [AIRI](https://github.com/moeru-ai/airi) | Electron 桌面端、Live2D/VRM，仓库拆出模型驱动和渲染包；MIT | 嘴型、动画驱动、模型生命周期、桌面窗口管理 | 最贴近现有方向，但大量 UI 依赖 Vue，不宜把 Vue 页面直接搬进 React；README 的长期记忆仍标 WIP |
| [Open-LLM-VTuber](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber) | Python 后端、透明桌宠、触摸、情绪到 Live2D 表情映射、主动说话、语音打断；主项目 MIT | 表情动作协议、对话与播放状态同步，作为完整交互体验对照 | 当前 README 明确长期记忆暂时下线；v2 正在规划重写。前端独立仓库应另外检查版本与许可 |
| [VPet](https://github.com/LorisYounger/VPet) | Steam 产品、WPF 核心可引用、插件与创意工坊，代码 Apache-2.0 | 空闲/工作/互动行为状态机，动作切换，插件组织 | C#/WPF 与现有 Electron 不同，适合借鉴行为设计；不是可直接装入 React 的 Live2D SDK |
| [Eidolon-SC](https://github.com/Sallyn0225/eidolon-sc) | 通话角色表现、共享记忆来源归属；AGPL-3.0-or-later | 角色表演、字幕/语音/动作协同和转述来源 | 主要是网页通话角色，不能当桌面窗口管理库；源码复用与独立素材许可需分开考虑 |

### AIRI 最值得先看的位置

- [model-driver-lipsync](https://github.com/moeru-ai/airi/tree/main/packages/model-driver-lipsync)：README 明确提供无 Vue、Three.js、VRM 依赖的共享元音驱动。`shared/wlipsync` 把 AEIOUS 输入转换为平滑 AEIOU 权重，含静音检测和主元音选择；`runtime/wlipsync` 创建浏览器音频节点。
- 它不会自动把权重写入 VRM；各渲染器自己映射表情。现有 AudioContext 可接音频分析，先只替换“音量越大嘴越张开”，保留现有播放/打断逻辑。仍需检查工作区包依赖、WASM/配置资产和构建兼容，不能保证直接 npm 安装即可。
- [stage-ui-live2d](https://github.com/moeru-ai/airi/tree/main/packages/stage-ui-live2d)、[stage-ui-three](https://github.com/moeru-ai/airi/tree/main/packages/stage-ui-three)：模型加载、动画和卸载路径的参考入口；Vue UI 与纯驱动分开评估。
- [桌面主进程窗口目录](https://github.com/moeru-ai/airi/tree/main/apps/stage-tamagotchi/src/main/windows)：研究窗口拆分与生命周期，不据目录名称推断所有功能已经稳定。
- 官方有 [VRM 生命周期、缓存与可观测性开发记录](https://airi.moeru.ai/docs/en/blog/DevLog-2026.03.14/)，适合结合现有反复切换 Live2D/VRM 的测试阅读。

## 记忆候选

| 项目 | 最值得复用的逻辑 | 对本项目的适配判断 | 已知成本 |
| --- | --- | --- | --- |
| [Hindsight](https://github.com/vectorize-io/hindsight) | retain / recall / reflect；事实、经历、证据支撑的观察和 mental models；语义/关键词/图/时间召回，再融合重排 | 最值得做完整记忆后端对照，尤其适合“经历如何形成对用户的长期理解” | MIT；有 Python/TS SDK、HTTP 服务、可视化；默认方案使用 PostgreSQL 系列存储，并非替换一个 SQLite 函数；推理形成的理解要与原始事实分开 |
| [Mem0](https://github.com/mem0ai/mem0) | 事实抽取、作用域过滤、可配置嵌入/向量后端/重排 | 比较适合做轻量 SDK 对照，减少自己维护适配层 | Apache-2.0；当前 README 已描述 ADD-only 新路线，不能照搬旧教程的自动 UPDATE/DELETE 叙述；开源与托管功能应按具体版本区分 |
| [Graphiti](https://github.com/getzep/graphiti) | 时间事实、实体关系、来源 episode、旧事实失效但保留历史 | 最贴合跨日纠正和“以前/现在”的区别；可先借模型，再决定是否引入图库 | Apache-2.0；常见部署需要 Neo4j/FalkorDB，含额外抽取与实体消歧调用；Kuzu 当前已标弃用 |
| [MemOS](https://github.com/MemTensor/MemOS) | 主项目的可组合记忆、反馈修正；本地核心的检索、后台摄取、运行经历与 Viewer | 本地插件核心更接近 SQLite、本地优先，但尤其偏 Agent 行动学习，不能全部等同人物陪伴记忆 | Apache-2.0；完整自托管服务与本地插件是不同路线，前者有 Neo4j+Qdrant，后者为 TS 核心+SQLite，并非现成 FastAPI 插件 |
| [Eidolon-SC](https://github.com/Sallyn0225/eidolon-sc) | 记忆记录来源角色，其他角色以“听某某说”转述 | 在多角色家庭场景上比通用 RAG 更贴近，可借鉴来源与口吻 | 其默认跨角色共享策略不同于本项目权限要求；AGPL 代码不能按 MIT 代码的复用方式处理 |

### 推荐阅读入口

- Graphiti 的 [EntityEdge](https://github.com/getzep/graphiti/blob/main/graphiti_core/edges.py)：源码可见 `episodes`、`created_at`、`valid_at`、`invalid_at`、`expired_at`。记录时间、事实有效时间和失效处理应区分；例如“从今天开始不喝咖啡”不应删掉去年爱喝咖啡的经历，也不应把旧偏好继续当现状。
- Mem0 的 [memory/main.py](https://github.com/mem0ai/mem0/blob/main/mem0/memory/main.py) 和 [MemoryConfig](https://github.com/mem0ai/mem0/blob/main/mem0/configs/base.py)。README 的新提取路线与部分旧 API 注释并存，实施前固定版本并跟踪实际执行路径。
- MemOS [本地插件](https://github.com/MemTensor/MemOS/tree/main/apps/memos-local-plugin) 和 [ARCHITECTURE.md](https://github.com/MemTensor/MemOS/blob/main/apps/memos-local-plugin/ARCHITECTURE.md)：`core/storage` 为 SQLite/迁移/向量存储；`core/retrieval` 描述 RRF 融合与 MMR 多样性重排；架构文档明确向量存储当前采用 float32 BLOB 与暴力搜索，不是无限规模的向量索引。
- Hindsight README 的 Core Concepts、Memory Banks、Observations 与检索说明：先拿 recall 返回证据供现有组装器使用；不要直接用 reflect 的生成答案替代角色自己的对话引擎。

## B 站已检索到的内容

以下信息来自 B 站搜索返回的标题、作者与简介，未完整观看视频，也未独立复核视频里的效果与数字。部分请求被 412 拦截，不声称已穷尽搜索结果。

| 视频 | 用途 |
| --- | --- |
| [你的第一个 AI 桌宠！Project-AIRI 从零开始教程](https://www.bilibili.com/video/BV1HQdpBGEfU)，Paper朱 | 了解 AIRI 实际部署和桌宠使用流程；和当前源码版本对照 |
| [Open-LLM-VTuber v1.1.0 前端功能演示](https://www.bilibili.com/video/BV1rQAyeoEcZ)，timmm_ | 简介说明由前端作者/维护者录制；适合对照表情、通话、桌宠模式的交互 |
| [Open-LLM-VTuber v1.1.0 安装教学](https://www.bilibili.com/video/BV1tnPMeKEGx)，timmm_ | 观察部署路径，不把旧版本教程当当前维护状态 |
| [mem0 开源框架架构解析与实战](https://www.bilibili.com/video/BV1F7P9zLErb)，加菲大杂烩 | 简介包含源码拆解；提取与更新策略可能与当前版本不同 |
| [一口气搞懂 AI Agent 五种记忆架构 / SQLite / mem0 / Zep / LangMem 实测竞速](https://www.bilibili.com/video/BV1DabS6vEba)，肖恩君Sean | 建立选型维度，测试数字需核对其数据和环境 |
| [8 个 AI 记忆系统从夯到拉](https://www.bilibili.com/video/BV1hitC61ELN)，小行星AI观测站 | 简介覆盖 Hindsight、Mem0、Graphiti、MemOS 等；仅作线索，排名不作为本项目结论 |

## 最小落地路线

**桌宠第一步**：在独立 feature 中给现有播放链加可切换的 AEIOU 驱动，以相同音频比较 Live2D/VRM 嘴型、静音闭嘴和打断恢复。验收成功再评估动作状态映射。保留现有会话 API，不另建桌宠记忆库。

**记忆第一步**：从既有评测选出跨日纠正、同主题不同事件、无关召回、权限隔离、删除后不复活、多端经历和来源归属等案例；用合成或脱敏输入分别跑当前实现、Hindsight、Mem0。记录召回准确率、错误现状判断、跨身份泄漏、调用数、耗时与费用。作者榜单不能代替这个对照。

**记忆第二步**：若主要失败是现状/历史混淆，先借 Graphiti 有效期模型并保持人工审核；若主要失败是漏召回，优先改混合检索、融合与重排；只有独立后端在这些用例上有明确收益，才迁移存储。

本轮只新增研究资料，没有安装第三方依赖、运行安装脚本、改业务逻辑或迁移真实记忆。主项目 MIT/Apache 等代码许可不自动覆盖模型、动作、字体、声音或独立子仓库；实际复制时核对具体文件与依赖许可。
