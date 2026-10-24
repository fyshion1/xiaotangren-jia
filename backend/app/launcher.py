"""Windows console is the lifetime owner of all services started from this home.

Run from start.bat. The Job owns even hidden/detached descendants; do not enable
BREAKAWAY or inherit its handle. A separate authenticated control endpoint lets
the backend request a restart without launching an unmanaged replacement.
"""
from __future__ import annotations

import argparse
import contextlib
import json
import os
import queue
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import psutil

from .launcher_settings import StartupSettings, load_startup, save_startup

BACKEND = Path(__file__).resolve().parents[1]
REPO = BACKEND.parent
LOGS = BACKEND / "logs"


def say(message: str):
    print(f"[{datetime.now():%H:%M:%S}] {message}", flush=True)


def request_json(port: int, path: str, body=None, timeout: float = 3):
    data = None if body is None else json.dumps(body).encode("utf-8")
    request = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data,
                                     headers={"Content-Type": "application/json"})
    # Local service control should never go through a system HTTP proxy.
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=timeout) as response:
        return json.load(response)


def port_busy(port: int) -> bool:
    with socket.socket() as sock:
        sock.settimeout(0.5)
        return sock.connect_ex(("127.0.0.1", port)) == 0


def cleanup_legacy():
    """Retire old unmanaged instances of these exact services in this repository."""
    protected = {os.getpid(), *(p.pid for p in psutil.Process().parents())}
    targets: dict[int, psutil.Process] = {}
    for process in psutil.process_iter():
        try:
            args = process.cmdline()
            cwd = Path(process.cwd()).resolve()
            backend = cwd == BACKEND and "uvicorn" in args and "app.main:app" in args
            helper = cwd == BACKEND and "app.restart_helper" in args
            feature = any(cwd == REPO / "features" / folder and module in args and "run" in args
                          for folder, module in (("qq-bridge", "qqbridge"), ("desktop-pet", "pet")))
            frontend = (cwd == REPO / "frontend" and process.name().lower() in ("node.exe", "node")
                        and any("node_modules" in arg and "vite" in arg for arg in args[1:]))
            if not (backend or helper or feature or frontend):
                continue
            tree = [process, *process.children(recursive=True)]
            if protected.intersection(p.pid for p in tree):
                continue
            targets.update({p.pid: p for p in tree})
        except (psutil.NoSuchProcess, psutil.AccessDenied, OSError):
            continue
    if targets:
        say(f"回收上次遗留的本项目服务（{len(targets)} 个进程）…")
    for process in targets.values():
        with contextlib.suppress(psutil.NoSuchProcess):
            process.kill()
    _, alive = psutil.wait_procs(list(targets.values()), timeout=5)
    if alive:
        raise RuntimeError(f"旧服务仍未退出：{[p.pid for p in alive]}")


