# 小糖人工具运行时与 Agent 循环

`xiaotangren-tool-runtime` 是可独立安装的 Python 包，不依赖 FastAPI、数据库或本体 `app.*`。功能进程用它执行自己的工具，本体 `/api/nest/tool-turn` 仍只转发模型决定。

已接入 QQ Bridge 的 `local_dir`、`local_read`、`local_find`、`local_info`。注册器只接收开发者写的处理函数，模型只能提供工具名和参数。接受 `risk="read"`、`risk="proposal"` 和 `risk="write"`。proposal 只保存未生效草稿；write 可保存明确授权的业务数据。两者默认拒绝且不得自动重试，分别需要策略 `allow_proposals` / `allow_writes`，仍须工具名白名单和身份检查。没有 Shell 或任意写入执行入口。

## 安装

在本体仓库根目录：

```powershell
uv pip install --python backend/.venv/Scripts/python.exe -e packages/tool-runtime
```

本体的 `backend/pyproject.toml` 已声明本地包依赖，后续在 `backend` 执行 `uv sync --locked` 也会安装。前端启动的功能使用本体同一个解释器，因此可直接导入。独立部署 QQ 桥时，先在桥的解释器中安装此目录或构建出的 wheel，再安装桥的 `requirements.txt`。本包尚未发布到 PyPI。

构建 wheel（仓库根目录）：

```powershell
uv build --wheel packages/tool-runtime
```

Docker 构建上下文已改为仓库根目录：`docker build -f backend/Dockerfile .`；Compose 的后端配置同步更新。

## 功能侧接入

```python
from pathlib import Path
from xiaotangren_tools import ToolContext, ToolExecutor, ToolPolicy
from xiaotangren_tools.local_files import LocalFiles

registry = LocalFiles(Path("data/sandbox"), max_bytes=8000).registry()
policy = ToolPolicy(enabled=True, allowed_names={"local_read", "local_info"})
executor = ToolExecutor(registry, policy)

# 身份来自已验证的消息传输层。不能从模型 arguments/state 中取身份。
context = ToolContext(actor_id="owner", owner_id="owner",
                      conversation_id="chat-1", call_id="call-1")
schemas = executor.schemas(context)  # 交给 /api/nest/tool-turn 的 tools

# 在 async 功能循环内执行模型返回的单个调用。
result = await executor.execute("local_read", '{"path":"note.txt"}', context)
# 把 result.content 作为 role=tool 回填；错误同样必须回填。
```

新增只读工具时，继承 `Arguments` 定义参数，然后注册 `Tool(name, description, ArgumentsType, handler)`。参数模型同时生成 JSON Schema 并严格校验执行输入；拒绝缺失字段、错误类型和额外字段。处理函数接受 `(typed_arguments, context)`，返回字符串，可同步或异步。

## 执行契约

顺序：登记表查找 → 开关与白名单、所有者校验 → 参数大小与类型校验 → 有截止时间的执行 → 输出截断 → 记录元数据。

- `ToolPolicy` 默认关闭、空白名单、仅所有者。工具声明也按相同身份策略过滤。
- `ToolContext` 必须由可信适配器构造。注册器和配置同样属于可信代码，不是模型可修改的数据。
- `ToolResult` 包含 `ok/code/content/attempts/truncated`。错误码为 `denied`、`unknown_tool`、`invalid_arguments`、`timeout`、`transient_error`、`execution_error`；取消时记录 `cancelled` 并继续传播取消。
- 每个工具默认 10 秒，注册上限 60 秒。所有尝试共享截止时间。同步处理函数使用 `asyncio.to_thread`，不占住消息事件循环。
- 默认只执行一次。只读适配器显式抛出 `ToolTransientError` 且注册 `max_attempts=2/3` 时，才会有限重试。权限错误、参数错误、一般异常、超时均不自动重试。
- 默认参数最多 16 KiB、结果最多 8000 字符；QQ 桥结果最多 4000 字符。文件 `max_bytes` 真正按字节限制读取，不先读整个文件。
- 目录输出最多 80 项，目录采样最多 2000 项；文件名搜索最多检查 5000 项、返回 60 项，不递归进入符号链接或 Windows junction。
- 路径解析为真实路径后检查根目录边界；拒绝越界、命令字符，以及 Windows 网络路径、设备命名空间和备用数据流。
- 沙箱目录在首次已授权、参数有效的工具执行时创建。工具不写入文件内容。
- `ToolAuditEvent` 只记录工具名、会话/调用 ID、结果码、尝试次数、耗时和截断标记，不记录参数、文件正文或原始异常。默认写入 `xiaotangren_tools.executor` 的 INFO 日志；QQ 桥接入已有运行日志。审计回调失败不会重放已经执行的工具，也不是持久化事务审计。

## 边界与后续

Python 线程超时只能停止等待，不能强制杀死正在进行的文件读取；超时不代表操作已中止，所以不会自动重试。异步处理函数也必须配合取消，不应阻塞事件循环。要隔离不可信程序或强制终止任务，需要下一层子进程/系统沙箱。

真实路径检查可阻止静态链接逃逸，但不是操作系统隔离；本地其他进程在检查与读取之间恶意替换目录的竞态、硬链接、挂载点等不由此层完全隔离。不要把允许根目录设为系统盘或包含密钥的目录。

第二阶段增加 `AgentRunner`：模型决定 → 校验执行 → `role=tool` 回填 → 再次决定/最终回复。默认最多 6 轮、8 次工具调用、单轮 3 次、总计 60 秒；支持一次参数纠错、重复调用检测、超时和取消。调用 ID 由运行时规范化，避免模型重复 ID 破坏消息配对。QQ 桥目前保留自己的既有循环，只复用工具执行层。

网页聊天和桌宠通过本体内置的可信适配器使用此循环；没有开放任意工具名/参数的 HTTP 执行入口，`/api/nest/tool-turn` 仍只转发。包已安装不等于工具开关已打开。使用界面及测试记录见 [工具使用说明](../../docs/tool-agent.md)。通用网页搜索复用本机 OmniReach；`lyrics_search` 是本包里的独立只读工具，由本体适配器注册并随「联网搜索」能力授权，优先查 LRCLIB 精确元数据，最多向模型返回 80 字开头摘录与来源，空结果只用 Google 网页摘要兜底。一次性提醒和个人知识资料草案采用待确认流程；知识库正文只在用户确认后更新。该歌词工具不依赖本体数据库，也不会自动写入个人知识库或角色沙盒记忆。

## 测试

仓库根目录运行：

```powershell
backend/.venv/Scripts/python.exe -X utf8 -m unittest discover -s packages/tool-runtime/tests -v
```

QQ 桥目录运行：

```powershell
../../backend/.venv/Scripts/python.exe -X utf8 -m unittest discover -s tests -v
```

覆盖默认拒绝、绕过桥入口时的身份校验、Schema/执行一致性、参数错误、路径与链接逃逸、读取上限、超时、有限重试、取消和日志脱敏。QQ 集成测试使用真实执行器和假模型，验证工具决定 → 文件读取 → role=tool 回填 → 最终回复；不调用付费模型或发送真实 QQ 消息。

2026-10-19 本次验证：SDK 22 项、QQ 桥全套 90 项、本体 `test_nest_router.py` 37 项均通过；新增 SDK 和适配代码的 Ruff 检查通过，wheel 已构建，依赖锁检查通过。Windows 符号链接逃逸测试实际执行通过。没有连接真实 QQ/付费模型；本机没有 Docker，未执行容器构建。
