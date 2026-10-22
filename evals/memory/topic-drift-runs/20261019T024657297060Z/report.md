# 事件主题漂移反例

受控模型输出；不是实际模型失败概率。

| 场景 | 状态 | 失败检查 |
| --- | --- | --- |
| same-topic-control | pass |  |
| renamed-topic-same-evidence | fail | 冲突输出未新增旁路候选 |
| renamed-topic-incremental-correction | fail | 冲突输出未新增旁路候选 |