class Launcher:
    def __init__(self, settings: StartupSettings, backend_port=8000, frontend_port=5173):
        self.settings = settings
        self.backend_port, self.frontend_port = backend_port, frontend_port
        self.processes: dict[str, subprocess.Popen] = {}
        self.commands: queue.Queue[str] = queue.Queue()
        self.stopping = threading.Event()
        self.token = secrets.token_urlsafe(32)
        self.restarting = False
        self.control: ThreadingHTTPServer | None = None
        self.control_lock = threading.Lock()
        self.backend_ready = False
        self.backend_servers: list[psutil.Process] = []

    def start_control(self):
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                if not secrets.compare_digest(self.headers.get("Authorization", ""), f"Bearer {owner.token}"):
                    self.send_error(403)
                    return
                if self.path != "/restart":
                    self.send_error(404)
                    return
                with owner.control_lock:
                    if owner.restarting or owner.stopping.is_set():
                        self.send_error(409, "Restart or shutdown already in progress")
                        return
                    owner.restarting = True
                    owner.commands.put("restart")
                data = b'{"ok":true}'
                self.send_response(202)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.control = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.control.daemon_threads = True
        threading.Thread(target=self.control.serve_forever, daemon=True).start()

    def environment(self):
        env = os.environ.copy()
        env.update(PYTHONIOENCODING="utf-8", PYTHONUNBUFFERED="1", HOST="127.0.0.1",
                   SHIONARIUM_BACKEND_URL=f"http://127.0.0.1:{self.backend_port}",
                   PORT=str(self.backend_port), XTR_LAUNCHER_PID=str(os.getpid()),
                   XTR_LAUNCHER_TOKEN=self.token,
                   XTR_LAUNCHER_URL=f"http://127.0.0.1:{self.control.server_port}")
        return env

    def spawn(self, name: str, argv: list[str], cwd: Path):
        LOGS.mkdir(parents=True, exist_ok=True)
        flags = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
        filename = f"brain-{datetime.now():%Y-%m-%d}.log" if name == "backend" else f"launcher-{name}.log"
        with (LOGS / filename).open("ab") as stream:
            stream.write(f"\n===== launcher {datetime.now().isoformat()} =====\n".encode())
            stream.flush()
            proc = subprocess.Popen(argv, cwd=cwd, env=self.environment(), stdin=subprocess.DEVNULL,
                                    stdout=stream, stderr=subprocess.STDOUT, creationflags=flags,
                                    close_fds=True)
        self.processes[name] = proc
        proc._xtr_created = psutil.Process(proc.pid).create_time()
        say(f"{name} 已启动（PID {proc.pid}），日志：{filename}")
        return proc

    def wait_backend(self, timeout=45):
        deadline = time.monotonic() + timeout
        proc = self.processes["backend"]
        while time.monotonic() < deadline and not self.stopping.is_set():
            if proc.poll() is not None:
                raise RuntimeError(f"后端提前退出（{proc.returncode}），请查看 backend/logs/")
            try:
                health = request_json(self.backend_port, "/api/health", timeout=1)
                server = psutil.Process(health["pid"])
                if health.get("status") == "ok" and (server.pid == proc.pid or proc.pid in {p.pid for p in server.parents()}):
                    say(f"大脑就绪（PID {server.pid}）")
                    self.backend_ready = True
                    self.backend_servers = [server]
                    return
            except (OSError, ValueError, KeyError, psutil.Error):
                pass
            self.stopping.wait(0.3)
        raise RuntimeError("后端启动健康检查超时，请查看 backend/logs/")

    def start_backend(self):
        self.backend_ready = False
        if port_busy(self.backend_port):
            raise RuntimeError(f"端口 {self.backend_port} 已占用。请先关闭旧启动窗口；不会复用不受本窗口管理的服务。")
        self.spawn("backend", [sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1",
                              "--port", str(self.backend_port), "--workers", "1",
                              "--timeout-graceful-shutdown", "5"], BACKEND)
        self.wait_backend()

    def start_frontend(self):
        if port_busy(self.frontend_port):
            raise RuntimeError(f"端口 {self.frontend_port} 已占用，请先关闭旧前端。")
        node = shutil.which("node")
        vite = REPO / "frontend" / "node_modules" / "vite" / "bin" / "vite.js"
        if not node or not vite.is_file():
            raise RuntimeError("找不到 Node / Vite，请先在 frontend 执行 npm install")
        self.spawn("frontend", [node, str(vite), "--port", str(self.frontend_port), "--strictPort"], REPO / "frontend")

    def start_feature(self, feature: str):
        from .features_registry import runner_of
        runner = runner_of(feature)
        if not runner or not (REPO / 'features' / runner['folder']).is_dir():
            say(f"{feature} 未安装，跳过。")
            return
        if feature == "qq_bridge":
            # Gateway may require a QQ login. Its failure must not block the pet,
            # the frontend, or the shutdown/restart control loop.
            try:
                status = request_json(self.backend_port, "/api/nest/features/qq_bridge/gateway", timeout=5)
                if not status.get("online"):
                    request_json(self.backend_port, "/api/nest/features/qq_bridge/gateway/start", {}, timeout=70)
            except (OSError, ValueError) as exc:
                say(f"QQ 网关未就绪：{exc}；桥仍会按已有配置启动，详情见功能日志。")
        try:
            command = 'serve' if any(c['name'] == 'serve' and c.get('background') for c in runner['commands']) else 'run'
            result = request_json(self.backend_port, f"/api/nest/features/{feature}/run", {"command": command}, timeout=10)
            say(f"{feature}：{result.get('message', '启动请求已提交')}")
        except (OSError, ValueError) as exc:
            say(f"{feature} 启动失败：{exc}，详情请查看功能日志。")

    def stop_backend(self):
        self.backend_ready = False
        proc = self.processes.get("backend")
        if not proc:
            return
        # Retire only the backend and interpreter launcher, preserving the QQ
        # bridge and pet that share this Job and can reconnect after a restart.
        targets = []
        with contextlib.suppress(psutil.NoSuchProcess):
            root = psutil.Process(proc.pid)
            if abs(root.create_time() - proc._xtr_created) > 0.01:
                raise RuntimeError("后端 PID 已变化，拒绝操作其他进程")
            targets = [p for p in root.children(recursive=True)
                       if "app.main:app" in p.cmdline() or "--multiprocessing-fork" in p.cmdline()]
            targets.append(root)
        targets.extend(p for p in self.backend_servers if p.is_running())
        targets = list({p.pid: p for p in targets}.values())
        for process in targets:
            with contextlib.suppress(psutil.NoSuchProcess):
                process.kill()
        _, alive = psutil.wait_procs(targets, timeout=5)
        if alive:
            raise RuntimeError("旧大脑没有退出，拒绝在同一端口启动第二份")
        self.processes.pop("backend", None)
        self.backend_servers = []

    def restart_backend(self):
        try:
            # Reply to the frontend before taking its current connection away.
            self.stopping.wait(0.8)
            self.stop_backend()
            self.start_backend()
        except Exception as exc:
            say(f"重启失败：{exc}")
        finally:
            with self.control_lock:
                self.restarting = False

    def run(self):
        self.start_control()
        # Start frontend even when backend startup fails, so the failure is visible.
        for enabled, start in ((self.settings.frontend, self.start_frontend),
                               (self.settings.backend, self.start_backend)):
            if enabled:
                try:
                    start()
                except Exception as exc:
                    say(str(exc))
        if self.backend_ready:
            for feature in ("qq_bridge", "desktop_pet", "autonomous_activity"):
                if getattr(self.settings, feature):
                    threading.Thread(target=self.start_feature, args=(feature,), daemon=True).start()
            # Installed HTTP backends are services; scheduled 'watch' jobs remain opt-in.
            from .features_registry import FEATURES
            for feature in FEATURES:
                runner = feature.get('runner')
                if runner and any(c['name'] == 'serve' and c.get('background') for c in runner['commands']):
                    if (REPO / 'features' / runner['folder']).is_dir():
                        threading.Thread(target=self.start_feature, args=(feature['id'],), daemon=True).start()
        say("关闭本窗口 = 退出全部服务（含 QQ 桥、网关、桌宠和前端）。")
        if self.settings.frontend:
            say(f"小窝：http://localhost:{self.frontend_port}")
        reported = set()
        last_health, failures = time.monotonic(), 0
        while not self.stopping.is_set():
            try:
                action = self.commands.get(timeout=1)
                if action == "restart":
                    self.restart_backend()
                    reported.discard("backend")
            except queue.Empty:
                pass
            for name, proc in list(self.processes.items()):
                if proc.poll() is not None and name not in reported:
                    say(f"{name} 已退出（{proc.returncode}），请查看日志。")
                    reported.add(name)
            if self.backend_ready and time.monotonic() - last_health >= 5:
                try:
                    health = request_json(self.backend_port, "/api/health", timeout=2)
                    if health.get("status") != "ok":
                        raise ValueError("health status")
                    failures = 0
                except (OSError, ValueError):
                    failures += 1
                last_health = time.monotonic()
                if failures >= 3:
                    say("大脑连续三次未响应，由总启动器尝试恢复。")
                    failures = 0
                    self.restart_backend()


