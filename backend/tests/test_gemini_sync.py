import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import db
from app.routers import gemini_sync


class GeminiSyncTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        for name, value in [("DATA_DIR", Path(tmp.name)), ("DB_PATH", Path(tmp.name) / "test.db")]:
            p = patch.object(db, name, value)
            p.start()
            self.addCleanup(p.stop)
        db.init_db()
        app = FastAPI()
        app.include_router(gemini_sync.router, prefix="/api")
        self.client = TestClient(app)
        self.addCleanup(self.client.close)
        self.token = self.client.get("/api/gemini-sync/pairing").json()["token"]
        self.headers = {"Authorization": f"Bearer {self.token}"}

    def sync(self, messages, conversation="conv-1", headers=None):
        return self.client.post("/api/gemini-sync/messages", headers=self.headers if headers is None else headers,
                                json={"conversation_id": conversation, "messages": messages})

    def test_stream_update_retry_and_final_do_not_duplicate_or_write_memories(self):
        message = {"id": "reply-1", "role": "assistant", "content": "**大诗音**：你好"}
        self.assertEqual(self.sync([message]).json()["created"], 1)
        updated = {**message, "content": "**大诗音**：你好，记得明天见面。\n**小白**：我也来。", "complete": True}
        self.assertEqual(self.sync([updated]).json()["updated"], 1)
        self.assertEqual(self.sync([updated]).json()["created"], 0)
        rows = db.list_messages("gemini-test")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["segments"][0]["speaker"], "大诗音")
        self.assertEqual(rows[0]["segments"][1]["speaker"], "小白")
        self.assertEqual(rows[0]["content"], updated["content"])
        self.assertEqual(db.list_memories(), [])
        self.assertEqual(db.list_messages("group"), [])

    def test_unknown_speaker_is_preserved_not_misattributed(self):
        message = {"id": "1", "role": "assistant", "content": "**分析**：说明文字\n没有署名"}
        self.assertEqual(self.sync([message]).status_code, 200)
        row = db.list_messages("gemini-test")[0]
        self.assertEqual(row["kind"], "text")
        self.assertEqual(row["content"], message["content"])

    def test_same_source_message_id_in_two_conversations_is_not_collapsed(self):
        message = {"id": "1", "role": "user", "content": "hello"}
        self.sync([message], "conv-1")
        self.sync([message], "conv-2")
        self.assertEqual(db.count_messages("gemini-test"), 2)

    def test_auth_and_origin_protection(self):
        message = {"id": "1", "role": "user", "content": "hello"}
        self.assertEqual(self.sync([message], headers={}).status_code, 401)
        self.assertEqual(self.sync([message], headers={"Authorization": "Bearer bad"}).status_code, 401)
        self.assertEqual(self.client.get("/api/gemini-sync/pairing", headers={"Origin": "https://gemini.google.com"}).status_code, 403)
        self.assertEqual(self.client.get("/api/gemini-sync/pairing", headers={"Host": "remote.example"}).status_code, 403)
        self.assertEqual(db.count_messages("gemini-test"), 0)

    def test_duplicate_ids_and_invalid_roles_fail_before_writing(self):
        message = {"id": "1", "role": "user", "content": "hello"}
        self.assertEqual(self.sync([message, message]).status_code, 422)
        self.assertEqual(self.sync([{**message, "role": "system"}]).status_code, 422)
        self.assertEqual(db.count_messages("gemini-test"), 0)

    def test_recreate_deleted_message_on_next_snapshot(self):
        message = {"id": "1", "role": "user", "content": "hello"}
        self.sync([message])
        db.delete_messages("gemini-test")
        self.sync([message])
        self.assertEqual(db.count_messages("gemini-test"), 1)

    def test_decorated_gemini_headings_and_webpage_labels(self):
        text = "（场景描述）\n\n🌸 粉毛温柔大诗音（补充说明）：\n你好\n\n🎒 战术副官小诗音：\n收到\n🐾 治愈系小白：\n喵"
        self.sync([{"id": "1", "role": "assistant", "content": text},
                   {"id": "2", "role": "user", "content": "You said 你好\n\n你好"}])
        rows = db.list_messages("gemini-test")
        self.assertEqual([s["speaker"] for s in rows[0]["segments"]], ["", "大诗音", "小诗音", "小白"])
        self.assertEqual(rows[1]["content"], "你好")
        self.assertEqual(db.list_memories(), [])

    def test_reprocess_preserves_ids_order_and_unlabelled_repetition(self):
        from app.services.gemini_sync import clean_user_text, reprocess_existing

        self.assertEqual(clean_user_text("你好\n\n你好"), "你好\n\n你好")
        self.sync([{"id": "1", "role": "assistant", "content": "🐾 治愈系小白：\n你好"}])
        before = db.list_messages("gemini-test")[0]
        self.assertEqual(reprocess_existing(), 1)
        after = db.list_messages("gemini-test")[0]
        for key in ["id", "seq", "created_at"]:
            self.assertEqual(before[key], after[key])
