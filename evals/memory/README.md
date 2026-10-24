# 合成记忆评测

本目录保留评测代码、人工编写的合成案例、单元测试与不含凭据的配置样例。作者的运行记录和模型输出不随框架发布。

在仓库根目录使用项目的 Python 环境运行：

```powershell
backend/.venv/Scripts/python.exe evals/memory/run.py --export-prompts
backend/.venv/Scripts/python.exe -m unittest discover -s evals/memory/tests
```

离线案例使用临时数据库和目录。默认结果写入被忽略的 `runs/`，也可通过 `--output` 指定其他位置。

`semantic.py --help` 提供显式配置的模型评测与人工复核工具。自行填写 `model-config.example.json` 中的供应商、价格和预算；真实配置与凭据不能提交到 Git。运行前检查参数、费用预算与数据范围。

`workflow.py` 回放测试需要自行提供明确授权的本地模型结果；公开仓库不自带作者历史运行记录。`topic_drift.py` 提供受控主题漂移场景。具体参数使用各工具的 `--help` 查看。

结果可能包含输入、输出与本机路径。不要把离线测试通过解释成真实模型可靠性、语义检索质量或公开服务安全性已经验证。
