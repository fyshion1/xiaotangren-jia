# 记忆评测 v0.1

这是独立的本地评测入口，不改应用接口、不启动真实服务、不依赖语音。所有案例均为人工编写的合成资料。

## 当前范围

`cases.json` 共 30 条案例，明确分成两组：

- O01～O18：真实调用生产记忆服务，在每案例独立的临时 SQLite 和文件目录中检查审核、身份与角色范围、停用、关键词召回、人工纠正及注入脱敏。
- S01～S12：模型语义案例，覆盖助手臆测、单方面约定、缺失图片、纠正、假设、事件归类、情绪转折、第三人、提示注入、寒暄与证据编号。当前只提供输入和人工评分准则，没有模型输出，不算通过。

离线运行没有 mock 被测审核、过滤、检索函数。只替换存储路径、embedding 配置和 embedding 生成，强制使用真实关键词降级路径，并禁止网络连接。它不能证明语义向量检索效果、真实模型提炼效果、HTTP 登录鉴权或完整每日整理链路的质量。身份过滤评测也不是公共版用户认证测试。

## 运行

从仓库根目录执行：

```powershell
.\backend\.venv\Scripts\python.exe evals/memory/run.py --export-prompts
```

不读取私人聊天，不读取实际模型密钥，不调用模型；不会加载本地向量模型。生产模块中的初始化只针对临时目录执行，不导入 `app.main`。每次结果写入全新的 `runs/<UTC时间>/`：

- `report.json`：输入、预期、实际注入结果、逐条原因、耗时、数据集版本与哈希、执行器哈希、源码哈希、Git 提交与工作区状态。
- `report.md`：人读摘要，明确区分 pass / fail / error / not_run。
- `semantic-prompts.json`：使用当前生产提炼提示词导出的合成语义案例；包含提示词哈希，供将来实际模型评测使用。导出不等于已经验证与每日整理的完整请求格式完全一致。

返回码：0 表示执行的离线案例通过且被测源码在运行期间未变化；1 表示失败、执行错误或被测文件发生变化。12 条 not_run 不会阻止离线 CI，但报告始终标记 `release_gate=not_assessed`，不能据此批准发布。

```powershell
# 数据集或报告可以使用其他位置；CI 可放到临时目录
.\backend\.venv\Scripts\python.exe evals/memory/run.py --dataset evals/memory/cases.json --output evals/memory/runs
```

`--dataset` 只接受自己信任的本地案例。结果会保存案例内容；不要将私人资料填入后直接提交或上传 CI。Git 状态可能暴露本机文件名，公开报告前也要检查。

## 未来真实模型评测与人工复核

下一轮使用独立、显式触发的模型运行器；默认不连接现有服务或读取现有密钥。设置模型、最大案例数、单次 token 上限、超时、最大尝试次数与费用预算，保留原始输出及错误，不能把失败请求当作空记忆通过。预算只能按定价和用量估算时，应说明其限度。

逐条按 `rubric` 人工判断：每条记录模型/供应商、参数、提示词哈希、输出、每项准则的通过/失败、判断依据及审核人。空输出不能自动通过负面案例；先核对协议，再核对该保留的事实有没有丢失。来源编号属于可程序校验项；事实忠实度、主体归属、双方约定仍需人工判断。任何准则未审核，该条保持未评定。初期不采用 LLM 自动评分。

不把 O 组工程通过率和 S 组语义通过率相加平均。身份或未审核泄漏等关键案例出现失败，应单独阻断对应工程门槛；真实模型完成前不设产品上线结论。

## 回归与修复约定

先保存基线，再修复问题；同一数据集和执行条件下对比结果。新增反例时升级数据集版本并说明理由，不通过删改失败预期来美化分数。冻结的合成基线可以进入 Git；后续大量运行结果只保留有意义的对比版本，私人运行结果另行存放。

当前报告里的源码哈希用于识别未提交改动，不能代替完整源码快照。并行语音开发不由本评测验证；工作区有修改时，不能单凭 HEAD 重现运行。

## 当前基线

2026-10-19 基线：[运行摘要](runs/20261019T020457691378Z/report.md)、[完整记录](runs/20261019T020457691378Z/report.json)。18 条离线工程场景通过；12 条语义场景未运行。执行记录与后续路径见 `docs/evaluations/记忆评测第一轮留档.md`。

