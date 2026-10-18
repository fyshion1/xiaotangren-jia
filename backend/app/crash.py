"""崩溃自证：后端炸了，得留下一份「什么时候炸的、炸在哪、当时功能在干什么」。

以前改完全局配置重启后端，炸了就是窗口一闪 / 一片报错，谁也不知道是哪一步的问题，
只能再叫人来翻半天。这里把所有未处理异常（主线程 + asyncio）落到
`backend/data/crash-<时间>.log`，并把文件名另存到 `crash-latest.txt`，
前端据此就能把最近那次崩溃念给用户听。

⚠ 只写异常和调用栈，**不写配置内容**，所以不会把 api_key 之类带出去。
"""

from __future__ import annotations

import asyncio
import logging
import sys
import threading
from datetime import datetime
from pathlib import Path

_WRITE_LOCK = threading.Lock()

# ⚠ 崩溃钩子会在解释器退出时被调用 —— 那时别的模块可能已经拆掉了，所以这里所有
#   能用标准库写成函数内部 import 的，就都写在函数里。

# 窗口/控制台被关、连接被拽断时 uvicorn 的接收循环会冒出这几个 Windows 错误。
# 不是我们的 bug，别让它们一路冒到顶层把那一次启动弄死。
_TOOLERATE_WINERR = {64, 995, 1236, 10054}


def _dir() -> Path:
    from .db import DATA_DIR

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    return DATA_DIR


def record_exception(exc: BaseException, origin: str) -> Path | None:
    """把一次未处理异常写进崩溃日志，返回日志路径。写不进去就算了（不能因为记日志再炸一次）。"""
    try:
        now = datetime.now()
        path = _dir() / f"crash-{now.strftime('%Y%m%d-%H%M%S')}.log"
        text = "\n".join([
            f"时间：{now.isoformat(timespec='seconds')}",
            f"来源：{origin}",
            f"类型：{type(exc).__name__}",
            "",
            "".join(_safe_traceback(exc)),
            "—— 最近几次功能启动 ——",
            _recent_runs(),
            "",
        ])
        with _WRITE_LOCK:
            path.write_text(text, encoding="utf-8", errors="replace")
            (_dir() / "crash-latest.txt").write_text(path.name, encoding="utf-8")
        return path
    except Exception:  # noqa: BLE001 - 记日志失败不能再抛
        return None


def _safe_traceback(exc: BaseException) -> list[str]:
    import traceback

    try:
        return traceback.format_exception(type(exc), exc, exc.__traceback__)
    except Exception:  # noqa: BLE001
        return [f"{type(exc).__name__}: {exc!r}\n"]


def _recent_runs() -> str:
    try:
        from . import db

        rows = db.list_feature_runs(limit=8)
    except Exception:  # noqa: BLE001
        return "（读不到）"
    if not rows:
        return "（没有记录）"
    return "\n".join(
        f"  {r.get('started_at', '?')}  {r.get('feature_id', '?')}/{r.get('command', '?')}  "
        f"pid={r.get('pid', '?')}  停于 {r.get('stopped_at') or '—'}"
        for r in rows
    )


class _WinErrFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:  # noqa: A003 - logging 要求的签名
        exc = record.exc_info[1] if record.exc_info else None
        if isinstance(exc, OSError) and getattr(exc, "winerror", None) in _TOOLERATE_WINERR:
            return False
        return True


_FILTER = _WinErrFilter()


def _quiet_uvicorn_console_errors() -> None:
    """给 uvicorn 的几个 logger 挂上「别为控制台断开刷异常」。

    新版 uvicorn 自己会吞；老版本会把 `[WinError 64] 指定的网络名不再可用` 当异常抛出来。
    这里不改产物，只是把这类日志拦掉。
    """
    for name in ("uvicorn", "uvicorn.error", "uvicorn.protocols",
                 "uvicorn.protocols.http", "uvicorn.protocols.websockets"):
        logger = logging.getLogger(name)
        if not any(isinstance(f, _WinErrFilter) for f in logger.filters):
            logger.addFilter(_FILTER)


def _loop_handler(loop: asyncio.AbstractEventLoop, context: dict) -> None:
    exc = context.get("exception")
    if exc is None:
        message = str(context.get("message") or "asyncio 事件循环异常")
        exc = RuntimeError(message)
    # 抛出去只会杀一个任务/一次回调；记下来再照常往 stderr 打一份，控制台还是能看见。
    record_exception(exc, "asyncio 事件循环")
    loop.default_exception_handler(context)


def attach(loop: asyncio.AbstractEventLoop) -> None:
    """给正在跑的事件循环挂上异常收集器。uvicorn 每起一个循环都会重设，所以每次启动都要挂。"""
    loop.set_exception_handler(_loop_handler)


def install() -> None:
    """装「最后一次机会」的钩子：未处理异常 / 线程崩溃 / 解释器退出。在 main 里调一次。"""
    _quiet_uvicorn_console_errors()

    def _hook(exc_type, exc, tb):
        if not issubclass(exc_type, KeyboardInterrupt):
            record_exception(exc, "主线程未处理异常")
        sys.__excepthook__(exc_type, exc, tb)

    sys.excepthook = _hook

    def _thread_hook(args):
        if not issubclass(args.exc_type, SystemExit):
            record_exception(args.exc_value, f"线程 {args.thread.name if args.thread else '?'}")
        threading.__excepthook__(args)  # type: ignore[attr-defined]

    if hasattr(threading, "__excepthook"):
        threading.excepthook = _thread_hook


def latest() -> dict | None:
    """最近一次崩溃（给前端用）：文件名、时间、异常类型、最后十几行。"""
    try:
        name = (_dir() / "crash-latest.txt").read_text(encoding="utf-8").strip()
        path = _dir() / name
        if not name or not path.is_file():
            return None
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    lines = text.splitlines()
    when = next((ln.split("：", 1)[1] for ln in lines if ln.startswith("时间：")), "")
    kind = next((ln.split("：", 1)[1] for ln in lines if ln.startswith("类型：")), "")
    return {"file": name, "when": when, "type": kind, "tail": "\n".join(lines[-14:])}
