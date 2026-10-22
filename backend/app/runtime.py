"""运行期信息 · 一键重启大脑。

`main.py` 一 import 就记下开始时间（`/api/health` 靠它报「活了多久」），
顶栏那颗「大脑活着」的灯和「重启大脑」按钮也走这里。

重启为什么不是一个 `os.execv` 就完事：

- Windows 上 execv **会换掉 pid**（实测 32588 → 36608），所以不能指望「原地重启」；
- 老进程还占着 :8000 的时候新进程 bind 会直接失败（uvicorn 没有「等端口」这种参数）；
- 而先退出就没人来得及叫新进程了。

BAT 启动时，由总启动器接收重启请求、回收旧后端并检查新后端就绪。
后端不能脱离总窗口另起一份；关闭总窗口仍会关闭全部服务。

手动运行 Uvicorn 时的兼容路径：先叫起独立 helper，回话后再退出。
helper 记录 PID 和创建时间，回收旧 worker 与 reload 父进程，再启动不带 reload 的新服务。

失败也安全：中间人没起起来就抛异常，接口回 500，**当前这个大脑继续好好跑**。
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import time
import urllib.request
from datetime import datetime
from pathlib import Path

log = logging.getLogger(__name__)

# 进程一起来就记下。`/api/health` 拿它报 uptime。
STARTED_AT = datetime.now()
PID = os.getpid()

# backend/ —— 重启出来的新进程要用同一个工作目录（app 包在这里面）。
BACKEND_DIR = Path(__file__).resolve().parents[1]
LOG_DIR = BACKEND_DIR / "logs"

# 回话 + 叫起新进程都做完再退。本地回一个 json 用不了这么久，宽一点无妨。
EXIT_DELAY = 0.8


def restart_targets() -> list[dict]:
    """Record only this worker and its Uvicorn ancestors, never a shell or feature."""
    import psutil

    process = psutil.Process()
    targets = [{"pid": process.pid, "created": process.create_time()}]
    try:
        for parent in process.parents():
            args = parent.cmdline()
            if "uvicorn" not in args or "app.main:app" not in args:
                break
            if Path(parent.cwd()).resolve() != BACKEND_DIR:
                break
            targets.append({"pid": parent.pid, "created": parent.create_time()})
    except psutil.NoSuchProcess:
        pass
    except psutil.Error as exc:
        raise OSError(f"无法核对旧服务进程：{exc}") from exc
    return targets


def info() -> dict:
    """给 `/api/health` 用的运行期三件事：什么时候起的、pid、活了多久。"""
    return {
        "started_at": STARTED_AT.strftime("%Y-%m-%d %H:%M:%S"),
        "pid": PID,
        "uptime_seconds": max(0, int((datetime.now() - STARTED_AT).total_seconds())),
    }


def log_path() -> Path:
    """重启后的新大脑把 stdout 追加到这里 —— 日志按天一个文件。"""
    return LOG_DIR / f"brain-{datetime.now().strftime('%Y-%m-%d')}.log"


def _detach_flags() -> list[int]:
    """Windows 下让中间人脱离当前控制台 —— 免得老进程退位（或有人 Ctrl+C）把它一起带走。

    从宽到严试：`BREAKAWAY_FROM_JOB` 在「本进程被塞进作业对象且不允许脱离」时会被拒，
    那就退回只有 `CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW` 的版本（和 nest.py 起
    功能子进程用的是同一对标志）。两个都起不来才算真失败。
    """
    if os.name != "nt":
        return [0]
    base = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
    if os.environ.get("XTR_LAUNCHER_URL"):
        return [base]  # Never escape the launcher's kill-on-close Job.
    return [base | subprocess.CREATE_BREAKAWAY_FROM_JOB, base]


def _child_env() -> dict:
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"  # 中文日志别乱码
    env.setdefault("PYTHONUTF8", "1")
    env.pop("XIAOTANGREN_RESTART_REQUESTED", None)
    return env


def restart() -> Path:
    """叫一个中间人来接手，返回新大脑的日志路径。

    只管「叫起来」；**什么时候退位由 `exit_soon()` 定** —— 得先把话回给前端，
    不然前端只会看到一个连接断掉，不知道到底重启了没有。
    """
    from .config import get_settings

    control = os.environ.get("XTR_LAUNCHER_URL")
    if control:
        request = urllib.request.Request(control + "/restart", data=b"{}", headers={
            "Authorization": "Bearer " + os.environ.get("XTR_LAUNCHER_TOKEN", ""),
            "Content-Type": "application/json",
        })
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(request, timeout=3) as response:
            if response.status != 202:
                raise OSError("总启动器没有接受重启请求")
        return log_path()

    settings = get_settings()
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    path = log_path()
    targets = restart_targets()
    out = open(path, "a", encoding="utf-8")
    argv = [sys.executable, "-m", "app.restart_helper", str(settings.port), settings.host,
            json.dumps(targets)]

    failed: OSError | None = None
    for flags in _detach_flags():
        extra = {"creationflags": flags} if os.name == "nt" else {"start_new_session": True}
        try:
            subprocess.Popen(
                argv,
                cwd=str(BACKEND_DIR),
                env=_child_env(),
                stdin=subprocess.DEVNULL,
                stdout=out,
                stderr=subprocess.STDOUT,
                close_fds=True,
                **extra,
            )
        except OSError as exc:  # 起不来就当没重启，别把好好的大脑搭进去
            failed = exc
            continue
        out.close()
        return path
    out.close()
    raise failed or OSError("没能叫起新进程")


def exit_soon() -> None:
    """回完话之后退位 —— 中间人这会儿正在等 :8000。"""
    if os.environ.get("XTR_LAUNCHER_URL"):
        return  # The owner stops/replaces the backend, independent of this worker.
    log.info("一键重启：新进程已就位，老进程（pid %s）退位", PID)
    time.sleep(EXIT_DELAY)
    try:
        # 让巡检线程先收工，别留下半拉子文件句柄。
        from .services import harvest

        harvest.stop()
    except Exception:  # noqa: BLE001 —— 都要退位了，收尾失败不该拦着
        pass
    # The detached helper retires the recorded ancestors too, even if this cleanup hangs.
    os._exit(0)
