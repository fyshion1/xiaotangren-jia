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
        # 逛 B站 只读标题/简介/弹幕（文字），不吃视觉 —— 视觉路留给以后的「一起看」
        self.assertFalse(vision["bilibili_scout"])
        self.assertTrue(vision["qq_bridge"])
        self.assertFalse(vision["dont_starve_together"])

    def test_runner_commands_come_from_registry(self):
        """启动按钮的命令清单来自注册表；本体不接受前端传任意命令。"""
        payload = self.client.get("/api/nest/features").json()
        scout = next(f for f in payload["items"] if f["id"] == "bilibili_scout")
        names = [c["name"] for c in scout["runner"]["commands"]]
        self.assertEqual(names, ["dry", "run", "watch"])
        characters_cmd = next(c for c in scout["runner"]["commands"] if c["name"] == "run")
        self.assertIn("characters", characters_cmd["params"])
        # 循环类子命令要标 background，后端才知道「立刻回 pid、别等它跑完」
        watch = next(c for c in scout["runner"]["commands"] if c["name"] == "watch")
        self.assertTrue(watch.get("background"))
        self.assertNotIn("background", characters_cmd)
        # 还没接 runner 的功能不该冒出启动入口
        dst = next(f for f in payload["items"] if f["id"] == "dont_starve_together")
        self.assertIsNone(dst["runner"])

    def test_qq_bridge_is_runnable_and_persistent(self):
        """QQ 桥接进来了：有启动入口，run 是常驻（自检 / 看演谁 是一次性）。"""
        payload = self.client.get("/api/nest/features").json()
        bridge = next(f for f in payload["items"] if f["id"] == "qq_bridge")
        commands = {c["name"]: c for c in bridge["runner"]["commands"]}
        self.assertEqual(sorted(commands), ["check", "run", "whoami"])
        self.assertTrue(commands["run"].get("background"))
        self.assertFalse(commands["check"].get("background", False))

    def test_run_rejects_unknown_command(self):
        """白名单之外子命令一律拒 —— 前端拼不出任意命令。"""
        r = self.client.post("/api/nest/features/bilibili_scout/run",
                             json={"command": "rm -rf /", "limit": 3})
        self.assertEqual(r.status_code, 422)

    def test_run_404_for_feature_without_runner(self):
        r = self.client.post("/api/nest/features/dont_starve_together/run", json={"command": "run"})
        self.assertEqual(r.status_code, 404)

    def test_build_command_only_whitelisted_flags(self):
        """argv 由注册表拼出：没声明的参数（这里 dry 不接受 characters）不出现。"""
        runner = nest.runner_of("bilibili_scout")
        body = nest.RunIn(command="dry", limit=7, interval=9, character_ids=["x"])
        argv, spec = nest._build_command(runner, {"name": "dry"}, body)
        self.assertIn("--limit", argv)
        self.assertEqual(argv[argv.index("--limit") + 1], "7")
        self.assertNotIn("--characters", argv)   # dry 的 params 里没有 characters
        self.assertNotIn("--interval", argv)

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
        # 用 qq_bridge 试视觉路：它在注册表里声明 needs_vision=True。
        return {"feature_id": "qq_bridge", "character_id": "test",
                "messages": [{"role": "user", "content": "看看这个"}], **extra}

    def test_chat_images_rejected_for_text_only_feature(self):
        """逛 B站 只读文字（needs_vision=False）→ 带图直接拒，不偷偷走视觉路。"""
        self.client.put("/api/nest/api-config", json={
            "base_url": "https://brain/v1", "api_key": "k", "model": "m", "vision_model": "vm"})
        with patch.object(nest.db, "get_character", return_value={"name": "t", "about": "x"}), \
             patch.object(nest.openai, "stream_chat_retry") as upstream:
            r = self.client.post("/api/nest/chat", json={
                "feature_id": "bilibili_scout", "character_id": "test",
                "messages": [{"role": "user", "content": "看图"}],
                "images": ["data:image/png;base64,AAAA"]})
            self.assertEqual(r.status_code, 409)
            upstream.assert_not_called()

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


