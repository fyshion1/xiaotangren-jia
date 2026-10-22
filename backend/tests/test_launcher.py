"""Lifecycle tests use isolated child processes; never stop the user's services."""
from __future__ import annotations

import contextlib
import ctypes
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import psutil
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app import launcher_settings as prefs
from app.launcher import Launcher, request_json
from app.routers import system


class StartupSettingsTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        setting_patch = patch.object(prefs, "SETTINGS_PATH", Path(folder.name) / "launcher.json")
        setting_patch.start()
        self.addCleanup(setting_patch.stop)

    def test_first_boot_all_on_and_saved_choices_survive(self):
        self.assertTrue(all(prefs.load_startup().model_dump().values()))
        settings = prefs.StartupSettings(qq_bridge=False, desktop_pet=False)
        prefs.save_startup(settings)
        self.assertEqual(prefs.load_startup(), settings)

    def test_no_silent_start_on_corrupt_file(self):
        prefs.SETTINGS_PATH.write_text("bad json", encoding="utf-8")
        with self.assertRaises(ValueError):
            prefs.load_startup()

    def test_invalid_dependencies_or_boolean_rejected(self):
        with self.assertRaises(ValidationError):
            prefs.StartupSettings(backend=False)
        with self.assertRaises(ValidationError):
            prefs.StartupSettings(qq_bridge="false")

    def test_api_saves_for_next_boot_without_launching(self):
        app = FastAPI()
        app.include_router(system.router, prefix="/api")
        with TestClient(app) as client, patch("subprocess.Popen") as popen:
            choices = {"backend": True, "frontend": False, "qq_bridge": False, "desktop_pet": True}
            response = client.put("/api/system/startup", json=choices)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(client.get("/api/system/startup").json()["settings"], choices)
            self.assertEqual(client.put("/api/system/startup", json={"backend": False}).status_code, 422)
        popen.assert_not_called()

    def test_disabled_services_not_started(self):
        owner = Launcher(prefs.StartupSettings(backend=False, frontend=False, qq_bridge=False, desktop_pet=False))
        owner.stopping.set()
        with patch.object(owner, "start_control"), patch.object(owner, "spawn") as spawn, \
             patch.object(owner, "start_feature") as feature:
            owner.run()
        spawn.assert_not_called()
        feature.assert_not_called()

    def test_control_auth_and_duplicate_restart(self):
        import urllib.error

        owner = Launcher(prefs.StartupSettings())
        owner.start_control()
        self.addCleanup(owner.control.server_close)
        self.addCleanup(owner.control.shutdown)
        port = owner.control.server_port
        with self.assertRaises(urllib.error.HTTPError) as error:
            request_json(port, "/restart", {})
        self.assertEqual(error.exception.code, 403)
        error.exception.close()
        from app import runtime
        with patch.dict(os.environ, {"XTR_LAUNCHER_URL": f"http://127.0.0.1:{port}",
                                    "XTR_LAUNCHER_TOKEN": owner.token}):
            runtime.restart()
            self.assertEqual(owner.commands.get_nowait(), "restart")
            with self.assertRaises(urllib.error.HTTPError) as error:
                runtime.restart()
        self.assertEqual(error.exception.code, 409)
        error.exception.close()

    def test_cleanup_legacy_uses_exact_repo_and_service_boundary(self):
        from app import launcher
        old = Mock(pid=101)
        old.cmdline.return_value = ["python.exe", "-m", "uvicorn", "app.main:app"]
        old.cwd.return_value = str(launcher.BACKEND)
        old.children.return_value = []
        other = Mock(pid=102)
        other.cmdline.return_value = old.cmdline.return_value
        other.cwd.return_value = str(launcher.BACKEND) + "-other"
        me = Mock()
        me.parents.return_value = []
        with patch.object(launcher.psutil, "Process", return_value=me), \
             patch.object(launcher.psutil, "process_iter", return_value=[old, other]), \
             patch.object(launcher.psutil, "wait_procs", return_value=([], [])):
            launcher.cleanup_legacy()
        old.kill.assert_called_once()
        other.kill.assert_not_called()


