import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import db
from app.routers import nest


class NestRouterTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = patch.object(db, "DB_PATH", Path(self.tmp.name) / "test.db")
        self.path.start()
        self.addCleanup(self.path.stop)
        db.DATA_DIR.mkdir(parents=True, exist_ok=True)
        with db._tx() as conn:
            conn.executescript(db._SCHEMA)
            db._migrate(conn)
        app = FastAPI()
        app.include_router(nest.router, prefix="/api")
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def tearDown(self):
        self.tmp.cleanup()

    def test_features_come_from_registry(self):
        payload = self.client.get("/api/nest/features").json()
        ids = {f["id"] for f in payload["items"]}
        self.assertIn("bilibili_scout", ids)
        self.assertIn("qq_bridge", ids)
        # 视觉需求是注册表声明的事实，不是前端写死的
        vision = {f["id"]: f["needs_vision"] for f in payload["items"]}
        self.assertTrue(vision["bilibili_scout"])
        self.assertFalse(vision["dont_starve_together"])

    def test_feature_config_falls_back_to_global_default(self):
        self.client.put("/api/nest/api-config", json={
            "base_url": "https://brain.example/v1", "api_key": "brain-key", "model": "brain-model",
            "vision_model": "brain-vision",
        })
        eff = self.client.get("/api/nest/features/qq_bridge/api-config").json()
        self.assertEqual(eff["source"], "global_default")
        self.assertEqual(eff["base_url"], "https://brain.example/v1")
        # 视觉没单独配 base_url / key → 回退普通路
        self.assertEqual(eff["vision_base_url"], "https://brain.example/v1")
        self.assertEqual(eff["vision_api_key"], "brain-key")
        self.assertEqual(eff["vision_model"], "brain-vision")

    def test_feature_override_wins_then_delete_restores_default(self):
        self.client.put("/api/nest/api-config", json={
            "base_url": "https://brain.example/v1", "api_key": "brain-key", "model": "brain-model"})
        saved = self.client.put("/api/nest/features/bilibili_scout/api-config", json={
            "name": "B站专用", "base_url": "https://bili.example/v1", "api_key": "bili-key",
            "model": "bili-model"}).json()
        self.assertEqual(saved["source"], "feature_override")
        self.assertEqual(saved["base_url"], "https://bili.example/v1")
        override_id = saved["override"]["id"]
        self.assertEqual(self.client.delete(
            f"/api/nest/features/bilibili_scout/api-config/{override_id}").json()["source"], "global_default")

    def test_needs_vision_false_hides_vision_route(self):
        self.client.put("/api/nest/api-config", json={
            "base_url": "https://brain.example/v1", "api_key": "brain-key", "model": "brain-model",
            "vision_model": "brain-vision"})
        eff = self.client.put("/api/nest/features/qq_bridge/api-config", json={
            "name": "默认", "base_url": "https://brain.example/v1", "api_key": "brain-key",
            "model": "brain-model", "needs_vision": False}).json()
        self.assertFalse(eff["needs_vision"])
        self.assertEqual(eff["vision_model"], "")
        self.assertEqual(eff["vision_api_key"], "")

    def test_chat_requires_configured_upstream(self):
        body = {"feature_id": "bilibili_scout", "character_id": "test",
                "messages": [{"role": "user", "content": "hello"}]}
        with patch.object(nest.db, "get_character", return_value={"name": "test", "about": "x"}), \
             patch.object(nest.openai, "stream_chat_retry") as upstream:
            self.assertEqual(self.client.post("/api/nest/chat", json=body).status_code, 409)
            upstream.assert_not_called()

    def test_global_default_requires_base_url(self):
        self.assertEqual(self.client.put("/api/nest/api-config", json={"base_url": ""}).status_code, 422)
        self.assertFalse(self.client.get("/api/nest/api-config").json()["configured"])


if __name__ == "__main__":
    unittest.main()