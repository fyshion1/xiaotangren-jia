"""重启的中间人：等端口腾出来，再把大脑顶上去。

**只干这一件事。** 由 `app.runtime.restart()` 脱离控制台起起来，被起的时候
stdout 已经指向 `backend/logs/brain-<日期>.log`，所以这里的 print 就是重启日志。

为什么不直接在老进程里 `os.execv`：老进程退位之前端口还占着，新进程 bind 会失败；
反过来先退位又没人干活了。所以让一个「还没占端口的第三方」来等 —— 它等到就顶上去。

用法（后端自己拼，不用手敲）：`python -m app.restart_helper <端口> <主机>`
"""

from __future__ import annotations

import os
import http.client
import json
import socket
import subprocess
import sys
import time

# 等老进程撒手最多等这么久 —— 正常一两秒，宽一点免得机器忙的时候误判。
WAIT_SECONDS = 60.0
POLL_INTERVAL = 0.3
STARTUP_SECONDS = 45.0


def _retire(targets: list[dict]) -> None:
    """Use PID + creation time so a recycled PID can never kill an unrelated process."""
    import psutil

    processes = []
    for target in reversed(targets):
        try:
            process = psutil.Process(target["pid"])
            if process.create_time() != target["created"]:
                continue
            print(f"[重启] 回收旧服务 pid={process.pid}", flush=True)
            process.terminate()
            processes.append(process)
        except psutil.NoSuchProcess:
            continue
    _, alive = psutil.wait_procs(processes, timeout=5)
    for process in alive:
        process.kill()
    _, alive = psutil.wait_procs(alive, timeout=5)
    if alive:
        raise RuntimeError(f"旧服务没有退出：{[p.pid for p in alive]}")


def _port_free(host: str, port: int) -> bool:
    """能不能 bind 上，用和 Uvicorn 一样的地址复用选项忽略已关闭连接的 TIME_WAIT。"""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        try:
            # On Windows SO_REUSEADDR can bind an occupied listening port.
            # Check TCP acceptance first, including listeners whose event loop is stuck.
            address = "127.0.0.1" if host == "0.0.0.0" else host
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
                probe.settimeout(0.5)
                if probe.connect_ex((address, port)) == 0:
                    return False
            # Mirror Uvicorn's socket option so Windows TIME_WAIT does not look
            # like a live listener after the old server has shut down.
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock.bind((host, port))
        except OSError:
            return False
    return True


def main(argv: list[str]) -> int:
    port = int(argv[1]) if len(argv) > 1 else 8000
    host = argv[2] if len(argv) > 2 else "127.0.0.1"
    targets = json.loads(argv[3]) if len(argv) > 3 else []
    if targets:
        # Allow the response and normal worker exit first; enforce a bound even
        # when background cleanup or the reload supervisor is hung.
        time.sleep(2.0)
        _retire(targets)

    print(f"[重启] 等 {host}:{port} 腾出来…", flush=True)
    deadline = time.monotonic() + WAIT_SECONDS
    while time.monotonic() < deadline:
        if _port_free(host, port):
            break
        time.sleep(POLL_INTERVAL)
    else:
        print(f"[重启] 等了 {WAIT_SECONDS:.0f} 秒端口还没空出来，放弃 —— 手动重启吧", flush=True)
        return 1

    uvicorn_argv = [sys.executable, "-m", "uvicorn", "app.main:app", "--host", host,
                    "--port", str(port)]
    uvicorn_argv.extend(["--workers", "1", "--timeout-graceful-shutdown", "5"])
    print(f"[重启] 端口空了，把大脑顶上来：{' '.join(uvicorn_argv)}", flush=True)

    extra = ({"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW}
             if os.name == "nt" else {"start_new_session": True})
    child = subprocess.Popen(uvicorn_argv, stdin=subprocess.DEVNULL, **extra)
    address = "127.0.0.1" if host == "0.0.0.0" else host
    deadline = time.monotonic() + STARTUP_SECONDS
    while time.monotonic() < deadline:
        if child.poll() is not None:
            print(f"[重启] 新服务提前退出，exit={child.returncode}", flush=True)
            return 1
        conn = http.client.HTTPConnection(address, port, timeout=1)
        try:
            conn.request("GET", "/api/health")
            response = conn.getresponse()
            health = json.loads(response.read())
            if (response.status == 200 and health.get("status") == "ok"
                    and health.get("pid") not in {t["pid"] for t in targets}):
                print(f"[重启] 新服务就绪 pid={health.get('pid')}", flush=True)
                return 0
        except (OSError, ValueError, http.client.HTTPException):
            pass
        finally:
            conn.close()
        time.sleep(POLL_INTERVAL)
    print(f"[重启] 新服务 {STARTUP_SECONDS:.0f} 秒内未通过健康检查，请查看本日志", flush=True)
    return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
