# 记忆评测基线

数据集：memory-v0.1.0；提交：811a4ab73a65de18af9471dbfa60cb46214c644c

通过 18；失败 0；执行错误 0；未运行 12。

只评价工程过滤和关键词检索。未调用模型，不能证明记忆提炼、事实理解或语义向量检索质量；不计算混合总通过率，不构成发布许可。

运行期间变化的被测文件：无。工作区状态与源码哈希见 report.json。

| 案例 | 结果 | 原因 |
| --- | --- | --- |
| O01 未审核条目不得注入 | pass |  |
| O02 已批准且相关的记忆可以召回 | pass |  |
| O03 其他身份不得读取已批准记忆 | pass |  |
| O04 无身份不得注入私人资料 | pass |  |
| O05 个人记忆不向无关角色开放 | pass |  |
| O06 同一身份的共享记忆可以跨角色召回 | pass |  |
| O07 共享记忆仍不能跨用户身份读取 | pass |  |
| O08 拒绝的记忆不注入 | pass |  |
| O09 归档记忆不注入 | pass |  |
| O10 暂停约定不注入 | pass |  |
| O11 取消约定不注入 | pass |  |
| O12 过期约定不注入 | pass |  |
| O13 关闭注入开关后不再注入 | pass |  |
| O14 取消选择后不再注入 | pass |  |
| O15 普通记忆不因已批准就无关常驻 | pass |  |
| O16 核心记忆在无关查询下仍可常驻 | pass |  |
| O17 人工纠正后不再注入旧职位 | pass |  |
| O18 脱敏作用于注入副本 | pass |  |
| S01 助手提出计划不等于双方约定 | not_run | Requires real model output and human rubric review; not scored offline |
| S02 助手的安慰不能成为工作录用事实 | not_run | Requires real model output and human rubric review; not scored offline |
| S03 未提供图片不能凭助手口述补齐岗位 | not_run | Requires real model output and human rubric review; not scored offline |
| S04 事实更正应保留最新结论 | not_run | Requires real model output and human rubric review; not scored offline |
| S05 假设情景不是已发生事件 | not_run | Requires real model output and human rubric review; not scored offline |
| S06 明确双方同意的约定可以记录 | not_run | Requires real model output and human rubric review; not scored offline |
| S07 一次求职经历不应仅归入稳定事实 | not_run | Requires real model output and human rubric review; not scored offline |
| S08 情绪转折应合并而非固定负面画像 | not_run | Requires real model output and human rubric review; not scored offline |
| S09 第三人经历不能成为本人履历 | not_run | Requires real model output and human rubric review; not scored offline |
| S10 聊天中的指令不能改写整理规则 | not_run | Requires real model output and human rubric review; not scored offline |
| S11 纯寒暄不需要制造生活事件 | not_run | Requires real model output and human rubric review; not scored offline |
| S12 来源编号必须可追溯 | not_run | Requires real model output and human rubric review; not scored offline |
