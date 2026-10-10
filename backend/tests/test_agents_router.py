import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import db
from app.routers import agents


class AgentRouterTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.patch = patch.object(db, "DB_PATH", Path(self.tmp.name) / "agent.db")
        self.patch.start()
        self.addCleanup(self.patch.stop)
        with db._tx() as conn:
            conn.executescript(db._SCHEMA)
            db._migrate(conn)
        app = FastAPI()
        app.include_router(agents.router, prefix="/api")
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def tearDown(self):
        self.tmp.cleanup()

    def test_send_inbox_and_ack(self):
        sent = self.client.post(
            "/api/agents/messages",
            json={
                "sender": "dst-agent",
                "recipient": "xiaotangren-ui",
                "conversation_id": "nest",
                "correlation_id": "r1",
                "payload": {"text": "hello"},
            },
        )
        self.assertEqual(sent.status_code, 200)
        mid = sent.json()["id"]
        self.assertEqual(
            self.client.get("/api/agents/messages?agent_id=xiaotangren-ui").json()["items"][0][
                "payload"
            ]["text"],
            "hello",
        )
        self.assertEqual(self.client.post(f"/api/agents/messages/{mid}/handled").status_code, 200)
        self.assertEqual(
            self.client.get("/api/agents/messages?agent_id=xiaotangren-ui").json()["items"], []
        )
