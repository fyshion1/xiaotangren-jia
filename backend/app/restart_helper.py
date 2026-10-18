"""重启的中间人：等端口腾出来，再把大脑顶上去。

**只干这一件事。** 由 `app.runtime.restart()` 脱离控制台起起来，被起的时候
stdout 已经指向 `backend/logs/brain-<日期>.log`，所以这里的 print 就是重启日志。

为什么不直接在老进程里 `os.execv`：老进程退位之前端口还占着，新进程 bind 会失败；
反过来先退位又没人干活了。所以让一个「还没占端口的第三方」来等 —— 它等到就顶上去。

用法（后端自己拼，不用手敲）：`python -m app.restart_helper <端口> <主机>`
"""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import time

# 等老进程撒手最多等这么久 —— 正常一两秒，宽一点免得机器忙的时候误判。
WAIT_SECONDS = 60.0
POLL_INTERVAL = 0.3


def _port_free(host: str, port: int) -> bool:
    """能不能 bind 上。用**不带 SO_REUSEADDR** 的裸 socket 试 —— 比 uvicorn 还严一点，
    这里能过，uvicorn 那边基本都能过。"""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        try:
            sock.bind((host, port))
        except OSError:
            return False
    return True


def main(argv: list[str]) -> int:
    port = int(argv[1]) if len(argv) > 1 else 8000
    host = argv[2] if len(argv) > 2 else "127.0.0.1"

    print(f"[重启] 等 {host}:{port} 腾出来…", flush=True)
    deadline = time.time() + WAIT_SECONDS
    while time.time() < deadline:
        if _port_free(host, port):
            break
        time.sleep(POLL_INTERVAL)
    else:
        print(f"[重启] 等了 {WAIT_SECONDS:.0f} 秒端口还没空出来，放弃 —— 手动重启吧", flush=True)
        return 1

    uvicorn_argv = [
        sys.executable, "-m", "uvicorn", "app.main:app", "--host", host, "--port", str(port),
    ]
    print(f"[重启] 端口空了，把大脑顶上来：{' '.join(uvicorn_argv)}", flush=True)

    # execv：自己变成 uvicorn，不多留一层进程（stdout 自然继承 = 继续写这份日志）。
    try:
        os.execv(sys.executable, uvicorn_argv)
    except OSError as exc:
        print(f"[重启] execv 没成（{exc}），换成另起一个进程", flush=True)
        return subprocess.call(uvicorn_argv)  # 兜底：真起不来就把它的话原样留在日志里
    return 1  # 到不了这里 —— execv 成功就换人了


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))