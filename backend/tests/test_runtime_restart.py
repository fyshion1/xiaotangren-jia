"""顶栏那颗「大脑活着」的灯 + 一键重启（Block 二 ①）。

重启这事**绝不能真跑** —— 真跑会把测试进程 `os._exit(0)` 掉，所以：
`runtime.exit_soon` 一律打桩，`subprocess.Popen` 一律打桩（不真起中间人）。
这里验的是「话怎么说、顺序对不对」，不是「进程真换没换」。
"""

import unittest
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import runtime


def _client() -> TestClient:
    app = FastAPI()
    from app import main  # noqa: F401 —— 只用它的两个路由，不要它的 lifespan

    app.add_api_route("/api/health", main.health, methods=["GET"])
    app.add_api_route("/api/system/restart", main.system_restart, methods=["POST"])
    return TestClient(app)


class BrainHealthTests(unittest.TestCase):
    def setUp(self):
        self.client = _client()
        self.addCleanup(self.client.close)

    def test_health_reports_uptime(self):
        """① 的灯要有东西可显示：什么时候起的、活了多久、是不是同一个进程。"""
        body = self.client.get("/api/health").json()
        self.assertEqual(body["status"], "ok")
        self.assertEqual(body["name"], "小糖人之家")
        self.assertTrue(body["started_at"])
        self.assertEqual(body["pid"], runtime.PID)
        self.assertGreaterEqual(body["uptime_seconds"], 0)

    def test_restart_hands_off_to_helper(self):
        """接口该做的：叫起中间人 → 回话 → 才安排退位（顺序反了前端只会看到连接被掐）。"""
        calls: list[str] = []
        with patch.object(runtime, "restart", side_effect=lambda: calls.append("spawn") or runtime.LOG_DIR / "brain-x.log"), \
             patch.object(runtime, "exit_soon", side_effect=lambda: calls.append("exit")):
            resp = self.client.post("/api/system/restart")
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(resp.json()["ok"])
        # 先叫新进程、后退位 —— 反了端口没人接
        self.assertEqual(calls, ["spawn", "exit"])

    def test_restart_keeps_running_brain_alive(self):
        """中间人起不来就回 500，**当前这个大脑不跟着陪葬**（不安排退位）。"""
        with patch.object(runtime, "restart", side_effect=OSError("nope")), \
             patch.object(runtime, "exit_soon") as exit_soon:
            resp = self.client.post("/api/system/restart")
        self.assertEqual(resp.status_code, 500)
        exit_soon.assert_not_called()

    def test_helper_argv_is_this_interpreter(self):
        """中间人必须用**同一个解释器**（venv 里那个）和 backend/ 工作目录 —— 否则 import 不到 app。"""
        with patch("subprocess.Popen") as popen, \
             patch.object(runtime, "exit_soon"):
            runtime.restart()
        argv = popen.call_args.args[0]
        self.assertEqual(argv[1:3], ["-m", "app.restart_helper"])
        self.assertEqual(popen.call_args.kwargs["cwd"], str(runtime.BACKEND_DIR))


class RestartHelperTests(unittest.TestCase):
    def test_port_free_probe(self):
        """中间人靠「能不能 bind」判断端口腾没腾出来 —— 自己占着的时候必须判为没空。"""
        import socket

        from app import restart_helper

        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as held:
            held.bind(("127.0.0.1", 0))
            held.listen(1)
            port = held.getsockname()[1]
            self.assertFalse(restart_helper._port_free("127.0.0.1", port))
        self.assertTrue(restart_helper._port_free("127.0.0.1", port))


if __name__ == "__main__":
    unittest.main()