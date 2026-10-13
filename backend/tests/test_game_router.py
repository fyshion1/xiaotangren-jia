import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import db
from app.routers import game


class GameRouterTests(unittest.TestCase):
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
        app.include_router(game.router, prefix="/api")
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def tearDown(self):
        self.tmp.cleanup()

    def test_event_state_and_command_lifecycle(self):
        r = self.client.post("/api/game/events", json={"game_id":"demo","world_id":"w1","state":{"day":3},"event":{"type":"tick"}})
        self.assertEqual(r.status_code, 200)
        r = self.client.post("/api/game/commands", json={"game_id":"demo","world_id":"w1","command":{"type":"FOLLOW"}})
        self.assertEqual(r.json()["status"], "queued")
        command_id = r.json()["id"]
        self.assertEqual(self.client.get("/api/game/commands?game_id=demo&world_id=w1").json()["items"][0]["id"], command_id)
        self.assertEqual(self.client.post(f"/api/game/commands/{command_id}/result", json={"status":"completed","result":{"ok":True}}).status_code, 200)
        self.assertEqual(self.client.get("/api/game/commands?game_id=demo&world_id=w1&status=queued").json()["items"], [])

    def test_game_world_is_required(self):
        self.assertEqual(self.client.post("/api/game/events", json={"game_id":"demo","state":{}}).status_code, 422)
        self.assertEqual(self.client.post("/api/game/commands", json={"game_id":"demo","world_id":"w1","command":{}}).status_code, 400)

    def test_chat_json_and_sse_without_external_calls(self):
        db.upsert_game_api_config("demo", "game", "https://game.example/v1", "test-game-key", "game-model")
        async def reply(*args, **kwargs):
            self.assertEqual(args[0][-1]["content"], "hello")
            self.assertEqual(args[1:4], ("game-model", "https://game.example/v1", "test-game-key"))
            self.assertIn("最多120个汉字", args[0][0]["content"])
            yield {"type": "text", "text": "hi"}
            yield {"type": "done", "finish_reason": "length"}
        body = {"game_id": "demo", "world_id": "w1", "player_id": "p1",
                "character_id": "test", "messages": [{"role": "user", "content": "hello"}]}
        with patch.object(game.db, "get_character", return_value={"name": "test", "about": "test"}), patch.object(game.openai, "stream_chat_retry", reply):
            result = self.client.post("/api/game/chat", json=body)
            self.assertEqual(result.status_code, 200)
            self.assertEqual(result.json()["finish_reason"], "length")
            self.assertEqual(result.json()["message"]["content"], "hi")
            streamed = self.client.post("/api/game/chat", json={**body, "stream": True})
            self.assertIn("event: token", streamed.text)
            self.assertIn("event: done", streamed.text)
        self.assertEqual(db.list_memories(), [])

    def test_game_chat_requires_own_provider_config(self):
        db.upsert_game_api_config("other-game", "game", "https://other.example/v1", "test-key", "model")
        body = {"game_id": "demo", "world_id": "w1", "player_id": "p1",
                "character_id": "test", "messages": [{"role": "user", "content": "hello"}]}
        with patch.object(game.db, "get_character", return_value={"name": "test", "about": "test"}), patch.object(game.openai, "stream_chat_retry") as upstream:
            self.assertEqual(self.client.post("/api/game/chat", json=body).status_code, 409)
            upstream.assert_not_called()

    def test_multi_character_chat_uses_one_upstream_with_all_personas(self):
        db.upsert_game_api_config("demo", "game", "https://game.example/v1", "test-key", "model")
        ids = ["a", "b", "c"]
        calls = []
        async def reply(*args, **kwargs):
            calls.append(args)
            system = args[0][0]["content"]
            for character_id in ids:
                self.assertIn(f'"character_id": "{character_id}"', system)
                self.assertIn(f"persona-{character_id}", system)
            yield {"type": "text", "text": json.dumps({"replies": [
                {"character_id": character_id, "text": f"hi-{character_id}"} for character_id in ids]})}
            yield {"type": "done", "finish_reason": "stop"}
        body = {"game_id": "demo", "world_id": "w1", "player_id": "p1", "character_id": "a",
                "character_ids": ids, "messages": [{"role": "user", "content": "hello everyone"}]}
        def character(character_id):
            return {"name": character_id, "about": f"persona-{character_id}"}
        with patch.object(game.db, "get_character", side_effect=character), patch.object(game.openai, "stream_chat_retry", reply):
            result = self.client.post("/api/game/chat", json=body)
            self.assertEqual(result.status_code, 200)
            self.assertEqual(len(calls), 1)
            self.assertEqual(len(json.loads(result.json()["message"]["content"])["replies"]), 3)
            self.assertIn("每条最多60个汉字", calls[0][0][0]["content"])
        self.assertEqual(db.list_memories(), [])

    def test_group_rejects_duplicate_or_missing_characters_before_inference(self):
        body = {"game_id": "demo", "world_id": "w1", "player_id": "p1", "character_id": "a",
                "messages": [{"role": "user", "content": "hello"}]}
        with patch.object(game.db, "get_character", side_effect=lambda cid: {"name": cid} if cid == "a" else None), patch.object(game.openai, "stream_chat_retry") as upstream:
            for ids, status in [(["a", "a"], 422), (["b", "c"], 422), (["a", "b"], 404)]:
                with self.subTest(ids=ids):
                    self.assertEqual(self.client.post("/api/game/chat", json={**body, "character_ids": ids}).status_code, status)
            upstream.assert_not_called()

    def test_capabilities_do_not_claim_proposed_features(self):
        payload = self.client.get("/api/game/capabilities").json()
        self.assertFalse(payload["auth"]["implemented"])
        self.assertFalse(payload["chat"]["resume"])
        self.assertIn("play_sessions", payload["proposed"])

    def test_memory_dedupe_and_listing_are_world_scoped(self):
        one = db.add_memory("home", "同一句", fingerprint="same", game_id="g1", world_id="w1")
        two = db.add_memory("home", "同一句", fingerprint="same", game_id="g2", world_id="w2")
        self.assertIsNotNone(one)
        self.assertIsNotNone(two)
        self.assertEqual(len(db.list_memories(game_id="g1", world_id="w1")), 1)
        self.assertEqual(db.list_memories(game_id="g1", world_id="w2"), [])

    def test_auto_extract_can_tag_feature_namespace(self):
        """§9.6：提炼记忆带 feature_id 时落进功能命名空间，普通聊天召回不到。"""
        def remember(text, bucket="home", char_id="", source="manual", meta=None,
                     game_id="", world_id=""):
            return {"id": f"m-{game_id or 'chat'}", "text": text, "bucket": bucket,
                    "char_id": char_id, "game_id": game_id, "world_id": world_id}

        with patch("app.services.memory_extract.mem.remember", side_effect=remember), \
             patch("app.services.memory_extract.openai.complete_chat",
                   return_value='{"memories":[{"text":"我们把基地建在河边","private":false,"who":""}]}'):
            import asyncio

            from app.services import memory_extract
            result = asyncio.run(memory_extract.extract(
                messages=[{"role": "user", "content": "以后我们就在河边建基地吧，记得哦"}],
                character_ids=["dashiyin"], session_kind="single", name_of={"dashiyin": "大诗音"},
                base_url="https://x/v1", api_key="k", model="m", feature_id="dont_starve_together",
            ))
            self.assertTrue(result["triggered"])
            self.assertEqual(result["saved"][0]["game_id"], "dont_starve_together")

            chat = asyncio.run(memory_extract.extract(
                messages=[{"role": "user", "content": "以后我们就在河边建基地吧，记得哦"}],
                character_ids=["dashiyin"], session_kind="single", name_of={"dashiyin": "大诗音"},
                base_url="https://x/v1", api_key="k", model="m",
            ))
            self.assertEqual(chat["saved"][0]["game_id"], "")