class NestChatMemoryRecallTests(unittest.TestCase):
    """QQ 桥要走普通聊天那套长期记忆召回；别的功能默认不动。"""

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
        self.client.put("/api/nest/api-config", json={
            "base_url": "https://brain/v1", "api_key": "k", "model": "chat-model"})
        self.captured: dict = {}

    def tearDown(self):
        self.tmp.cleanup()

    def _post(self, feature_id: str, text: str = "你记得我家猫叫什么吗", **extra):
        async def fake_stream(messages, model, base_url, api_key="", **kw):
            self.captured["messages"] = messages
            yield {"type": "text", "text": "记得"}
            yield {"type": "done", "finish_reason": "stop"}

        with patch.object(nest.db, "get_character", return_value={"name": "糖糖", "about": "x"}), \
             patch.object(nest.openai, "stream_chat_retry", side_effect=fake_stream):
            r = self.client.post("/api/nest/chat", json={
                "feature_id": feature_id, "character_id": "dashiyin",
                "messages": [{"role": "user", "content": text}], **extra})
        self.assertEqual(r.status_code, 200)
        return self.captured["messages"][0]["content"]

    def _seed(self, game_id: str = ""):
        db.add_memory("home", "家里养了一只叫团子的猫", fingerprint="h1", game_id=game_id)
        db.add_memory("personal", "团子最喜欢睡在窗台上", char_id="dashiyin",
                      fingerprint="p1", game_id=game_id)

    def test_qq_bridge_recalls_shared_memories_by_default(self):
        self._seed()
        system = self._post("qq_bridge")
        self.assertIn("家里养了一只叫团子的猫", system)
        self.assertIn("团子最喜欢睡在窗台上", system)

    def test_other_features_do_not_recall_by_default(self):
        self._seed()
        self.assertNotIn("团子", self._post("bilibili_scout"))

    def test_opt_in_flag_enables_recall_for_any_feature(self):
        self._seed()
        self.assertIn("团子", self._post("bilibili_scout", memory_recall=True))

    def test_recall_uses_shared_memory_even_when_isolation_is_on(self):
        """记忆隔离只管**写**（提炼进哪个命名空间）；召回永远走日常聊天那一桶。

        QQ 桥要的是「和群聊 / 私聊是同一个大脑」，不该因为那个开关就看不见家里的记忆。
        """
        self._seed()
        db.add_memory("home", "QQ 群里约好了周末去爬山", fingerprint="q1", game_id="qq_bridge")
        self.client.put("/api/nest/features/qq_bridge/settings",
                        json={"values": {"memory.isolate": True}})
        system = self._post("qq_bridge")
        self.assertIn("家里养了一只叫团子的猫", system)
        self.assertNotIn("周末去爬山", system)

    def test_recall_failure_does_not_break_chat(self):
        with patch.object(nest.memory_service, "recall_for", side_effect=RuntimeError("boom")):
            system = self._post("qq_bridge")
        self.assertNotIn("长期记忆", system)
        self.assertTrue(system.startswith("你是糖糖"))


class FeatureSettingsTests(unittest.TestCase):
    """功能设置（§9.6.5）：声明归功能、值归本体，前端照着 schema 渲染。

    这里守的是「别让前端顺手改点别的」这条边界 —— 只认注册表声明过的 key。
    """

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

    def test_schema_comes_from_registry_with_defaults(self):
        r = self.client.get("/api/nest/features/qq_bridge/settings")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        keys = {f["key"] for f in body["schema"]}
        self.assertIn("allow.groups", keys)
        self.assertIn("tools.allow", keys)
        # 没存过 → 值就是声明里的默认值。
        self.assertFalse(body["configured"])
        self.assertEqual(body["values"]["allow.groups"], [])

    def test_invert_flag_is_passed_through_untouched(self):
        """名字反着写的开关（`memory.isolate`）：本体不解释 `invert`，值永远是存储语义。

        前端把「和群聊 / 私聊共享记忆」显示成勾上，勾上存的是 `isolate=False`；
        本体这边**照原样**收发 —— default 不翻、PUT 进来的也不翻。翻了就全反了。
        """
        body = self.client.get("/api/nest/features/qq_bridge/settings").json()
        field = next(f for f in body["schema"] if f["key"] == "memory.isolate")
        self.assertTrue(field["invert"])
        # 默认值仍是存储语义：False = 不隔离 = 共享（前端把它显示成勾上）。
        self.assertFalse(field["default"])
        self.assertFalse(body["values"]["memory.isolate"])
        # 存进去什么就是什么，本体不做任何取反。
        saved = self.client.put("/api/nest/features/qq_bridge/settings",
                                json={"values": {"memory.isolate": True}}).json()
        self.assertTrue(saved["values"]["memory.isolate"])

    def test_put_then_get_round_trip(self):
        r = self.client.put("/api/nest/features/qq_bridge/settings", json={
            "values": {"allow.groups": "123456, 789", "voice.auto": "always",
                       "tools.enabled": False, "sticker.reply_chance": 0.2}})
        self.assertEqual(r.status_code, 200)
        values = r.json()["values"]
        self.assertEqual(values["allow.groups"], ["123456", "789"])   # 逗号串 → 列表
        self.assertEqual(values["voice.auto"], "always")
        self.assertEqual(values["sticker.reply_chance"], 0.2)
        again = self.client.get("/api/nest/features/qq_bridge/settings").json()
        self.assertTrue(again["configured"])
        self.assertEqual(again["values"]["allow.groups"], ["123456", "789"])

    def test_unknown_key_is_dropped_and_reported(self):
        r = self.client.put("/api/nest/features/qq_bridge/settings", json={
            "values": {"不是声明过的": 1, "allow.groups": ["1"]}})
        body = r.json()
        self.assertIn("不是声明过的", body["ignored"])
        self.assertNotIn("不是声明过的", body["values"])
        self.assertEqual(body["values"]["allow.groups"], ["1"])

    def test_select_only_accepts_declared_options(self):
        r = self.client.put("/api/nest/features/qq_bridge/settings",
                            json={"values": {"voice.auto": "乱填的"}})
        self.assertEqual(r.json()["values"]["voice.auto"], "mirror")   # 回落到声明里的默认

    def test_number_out_of_range_is_422(self):
        r = self.client.put("/api/nest/features/qq_bridge/settings",
                            json={"values": {"sticker.reply_chance": 5}})
        self.assertEqual(r.status_code, 422)

    def test_accounts_rows_are_validated(self):
        r = self.client.put("/api/nest/features/qq_bridge/settings", json={"values": {"accounts": [
            {"name": "大号", "self_id": "553350415", "persona": "dalaoda", "groups": "123,456",
             "enabled": True, "塞进来的别的字段": "丢掉"},
            {"name": "", "self_id": "", "persona": ""},     # 全空行不留
        ]}})
        rows = r.json()["values"]["accounts"]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["groups"], ["123", "456"])
        self.assertNotIn("塞进来的别的字段", rows[0])

    def test_unknown_feature_is_404(self):
        self.assertEqual(self.client.get("/api/nest/features/不存在/settings").status_code, 404)


