# 从想法到真实结果

这是工具用法参考，不是必须完成的项目。没有新任务时，不必反复读模板或把整理清单变成新的任务。

## 三条不同的文件通道

1. 本项目源码只读：`{"intent":"reference","path":"desktop-pet/"}` 列目录；`{"intent":"reference","path":"desktop-pet/src/main.js","offset":0}` 读取。无需项目审批，模型调用仍计独立钱包。`frontend/src/`、`backend/app/`、`features/qq-bridge/qqbridge/`、`docs/` 同样可查看；凭据、运行数据和配置不在源码快照里。不存在的路径先列目录确认。
2. 自己的笔记：`{"intent":"personal_docs","operation":"write","path":"docs/my-observation.md","body":"完整正文"}`。只有返回 `written=true` 才表示写入；读取用 operation=read。body写在读取请求里不会保存。
3. 获批项目工作区：read_file/write_file/execute/web/agent 继续需要对应前端授权。它们不是读取本项目源码的入口。

`document` 只保存活动草稿，不会更新个人docs。草稿、写入、读回核对、代码执行、测试通过是不同的事实，描述时分清。

## 一次小探索怎样收尾

选一个具体问题，读取相关源码或已有资料，留下一个有依据的小发现。需要文档时写自己的docs，再读回确认。向主人用普通话说清：看了哪里、发现什么、文件在哪里、还有哪些没做。不要求找出缺陷，也可以记录一个设计理由或想试的玩法。

记录真实进展即可；不要为了完成任务清单，再创建检查任务清单的任务。没有新的可执行动作就休息、换兴趣或等待。需要执行代码或新增联网能力时先说明，再申请前端审批；已有项目不必做完，不自动续预算。