def job_fixture(path: str):
    """Create a hidden detached child and grandchild, then wait to be closed."""
    from app.windows_job import WindowsJob
    job = WindowsJob()
    grandchild_code = "import time; time.sleep(300)"
    child_code = (
        "import subprocess,sys,time,json,os; from pathlib import Path; "
        "from app.windows_job import WindowsJob; job=WindowsJob(); "
        f"p=subprocess.Popen([sys.executable,'-c',{grandchild_code!r}],creationflags="
        "subprocess.CREATE_NEW_PROCESS_GROUP|subprocess.CREATE_NO_WINDOW); "
        f"Path({(path + '.child')!r}).write_text(json.dumps([os.getpid(),p.pid])); time.sleep(300)"
    )
    child = subprocess.Popen([sys.executable, "-c", child_code],
                             creationflags=subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW)
    kernel = ctypes.WinDLL("kernel32")
    kernel.GetConsoleWindow.restype = ctypes.c_void_p
    Path(path).write_text(json.dumps({"pid": os.getpid(), "child": child.pid, "window": kernel.GetConsoleWindow()}))
    time.sleep(300)
    job.close()


def backend_fixture(port: int):
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from app import runtime

    state = {"hung": False}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def reply(self, body):
            data = json.dumps(body).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if state["hung"]:
                time.sleep(120)
            self.reply({"status": "ok", **runtime.info()})

        def do_POST(self):
            if self.path == "/hang":
                state["hung"] = True
            else:
                runtime.restart()
                runtime.exit_soon()
            self.reply({"ok": True})

    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()


def owner_fixture(path: str, port: int):
    import app.launcher as module
    from app.windows_job import WindowsJob
    job = WindowsJob()
    module.LOGS = Path(path).parent

    class Owner(Launcher):
        def start_backend(self):
            self.backend_ready = False
            self.spawn("backend", [sys.executable, "-m", "tests.test_launcher", "--backend-fixture", str(port)], module.BACKEND)
            self.wait_backend()

        def start_control(self):
            super().start_control()
            companion = self.spawn("companion", [sys.executable, "-c", "import time; time.sleep(300)"], module.BACKEND)
            Path(path).write_text(json.dumps({"pid": os.getpid(), "companion": companion.pid}))

    owner = Owner(prefs.StartupSettings(frontend=False, qq_bridge=False, desktop_pet=False), backend_port=port)
    owner.run()
    job.close()