class ToolTurnTests(unittest.TestCase):
    """工具轮（§9.6.6）：本体**只回模型的决定，一个动作都不执行**。"""

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

    def _body(self, **over):
        body = {"feature_id": "qq_bridge", "character_id": "dalaoda",
                "messages": [{"role": "user", "content": "看看沙箱里有什么"}],
                "tools": [{"type": "function", "function": {
                    "name": "local_dir", "description": "看目录",
                    "parameters": {"type": "object", "properties": {}}}}]}
        body.update(over)
        return body

    def test_unconfigured_upstream_is_409(self):
        # 没配 API 时，本体必须先说「你还没配」——这条比「角色不存在」更接近大老大的处境，
        # 所以注册一个角色再断言。
        with patch.object(nest.db, "get_character", return_value={"name": "t", "about": "x"}):
            self.assertEqual(self.client.post("/api/nest/tool-turn", json=self._body()).status_code, 409)

    def test_tool_calls_are_forwarded_not_executed(self):
        self.client.put("/api/nest/api-config", json={
            "base_url": "https://brain/v1", "api_key": "k", "model": "chat-model"})
        captured: dict = {}

        async def fake_full(messages, model, base_url, api_key="", **kw):
            captured.update(model=model, tools=kw.get("tools"), messages=messages)
            # 上游（OpenAI 兼容）的 tool_calls 是嵌套形状，本体只做扁平化透传。
            return {"content": "", "finish_reason": "tool_calls",
                    "tool_calls": [{"id": "c1", "function": {"name": "local_dir", "arguments": "{}"}}]}

        with patch.object(nest.db, "get_character", return_value={"name": "t", "about": "x"}), \
             patch.object(nest.openai, "complete_chat_full", side_effect=fake_full):
            r = self.client.post("/api/nest/tool-turn", json=self._body())
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual(body["tool_calls"][0]["name"], "local_dir")
        self.assertEqual(body["finish_reason"], "tool_calls")
        # 工具声明原样转给了上游；本体自己没执行任何东西（没有文件系统调用，只有模型调用）。
        self.assertEqual(captured["tools"][0]["function"]["name"], "local_dir")

    def test_role_tool_result_is_accepted(self):
        self.client.put("/api/nest/api-config", json={
            "base_url": "https://brain/v1", "api_key": "k", "model": "chat-model"})
        seen: dict = {}

        async def fake_full(messages, model, base_url, api_key="", **kw):
            seen["messages"] = messages
            return {"content": "里面有一个文件", "tool_calls": [], "finish_reason": "stop"}

        with patch.object(nest.db, "get_character", return_value={"name": "t", "about": "x"}), \
             patch.object(nest.openai, "complete_chat_full", side_effect=fake_full):
            r = self.client.post("/api/nest/tool-turn", json=self._body(messages=[
                {"role": "user", "content": "看看沙箱"},
                {"role": "assistant", "content": "", "tool_calls": [
                    {"id": "c1", "name": "local_dir", "arguments": "{}"}]},
                {"role": "tool", "tool_call_id": "c1", "content": "笔记.txt"},
            ]))
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["content"], "里面有一个文件")
        roles = [m["role"] for m in seen["messages"]]
        self.assertIn("tool", roles)


if __name__ == "__main__":
    unittest.main()