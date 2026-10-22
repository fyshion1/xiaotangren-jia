# 文档导航与维护约定

本目录保存小糖人之家的功能说明、接口协议、方案、调研和工程留档。启动与安装先看[项目 README](../README.md)，本页负责文档导航和归档规则。

## 从哪里开始

- 使用或排查功能：查 `guides/`；接入外部功能：查 `integrations/`。
- 开发自主活动、沙盒和 QQ 接线：先看[沙盒系统地图](guides/sandbox-development-map.md)与[开发交接](evaluations/sandbox-development-handoff.md)，按问题定位函数。
- 理解私人使用、求职积累与未来公共版的关系：看[私人版工程改进与未来公共版路径](plans/私人版工程改进与未来公共版路径.md)。
- 继续记忆工程：先看[记忆后续测试与阶段交接](evaluations/记忆后续测试与阶段交接.md)，再按需回查各轮评测和反例；该交接记录只代表记录日期的状态。
- 了解发布与公开边界：看[发布与知识产权跟进](product/发布与知识产权跟进.md)。

## 分类索引

| 目录 | 用途 |
| --- | --- |
| [guides/](guides/) | 功能使用与排查：说明当前功能的使用方式、配置和排查步骤。 |
| [integrations/](integrations/) | 接入协议：外部功能、网关与共享记忆的接口约定。 |
| [plans/](plans/) | 方案与未来路径：设计、实施计划和阶段目标；放在这里不代表已经实现。 |
| [research/](research/) | 调研与探索：外部项目研究、技术比较与探索记录；不作为当前功能承诺。 |
| [evaluations/](evaluations/) | 评测与实施留档：已执行的测试、实施结果、失败反例和阶段交接。 |
| [product/](product/) | 发布与权属：产品发布、知识产权和公开范围的跟进。 |

### 功能使用与排查

- [card-html-preview](guides/card-html-preview.md)
- [聊天附件与视觉预算](guides/chat-media.md)
- [记忆与图片上下文排查（2026-10-19）](guides/memory-context-debug.md)
- [个人双库与每日事件记忆](guides/memory-workflow.md)
- [身份与长期记忆](guides/persona-memory.md)
- [默认篇幅与 QQ 双向同步](guides/qq-chat-sync.md)
- [一次性提醒](guides/reminders.md)
- [小工作室：项目、后台审批和隔离工作区](guides/exploration-workshop.md)
- [工具中心与聊天 Agent](guides/tool-agent.md)

### 接入协议

- [多端共享对话运行逻辑](integrations/shared-conversation-runtime.md)
- [features 共享活动契约](integrations/feature-memory-api.md)
- [通用游戏接入层](integrations/game-integration.md)
- [通用外设接入层（§9.6）](integrations/nest-integration.md)
- [QQ 网关（SnowLuma）· 摸出来的东西](integrations/qq-gateway-snowluma.md)

### 方案与未来路径

- [启动动画 + 主题设计 —— 调研与方案](plans/boot-and-theme-plan.md)
- [Electron 桌面聊天 MVP](plans/desktop-pet-mvp.md)
- [前端视觉迁移与布局说明](plans/frontend-visual-implementation.md)
- [媒体识别与 Google Takeout 导入方案](plans/media-import-plan.md)
- [多端并发与 features 共享记忆方案](plans/shared-memory-features-plan.md)
- [私人版工程改进与未来公共版路径](plans/私人版工程改进与未来公共版路径.md)

### 调研与探索

- [记忆架构与长篇角色扮演学习笔记（2026-10-21）](research/memory-architecture-and-roleplay-2026-10-21.md)
- [Dropline 口述整理逻辑调研（2026-10-20）](research/dropline-dictation-logic-2026-10-20.md)
- [Pipecat 实时语音逻辑调研（2026-10-20）](research/pipecat-voice-logic-2026-10-20.md)
- [AIRI 桌宠逻辑与 Eidolon-SC 记忆调研（2026-10-20）](research/desktop-pet-and-eidolon-memory-2026-10-20.md)
- [记忆与桌宠：开源复用调研（2026-10-20）](research/memory-desktop-reuse-2026-10-20.md)

