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

    # ---- 通用功能动态流（§9.6）----

    def test_feed_push_list_and_status(self):
        pushed = self.client.post("/api/nest/feed", json={
            "feature_id": "bilibili_scout", "kind": "video", "title": "一个插件推荐",
            "url": "https://www.bilibili.com/video/BV1xx", "summary": "挺有用",
            "cover": "https://i0.hdslb.com/x.jpg", "payload": {"bvid": "BV1xx", "score": 8},
        }).json()
        self.assertTrue(pushed["registered"])
        item = pushed["item"]
        self.assertEqual(item["status"], "new")
        self.assertEqual(item["payload"]["score"], 8)

        listed = self.client.get("/api/nest/feed").json()["items"]
        self.assertEqual(len(listed), 1)
        # 只看某个功能的
        self.assertEqual(self.client.get("/api/nest/feed?feature_id=qq_bridge").json()["items"], [])

        self.client.put(f"/api/nest/feed/{item['id']}", json={"status": "saved"})
        self.assertEqual(self.client.get("/api/nest/feed?status=saved").json()["items"][0]["id"], item["id"])

    def test_feed_same_url_updates_instead_of_duplicating(self):
        """同一个视频被小糖人刷到两次，应该更新那条而不是堆两条。"""
        body = {"feature_id": "bilibili_scout", "title": "旧标题", "url": "https://b/bv1"}
        first = self.client.post("/api/nest/feed", json=body).json()["item"]
        second = self.client.post("/api/nest/feed", json={**body, "title": "新标题"}).json()["item"]
        self.assertEqual(first["id"], second["id"])
        self.assertEqual(second["title"], "新标题")
        self.assertEqual(len(self.client.get("/api/nest/feed").json()["items"]), 1)

    def test_feed_accepts_unregistered_feature_but_flags_it(self):
        r = self.client.post("/api/nest/feed", json={
            "feature_id": "my_own_thing", "title": "自定义功能推的"}).json()
        self.assertFalse(r["registered"])
        self.assertEqual(r["item"]["feature_id"], "my_own_thing")

    def test_feed_delete(self):
        item = self.client.post("/api/nest/feed", json={
            "feature_id": "qq_bridge", "title": "删我"}).json()["item"]
        self.assertEqual(self.client.delete(f"/api/nest/feed/{item['id']}").status_code, 200)
        self.assertEqual(self.client.get("/api/nest/feed").json()["items"], [])
        self.assertEqual(self.client.delete(f"/api/nest/feed/{item['id']}").status_code, 404)

    # ---- 通用对话的视觉路（§9.6）----

    def _chat_body(self, **extra):
        return {"feature_id": "bilibili_scout", "character_id": "test",
                "messages": [{"role": "user", "content": "看看这个"}], **extra}

    def test_chat_rejects_non_data_url_images(self):
        self.client.put("/api/nest/api-config", json={
            "base_url": "https://brain/v1", "api_key": "k", "model": "m", "vision_model": "vm"})
        with patch.object(nest.db, "get_character", return_value={"name": "t", "about": "x"}):
            r = self.client.post("/api/nest/chat", json=self._chat_body(images=["https://evil/x.png"]))
            self.assertEqual(r.status_code, 422)

    def test_chat_with_images_uses_vision_route(self):
        self.client.put("/api/nest/api-config", json={
            "base_url": "https://brain/v1", "api_key": "k", "model": "chat-model",
            "vision_base_url": "https://vision/v1", "vision_api_key": "vk", "vision_model": "vision-model"})
        captured: dict = {}

        async def fake_stream(messages, model, base_url, api_key="", **kw):
            captured.update(messages=messages, model=model, base_url=base_url, api_key=api_key)
            yield {"type": "text", "text": "看完了"}
            yield {"type": "done", "finish_reason": "stop"}

        with patch.object(nest.db, "get_character", return_value={"name": "t", "about": "x"}), \
             patch.object(nest.openai, "stream_chat_retry", side_effect=fake_stream):
            r = self.client.post("/api/nest/chat", json=self._chat_body(
                images=["data:image/png;base64,AAAA"]))
        self.assertEqual(r.status_code, 200)
        # 带图 → 走视觉路，而不是普通路
        self.assertEqual(captured["model"], "vision-model")
        self.assertEqual(captured["base_url"], "https://vision/v1")
        self.assertEqual(captured["api_key"], "vk")
        user_turn = captured["messages"][1]
        self.assertIsInstance(user_turn["content"], list)
        self.assertEqual(user_turn["content"][1]["image_url"]["url"], "data:image/png;base64,AAAA")

    def test_chat_vision_blocked_feature_cannot_send_images(self):
        """qq_bridge 声明 needs_vision=True；显式屏蔽后就该拒图。"""
        self.client.put("/api/nest/api-config", json={
            "base_url": "https://brain/v1", "api_key": "k", "model": "m", "vision_model": "vm"})
        self.client.put("/api/nest/features/qq_bridge/api-config", json={
            "name": "无视觉", "base_url": "https://brain/v1", "api_key": "k", "model": "m",
            "needs_vision": False})
        with patch.object(nest.db, "get_character", return_value={"name": "t", "about": "x"}), \
             patch.object(nest.openai, "stream_chat_retry") as upstream:
            r = self.client.post("/api/nest/chat", json={
                "feature_id": "qq_bridge", "character_id": "test",
                "messages": [{"role": "user", "content": "看图"}],
                "images": ["data:image/png;base64,AAAA"]})
            self.assertEqual(r.status_code, 409)
            upstream.assert_not_called()

    def test_chat_without_images_stays_on_normal_route(self):
        self.client.put("/api/nest/api-config", json={
            "base_url": "https://brain/v1", "api_key": "k", "model": "chat-model",
            "vision_model": "vision-model"})
        captured: dict = {}

        async def fake_stream(messages, model, base_url, api_key="", **kw):
            captured.update(model=model, base_url=base_url)
            yield {"type": "text", "text": "好"}

        with patch.object(nest.db, "get_character", return_value={"name": "t", "about": "x"}), \
             patch.object(nest.openai, "stream_chat_retry", side_effect=fake_stream):
            self.client.post("/api/nest/chat", json=self._chat_body())
        self.assertEqual(captured["model"], "chat-model")


if __name__ == "__main__":
    unittest.main()