## 真实模型试跑与评分工具（已实现）

```powershell
# 默认只准备 3 条；清洗、时间和消息格式复用生产实现，不发请求
.\backend\.venv\Scripts\python.exe evals/memory/semantic.py prepare --limit 3

# 将 EVAL_API_KEY 放入当前进程环境，不在命令参数或配置文件中写密钥
# 显式执行；config 需填写价格和预算，示例中的 null 会被拒绝
.\backend\.venv\Scripts\python.exe evals/memory/semantic.py run --plan <plan.json路径> --config <配置文件路径> --execute

# 将 review-template.json 复制后填写 reviewer、逐项 verdict(pass/fail) 与 evidence
.\backend\.venv\Scripts\python.exe evals/memory/semantic.py review --results <results.json路径> --judgments <评分文件路径>

.\backend\.venv\Scripts\python.exe -m unittest discover -s evals/memory/tests -v
```

默认不读取现有密钥；只有显式 `--backend-env` 才读取 backend/.env 的 MODEL_*。本次用户另给专用 key，没有使用日常 key。配置不含密钥，报告只保存端点主机、白名单配置、用量、输出和错误分类。模型若回显当前 key 会被替换。运行目录仍可能含供应商信息，公开前需检查。

每条只有一次请求，最多 12 条；默认输出 1024 tokens、超时 45 秒。请求前预留估算费用，预算不足不发送；用量缺失或超过假设、请求失败、截断或协议错误会停止后续请求。不自动续跑或重试，超时可能已产生费用。估算使用 UTF-8 字节加余量近似输入 token，按配置单价预留，不能保证供应商 tokenizer、推理 token、分组倍率或实际账单一致；供应商侧额度限制才是更可靠的硬上限。

输入仅覆盖无历史事件、单批纯文本；不调用完整每日编排。预期答案和评分准则不发送给模型。结果先为 needs_review；空 memories 也不能自动获得语义通过。评分与结果哈希绑定，未完成所有准则就保持未评，评分人身份不由工具认证。`semantic_pass` 代表该评分文件的判断，不代表独立人类审查或产品上线许可。

第一次真实试跑：[原始结果](model-runs/20261019T021557779118Z/results.json)。S01～S03 返回成功，编码助手逐项复核通过；其余 9 条未运行。用户尚可用原始模板独立复核，不能把这 3 条推广为整个记忆系统已可靠。

后续已完成 S04～S12：[原始结果](model-runs/20261019T022014601442Z/results.json)、[逐项评分](model-runs/20261019T022014601442Z/review-20261019T022156525539Z/review.md)。两轮合计 12 条均经编码助手复核通过，并非独立人类评审或重复稳定性实验；全量留档见 `docs/evaluations/记忆语义评测完整基线留档.md`。

## 每日整理链路回放

```powershell
.\backend\.venv\Scripts\python.exe evals/memory/workflow.py
```

使用已留档真实输出 S01、S06、S11，在临时目录执行真实每日整理、归档、审核、关键词召回、停用和人工版本保护。模型边界回放，覆盖保护阶段使用固定主题的冲突输出；不发网络请求，不产生新费用。当前 [报告](workflow-runs/20261019T022927741640Z/report.json) 3 条场景通过。早期执行器错误与修复经过、跨批次及主题漂移等未覆盖项见 `docs/evaluations/记忆链路回放评测留档.md`。

## 主题漂移反例

```powershell
.\backend\.venv\Scripts\python.exe evals/memory/topic_drift.py
```

当前 [报告](topic-drift-runs/20261019T024657297060Z/report.md)：1 条同主题对照通过、2 条更名主题场景失败。命令返回 1，以保留“新增矛盾待审核候选”的真实反例。人工版本未被覆盖，未审核条目没有注入。受控冲突输出不代表实际模型失败率，分析与修复边界见 `docs/evaluations/记忆主题漂移反例留档.md`。

## 后续集成与浏览器验证

`backend/tests/test_memory_followup.py` 新增 4 条隔离集成测试，涵盖 API 关联响应、多事件保留、跨日事件与人工替代流程。前端 `tests/memory-workflow.mjs` 已加入关联展开检查，Chrome 实跑通过，全部 API mock。日志、5 张截图及验证摘要在 `validations/20261019T025649547463Z/`；完整缺口与阶段交接见 `docs/evaluations/记忆后续测试与阶段交接.md`。
