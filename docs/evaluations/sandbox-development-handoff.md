# 沙盒开发交接

更新：2026-10-20。只保存经核实的开发状态；角色实时状态以数据库或前端为准。先看 [系统地图](../guides/sandbox-development-map.md)，按目标定位代码。

## 当前交付

- `qq_proactive.CONTEXT_VERSION = 9`。提示词以兴趣、连续行动、创作与主动交流为主，合并重复授权告诫；个人手册按需查阅。
- 保留 Claude Code 对开场语气、agent 嵌套调用后的 next_step 计数改动。补齐 `workspace.execute(..., agent='codex')`，当前只接通 Codex；Claude 未实现。
- 完整模型响应格式/参数错误最多在原 run 内修复一次，之前落盘文件保留；重复失败停止。权限、上游与用量失败不进入格式修复。
- 当前修改不为角色增加额度，不取消显式暂停，不主动唤醒付费循环。个人手册只改出厂模板，没有覆盖角色自己的笔记。

## 已有验证

- `test_sandbox_life`、`test_exploration_autonomy`、`test_exploration_projects`、`test_exploration_memory` 合计 82 项：首次唯一失败是旧提示词原文断言；更新断言后，该用例单独通过。
- 该重测用例、`test_exploration_agent.AgentTests` 与 QQ 的 `test_agent_plan_uses_trusted_config_and_counts_nested_requests` 共 11 项通过。
- 最后添加“上游失败不进入格式修复”保护后，两项 JSON 恢复用例再次通过。未重新运行全部套件；未做真实上游或 QQ 送达验收。
- 详细变更记录：[提示词与 Claude Code 改动核对](../guides/sandbox-prompt-review-2026-10-20.md)。

## 后续如何接

先明确一个交付：例如真实工作区任务能否落盘并回传，或聊天风格是否自然；不预先扩展 Claude 通道、重做调度或全量重构。真实互动效果尚未验证，不能由离线测试推断。

需要续接较长任务时，直接更新下面的短记录，删掉失效的待办。没有新事实就不反复重写，不用每轮交报告。

```text
目标与验收：
已核实事实（文件/符号/证据）：
本次实际改动：
验证（精确命令、结果、未验证范围）：
当前阻塞或待决定事项：
下一步一个具体动作：
运行状态（是否启动付费活动/发送消息）：
```

长会话出现重复调查时先保存接力，适合时在新会话继续；不按固定轮数强制重启，不承诺固定省费比例。使用局部源码、编辑前副本与验证结果复用降低重复输入。