def configure():
    from .expert_mode import enabled
    if not enabled():
        say('普通模式自动启动所有已安装的服务，无需配置。')
        return
    previous = load_startup().model_dump()
    labels = {"backend": "后端大脑", "frontend": "前端页面", "qq_bridge": "QQ 桥与网关", "desktop_pet": "桌宠", "autonomous_activity": "自主活动插件"}
    for key, label in labels.items():
        if key in ("qq_bridge", "desktop_pet", "autonomous_activity") and not previous["backend"]:
            previous[key] = False
            say(f"已取消 {label}（需要后端）")
            continue
        value = input(f"下次启动 {label}？[y/n，回车保留 {'y' if previous[key] else 'n'}] ").strip().lower()
        if value:
            previous[key] = value in ("y", "yes", "1")
    save_startup(StartupSettings(**previous))
    say("设置已保存。重新双击 start.bat 启动。")


def main(argv=None):
    parser = argparse.ArgumentParser(description="小糖人之家总启动器")
    parser.add_argument("--configure", action="store_true")
    parser.add_argument("--reset-startup", action="store_true")
    parser.add_argument('--backend-port',type=int,default=8000)
    parser.add_argument('--frontend-port',type=int,default=5173)
    args = parser.parse_args(argv)
    if not all(1 <= port <= 65535 for port in (args.backend_port,args.frontend_port)):
        parser.error('端口必须在 1 到 65535 之间')
    if args.backend_port == args.frontend_port:
        parser.error('前端和后端不能使用同一个端口')
    if os.name != "nt":
        parser.error("此启动器使用 Windows Job，请在 Windows 运行 start.bat")
    if args.configure:
        configure()
        return 0
    if args.reset_startup:
        save_startup(StartupSettings())
        say("已恢复默认：全部启动。")
    import msvcrt
    from .windows_job import WindowsJob

    lock_path = BACKEND / "data" / "launcher.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+b") as lock:
        lock.seek(0)
        if not lock.read(1):
            lock.write(b"0")
            lock.flush()
        lock.seek(0)
        try:
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            say("总启动窗口已经在运行，请回到已有窗口。")
            return 1
        settings = load_startup()
        launcher = Launcher(settings,backend_port=args.backend_port,frontend_port=args.frontend_port)
        job = WindowsJob()  # Fail closed: never start unmanaged children.
        def stop(*_):
            launcher.stopping.set()
        signal.signal(signal.SIGINT, stop)
        signal.signal(signal.SIGBREAK, stop)
        try:
            cleanup_legacy()
            launcher.run()
        except Exception as exc:
            say(f"启动器运行失败：{exc}")
        finally:
            launcher.stopping.set()
            say("正在退出全部服务…")
            job.close()
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        say(f"启动失败：{error}")
        raise SystemExit(1)
