"""§22.4「我的档案 → 记忆」：每个身份各挑各的，没挑到的一律不兜底。"""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import db
from app.routers import profiles
from app.services import memory as memory_service
from app.services import persona_memory as pm
from app.services import self_profile as sp
from app.services import memory_workflow as work


class PersonaMemoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = patch.object(db, "DB_PATH", Path(self.tmp.name) / "test.db")
        self.path.start()
        self.addCleanup(self.path.stop)
        db.DATA_DIR.mkdir(parents=True, exist_ok=True)
        with db._tx() as conn:
            conn.executescript(db._SCHEMA)
            db._migrate(conn)

        # 个人数据库 03：一份已批准、一份待审
        self.db_root = Path(self.tmp.name) / "个人数据库"
        layer = self.db_root / "03_AI注入层" / "现实"
        layer.mkdir(parents=True)
        (layer / "住址.md").write_text(
            "---\ntitle: 住址\ninject: true\nvisible_to: all\ncreated_at: 2026-01-02\n"
            "review_status: approved\n---\n住在深圳坪山。\n",
            encoding="utf-8",
        )
        (layer / "草稿.md").write_text(
            "---\ntitle: 草稿\ninject: true\nvisible_to: all\ncreated_at: 2026-01-03\n"
            "review_status: pending\n---\n还没审的。\n",
            encoding="utf-8",
        )
        env = patch.dict("os.environ", {"PERSONAL_DATABASE_ROOT": str(self.db_root), "PERSONAL_MEMORY_ROOT": str(Path(self.tmp.name) / "memory")})
        env.start()
        self.addCleanup(env.stop)

        # 关闭向量，省掉模型加载；这里只测「挑不挑」，与检索算法无关
        off = patch.object(memory_service, "embeddings_config", lambda: {
            "engine": "local", "local_model": "x", "cloud_model": "x", "base_url": "",
            "api_key": "", "topk_home": 4, "topk_personal": 4,
        })
        off.start()
        self.addCleanup(off.stop)
        vec = patch.object(memory_service.emb, "embed_texts", side_effect=memory_service.emb.EmbeddingError("off"))
        vec.start()
        self.addCleanup(vec.stop)

        self.m1 = db.add_memory(bucket="home", char_id="", text="烤饼干要做三次", source="manual")
        self.m2 = db.add_memory(bucket="home", char_id="", text="喜欢吃提拉米苏", source="manual", fingerprint="tiramisu")

        db.upsert_profile("dalaoda", {"name": "大老大"})
        db.upsert_profile("xizi", {"name": "汐子"})

        pending = work.propose("烤饼干要做三次", "dalaoda", ["dashiyin"], scope="shared")
        formal = work.review(pending["id"], "dalaoda", "approve", {"core": True}, pending["revision"])
        self.formal = {**formal, "id": "file:" + formal["id"]}
        db.delete_persona_pick("dalaoda", "memory", self.formal["id"])

        app = FastAPI()
        app.include_router(profiles.router, prefix="/api")
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def test_prompt_never_recalls_unpicked_or_disabled_memory(self):
        from app.services.prompt.assembler import build_system_prompt
        db.upsert_character("dashiyin", {"name": "大诗音"})
        pm.set_pick("dalaoda", "memory", self.formal["id"], True)
        for persona_id in ("dalaoda", "xizi"):
            with patch.object(memory_service, "recall_for", return_value=[self.m2]) as recall:
                prompt = build_system_prompt(["dashiyin"], [{"role": "user", "content": "提拉米苏"}],
                                             persona=db.get_profile(persona_id))
            recall.assert_not_called()
            self.assertNotIn(self.m2["text"], prompt)
            self.assertEqual(self.m1["text"] in prompt, persona_id == "dalaoda")

    def test_disabled_pick_does_not_leak_through_prompt(self):
        from app.services.prompt.assembler import build_system_prompt
        db.upsert_character("dashiyin", {"name": "大诗音"})
        pm.set_pick("dalaoda", "memory", self.formal["id"], False)
        prompt = build_system_prompt(["dashiyin"], [{"role": "user", "content": "烤饼干"}],
                                     persona=db.get_profile("dalaoda"))
        self.assertNotIn(self.m1["text"], prompt)

    def test_default_is_empty(self):
        data = self.client.get("/api/profiles/dalaoda/memory-picks").json()
        self.assertFalse(any(m["picked"] for m in data["memories"]))
        self.assertFalse(any(d["picked"] for d in data["database"]))
        self.assertEqual(pm.injectable("dalaoda", []), ([], set()))

    def test_put_toggles_and_is_per_persona(self):
        m_id = self.formal["id"]
        r = self.client.put(f"/api/profiles/dalaoda/memory-picks/memory/{m_id}", json={"enabled": True})
        self.assertEqual(r.status_code, 200)

        items, off = pm.injectable("dalaoda", ["dashiyin"])
        self.assertEqual([i["id"] for i in items], [m_id])
        self.assertEqual(off, set())

        # 汐子没挑 → 什么都不带
        self.assertEqual(pm.injectable("xizi", ["dashiyin"]), ([], set()))

        # 关掉 → 进剔除集合，不注入
        self.client.put(f"/api/profiles/dalaoda/memory-picks/memory/{m_id}", json={"enabled": False})
        items, off = pm.injectable("dalaoda", ["dashiyin"])
        self.assertEqual(items, [])
        self.assertEqual(off, {m_id})

        self.client.delete(f"/api/profiles/dalaoda/memory-picks/memory/{m_id}")
        self.assertEqual(pm.injectable("dalaoda", ["dashiyin"]), ([], set()))

    def test_db_pick_shows_as_fact(self):
        ref = "现实/住址.md"
        r = self.client.put("/api/profiles/dalaoda/memory-picks/db/" + ref, json={"enabled": True})
        self.assertEqual(r.status_code, 200, r.text)
        items, _ = pm.injectable("dalaoda", ["dashiyin"])
        self.assertEqual([i["id"] for i in items], ["db:" + ref])
        block = memory_service.format_memory_block([], {}, pinned=items)
        self.assertIn("住在深圳坪山", block)
        self.assertIn("已批准的真实信息", block)

    def test_unapproved_db_cannot_be_picked(self):
        r = self.client.put("/api/profiles/dalaoda/memory-picks/db/现实/草稿.md", json={"enabled": True})
        self.assertEqual(r.status_code, 404)

    def test_memory_and_database_share_content_budget(self):
        ref = "现实/长资料.md"
        path = self.db_root / "03_AI注入层" / ref
        path.write_text(
            "---\ntitle: 长资料\ninject: true\nvisible_to: all\ncreated_at: 2026-01-04\n"
            "review_status: approved\n---\n" + "资" * 1300 + "\n",
            encoding="utf-8",
        )
        pending = work.propose("忆" * 1300, "dalaoda", ["dashiyin"], scope="shared")
        approved = work.review(pending["id"], "dalaoda", "approve", {}, pending["revision"])
        pm.set_pick("dalaoda", "memory", "file:" + approved["id"], True)
        pm.set_pick("dalaoda", "db", ref, True)

        items, _ = pm.injectable("dalaoda", ["dashiyin"])
        content_size = sum(len(item.get("text") or item.get("content") or "") for item in items)
        self.assertLessEqual(content_size, 2400)
        self.assertEqual(len(items), 1)

    def test_unknown_profile_or_memory(self):
        self.assertEqual(self.client.get("/api/profiles/nobody/memory-picks").status_code, 404)
        r = self.client.put("/api/profiles/dalaoda/memory-picks/memory/nope", json={"enabled": True})
        self.assertEqual(r.status_code, 404)

    def test_delete_memory_clears_picks(self):
        m_id = self.m1["id"]
        db.set_persona_pick("dalaoda", "memory", m_id, True)
        self.assertTrue(db.delete_memory(m_id))
        self.assertIsNone(db.get_memory(m_id))
        # 挑中行跟着删，不留指向已消失记忆的孤儿
        self.assertFalse(any(p["ref_id"] == m_id for p in db.list_persona_picks("dalaoda")))
        data = self.client.get("/api/profiles/dalaoda/memory-picks").json()
        self.assertFalse(any(m["id"] == m_id for m in data["memories"]))

    def test_clear_memories_drops_all_memory_picks(self):
        m_id = db.add_memory(bucket="personal", char_id="dashiyin", text="爱吃火锅", source="manual")["id"]
        db.set_persona_pick("dalaoda", "memory", m_id, True)
        db.clear_memories()
        self.assertFalse(any(p["kind"] == "memory" for p in db.list_persona_picks("dalaoda")))


if __name__ == "__main__":
    unittest.main()