@unittest.skipUnless(os.name == "nt", "Windows console and Job behavior")
class WindowsLifecycleTests(unittest.TestCase):
    def check_shutdown(self, close_window: bool):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "identity.json"
            startup = subprocess.STARTUPINFO()
            startup.dwFlags = subprocess.STARTF_USESHOWWINDOW
            startup.wShowWindow = 0
            proc = subprocess.Popen([sys.executable, "-m", "tests.test_launcher", "--job-fixture", str(path)],
                                    creationflags=subprocess.CREATE_NEW_CONSOLE, startupinfo=startup,
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            tracked = []
            try:
                deadline = time.monotonic() + 15
                while time.monotonic() < deadline:
                    try:
                        parent = json.loads(path.read_text())
                        child = json.loads(Path(str(path) + ".child").read_text())
                        break
                    except (FileNotFoundError, ValueError):
                        time.sleep(0.1)
                else:
                    self.fail("Fixture did not start nested Job descendants")
                ids = {parent["pid"], parent["child"], *child}
                tracked = [psutil.Process(pid) for pid in ids]
                if close_window:
                    self.assertTrue(parent["window"], "Fixture has no console window")
                    from ctypes import wintypes
                    user = ctypes.WinDLL("user32", use_last_error=True)
                    user.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
                    self.assertTrue(user.PostMessageW(parent["window"], 0x0010, 0, 0))  # WM_CLOSE = clicking X.
                else:
                    psutil.Process(parent["pid"]).kill()
                _, alive = psutil.wait_procs(tracked, timeout=15)
                self.assertEqual([p.pid for p in alive], [], "Detached descendants survived launcher exit")
                proc.wait(timeout=5)
            finally:
                for process in tracked:
                    if process.is_running():
                        with contextlib.suppress(psutil.NoSuchProcess):
                            process.kill()
                if proc.poll() is None:
                    proc.kill()
                proc.wait(timeout=5)

    def test_click_console_close_kills_nested_detached_descendants(self):
        self.check_shutdown(True)

    def test_launcher_crash_kills_nested_detached_descendants(self):
        self.check_shutdown(False)

    def test_three_restarts_and_hung_backend_recovery_keep_companion_and_ownership(self):
        import socket
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "owner.json"
            proc = subprocess.Popen([sys.executable, "-m", "tests.test_launcher", "--owner-fixture", str(path), str(port)],
                                    creationflags=subprocess.CREATE_NO_WINDOW, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                    env={**os.environ, "PYTHONIOENCODING": "utf-8"})
            output = []
            reader = threading.Thread(target=lambda: output.extend(iter(proc.stdout.readline, b"")), daemon=True)
            reader.start()
            def logs():
                return b"".join(output).decode("utf-8", errors="replace")
            owner = None
            companion = None
            servers = []
            try:
                deadline = time.monotonic() + 15
                while time.monotonic() < deadline:
                    try:
                        identity = json.loads(path.read_text())
                        owner = psutil.Process(identity["pid"])
                        companion = psutil.Process(identity["companion"])
                        first = request_json(port, "/api/health", timeout=1)
                        break
                    except (OSError, ValueError, psutil.Error):
                        time.sleep(0.2)
                else:
                    self.fail(logs())
                old = first["pid"]
                for attempt in range(4):
                    servers.append(psutil.Process(old))
                    if attempt < 3:
                        try:
                            request_json(port, "/api/system/restart", {}, timeout=4)
                        except Exception as exc:
                            self.fail(f"Restart {attempt}: {exc}\n" + logs())
                    else:
                        request_json(port, "/hang", {}, timeout=2)
                    deadline = time.monotonic() + (30 if attempt == 3 else 12)
                    while time.monotonic() < deadline:
                        try:
                            health = request_json(port, "/api/health", timeout=1)
                            if health["pid"] != old:
                                break
                        except (OSError, ValueError):
                            pass
                        time.sleep(0.2)
                    else:
                        self.fail(logs())
                    self.assertFalse(servers[-1].is_running(), "Old server survived restart")
                    self.assertTrue(companion.is_running(), "Restart stopped another managed service")
                    old = health["pid"]
                    time.sleep(0.7)  # Allow the owner to confirm readiness and clear its restart guard.
                servers.append(psutil.Process(old))
                descendants = owner.children(recursive=True)
                owner.kill()
                _, alive = psutil.wait_procs(descendants, timeout=10)
                self.assertEqual([p.pid for p in alive], [])
                self.assertFalse(companion.is_running())
            finally:
                remaining = []
                if owner and owner.is_running():
                    remaining = owner.children(recursive=True)
                    owner.kill()
                for process in [companion, *servers]:
                    if process and process.is_running():
                        with contextlib.suppress(psutil.NoSuchProcess):
                            process.kill()
                if proc.poll() is None:
                    proc.kill()
                proc.wait(timeout=5)
                psutil.wait_procs([*remaining, *([owner] if owner else [])], timeout=10)
                proc._handle.Close()
                reader.join(timeout=5)
                proc.stdout.close()


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--job-fixture":
        job_fixture(sys.argv[2])
    elif len(sys.argv) > 1 and sys.argv[1] == "--backend-fixture":
        backend_fixture(int(sys.argv[2]))
    elif len(sys.argv) > 1 and sys.argv[1] == "--owner-fixture":
        owner_fixture(sys.argv[2], int(sys.argv[3]))
    else:
        unittest.main()
