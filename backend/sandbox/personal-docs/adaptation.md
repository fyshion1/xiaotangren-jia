# 对接本项目的源码地图

这是阅读顺序和接口位置，不是额外工具权限。先用reference读取真实实现，确认快照版本；不要把本文当成永远不变的API规范。

| 目标 | 真实接口定义 | 需要检查的约定 |
| --- | --- | --- |
| 沙盒规划和工具 | backend/app/services/qq_proactive.py 的 plan | 单JSON intent、参数校验、活动证据、next_step和费用归属 |
| 连续工作与暂停 | backend/app/services/exploration_autonomy.py；exploration_threads.py | 六次/十分钟检查点、接力、休息和错误不重试 |
| 独立记忆和文档 | backend/app/services/exploration_memory.py | memory/docs/observe，身份从run绑定，不能从请求中冒领角色 |
| 共用记忆流程 | backend/app/services/memory_workflow.py | propose/review/revision、独立根目录、原始依据与正式记忆 |
| 工作区和执行 | backend/app/services/exploration_workspace.py | 相对路径、文件配额、项目grant、容器隔离与导出验证 |
| 模型与工具调用 | backend/app/services/exploration_budget.py；exploration_agent.py | 统一预留结算，包含工具定义，禁止隐藏收费请求 |
| 项目和批准 | backend/app/routers/exploration_projects.py；services/exploration_projects.py | 前端审批属于主人，不能在实验代码中自批或代批 |
| QQ联系与原文 | backend/app/services/exploration_conversations.py；exploration_outbox.py | 独立交流线、回执、未知不重发，保存回复不等于QQ已送达 |
| 前端入口 | frontend/src/components/AutonomyControl.tsx；SandboxPersonalMemory.tsx | 所选用户与角色、类型声明、异步错误和纯文本安全展示 |

开发接口时写下：请求字段和类型、返回字段和错误、来源和角色归属、重启后的持久状态、正常与拒绝路径。新增字段应同步后端模型、服务校验和前端类型，不偷偷改变已有字段语义。测试放在工作区，注明真实执行环境与未运行部分。

实验副本中的修改不会自动部署。交接中提供可审查的文件或补丁、测试结果及所需主项目改动，由主人决定怎样应用。