- [小糖人怎么"到现实里玩"——调研笔记](research/ai-meets-reality.md)
- [Eidolon-SC：通话立绘、共享记忆与角色声音](research/eidolon-sc-character-memory-voice-research.md)
- [Eidolon-SC 的 ASR、TTS 与实时通话实现调研](research/eidolon-sc-voice-research.md)
- [QQ 自主活动：B 站首轮接入](research/qq-autonomous-exploration.md)

### 评测与实施留档

- [记忆主题漂移反例留档](evaluations/记忆主题漂移反例留档.md)
- [记忆关联审核提示实施留档](evaluations/记忆关联审核提示实施留档.md)
- [记忆后续测试与阶段交接](evaluations/记忆后续测试与阶段交接.md)
- [记忆评测第一轮留档](evaluations/记忆评测第一轮留档.md)
- [记忆语义评测完整基线留档](evaluations/记忆语义评测完整基线留档.md)
- [记忆语义评测试跑留档](evaluations/记忆语义评测试跑留档.md)
- [记忆链路回放评测留档](evaluations/记忆链路回放评测留档.md)

### 发布与权属

- [发布与知识产权跟进](product/发布与知识产权跟进.md)

## 保留原位的资料

- [语音通话说明](voice-call.md)、[语音接入方案](voice-call-integration-plan.md)：因其他对话正在开发语音，本轮保留原路径；分别按使用说明、方案阅读。后续协调后再归类。
- [桌宠评估报告](desktop-pet-review/评估报告.md)：与该目录内采集脚本、`evidence/` 一起保留，避免破坏证据定位。
- `card-preview-evidence/`、`tool-agent-evidence/`：功能验证的截图等证据，保留原路径。
- [主题演示](theme-demo.html)：可直接打开的视觉参考，不代表完整产品实现。
- [记忆评测入口](../evals/memory/README.md)：数据集、运行器及原始评测产物位于 `evals/memory/`，此处记录解读和交接，不复制原始结果。
- 根目录已有的临时交接 JSON 不属于长期文档，也不是项目状态的权威来源。

## 如何阅读状态

目录表示文档用途，不代表完成度。方案中的目标不等于已交付；一轮测试通过只适用于其声明的范围、环境和版本，不能推导未测项目也通过。

确认当前行为时，结合最新验证过的使用说明、接口约定和实际代码。文档与代码冲突时应核查并更新说明，不直接把历史计划当成现状。历史评测保留当时的结果、失败和限制，通过新记录补充后续结论，不覆盖旧证据。

## 新增与维护规则

1. 按主要用途放入上述分类；同一主题可以有使用说明、方案和评测记录，通过相对链接互相引用，避免复制成多份正文。
2. 新增、移动或更名文档时同步更新本页和引用方。链接以文档自身目录为基准；正文中标明的仓库路径（如 `backend/...`、`evals/...`）以仓库根目录为基准。
3. 方案注明日期、状态、范围和验收条件；实施或评测留档注明日期、版本或工作区状态、执行方式、结果、失败、跳过项及证据路径。后续变更注明更新时间。
4. 截图、日志等按功能或运行批次归档，与引用记录建立明确链接。不要把零散报告继续堆到 `docs/` 根目录；有配套脚本的证据目录迁移前先检查路径依赖。
5. 文档和样例使用合成或脱敏资料，不写入 API 密钥、私人聊天、个人身份资料或未经确认可公开的第三方内容。放进 `docs/` 不等于获准公开。
6. 并行开发中的文档先协调再移动；保留根目录例外时，在本页写明用途与原因。

本次整理日期：2026-10-19。移动清单与检查结果见[整理记录](reorganization-2026-10-19.json)。本次仅调整文档组织及引用，不改变应用功能。

兼容提示：应用源码的少量说明文字及 `features/` 独立仓库仍可能引用旧文档路径，本轮未修改这些源码和独立仓库。遇到旧路径可按整理记录的 `moves` 映射查找。本轮检查的 125 个本地 Markdown 链接均可定位；不含标题锚点和外部网址校验。
