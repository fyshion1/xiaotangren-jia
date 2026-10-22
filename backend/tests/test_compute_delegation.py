"""Worker authentication, actual wire protocol, and primary offline fallback."""
import asyncio
import base64
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import db, worker
from app.config import Settings
from app.routers import compute as routes, imagegen, voice
from app.services import compute, embedding, memory
from app.services.runtime_profile import LightweightGuard

TOKEN = "test-worker-token-with-at-least-24-characters"


class ComputeTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        for name, value in [("DB_PATH", Path(tmp.name) / "test.db"),
                            ("DATA_DIR", Path(tmp.name))]:
            mock = patch.object(db, name, value)
            mock.start(); self.addCleanup(mock.stop)
        db.init_db()
        self.settings = Settings(_env_file=None, worker_token=TOKEN)
        mock = patch("app.config.get_settings", return_value=self.settings)
        mock.start(); self.addCleanup(mock.stop)
        mock = patch("app.worker.get_settings", return_value=self.settings)
        mock.start(); self.addCleanup(mock.stop)
        compute._failures.clear()
        self.addCleanup(compute._failures.clear)
        app = FastAPI()
        app.add_middleware(LightweightGuard)
        app.include_router(routes.router, prefix="/api")
        app.include_router(imagegen.router, prefix="/api")
        app.include_router(voice.router, prefix="/api")
        @app.get("/api/health")
        def health():
            return {"status": "ok"}
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def delegated(self):
        db.set_feature_settings(compute.KEY, {"mode": "delegated",
            "worker_url": "http://worker.test", "token": TOKEN})

    def test_configuration_mask_preserve_and_native_switch(self):
        result = self.client.put("/api/compute/config", json={"mode": "delegated",
            "worker_url": "http://worker.test/", "token": TOKEN})
        self.assertEqual(result.status_code, 200)
        self.assertNotIn(TOKEN, result.text)
        self.assertTrue(result.json()["has_token"])
        self.client.put("/api/compute/config", json={"mode": "native", "token": ""})
        self.assertEqual(compute.configuration().token, TOKEN)
        self.assertEqual(compute.configuration().mode, "native")
        self.client.put("/api/compute/config", json={"mode": "native", "clear_token": True})
        self.assertEqual(compute.configuration().token, "")

    def test_invalid_worker_configuration(self):
        for url in ["file:///tmp", "https://user:secret@host", "http://host?secret=yes",
                    "http://host/#x", "http://host:invalid", ""]:
            result = self.client.put("/api/compute/config", json={"mode": "delegated",
                "worker_url": url, "token": TOKEN})
            self.assertEqual(result.status_code, 422, url)

    def test_destination_change_requires_new_secret(self):
        self.delegated()
        result = self.client.put("/api/compute/config", json={"mode": "delegated",
            "worker_url": "http://different-worker.test"})
        self.assertEqual(result.status_code, 422)
        self.assertEqual(compute.configuration().worker_url, "http://worker.test")

    def test_worker_requires_auth_and_model_consistency(self):
        with TestClient(worker.app) as client:
            self.assertEqual(client.get("/v1/compute/health").status_code, 401)
            self.assertEqual(client.get("/v1/compute/health", headers={
                "Authorization": "Bearer wrong"}).status_code, 401)
            headers = {"Authorization": f"Bearer {TOKEN}"}
            response = client.get("/v1/compute/health", headers=headers)
            self.assertEqual(response.json()["protocol"], 1)
            self.assertIn("embeddings", response.json()["capabilities"])
            response = client.post("/v1/compute/embeddings", headers=headers,
                json={"texts": ["hello"], "model": "different"})
            self.assertEqual(response.status_code, 409)
            response = client.post("/v1/compute/images", headers=headers, json={"prompt": "hello"})
            self.assertEqual(response.status_code, 503)
            response = client.post("/v1/compute/embeddings", headers=headers,
                json={"texts": ["hello"], "model": self.settings.embed_local_model,
                      "command": "must not execute"})
            self.assertEqual(response.status_code, 422)

    def test_worker_fails_start_without_secure_token(self):
        self.settings.worker_token = "short"
        with self.assertRaises(RuntimeError), TestClient(worker.app):
            pass

    def test_end_to_end_embedding_protocol_without_primary_model(self):
        self.delegated()
        self.settings.runtime_profile = "lightweight"
        original_client = httpx.Client
        with TestClient(worker.app) as worker_client:
            def route(request):
                # This is a separate server context, even though tested in-process.
                response = worker_client.request(request.method, request.url.path,
                    headers=dict(request.headers), content=request.content)
                return httpx.Response(response.status_code, content=response.content)
            transport = httpx.MockTransport(route)
            with patch.object(compute.httpx, "Client", side_effect=lambda **kw:
                              original_client(transport=transport, **kw)), \
                 patch.object(embedding, "_embed_local", return_value=[[1.0, 0.0]]) as local:
                result = embedding.embed_texts(["hello"])
            self.assertEqual(result, [[1, 0]])
            self.assertEqual(local.call_count, 1)  # Only the worker loads a model.

    def test_offline_worker_saves_and_recalls_keyword_memory(self):
        self.delegated()
        self.settings.runtime_profile = "lightweight"
        transport = httpx.MockTransport(lambda request: (_ for _ in ()).throw(
            httpx.ConnectError("secret upstream details")))
        original_client = httpx.Client
        with patch.object(compute.httpx, "Client", side_effect=lambda **kw:
                          original_client(transport=transport, **kw)) as client, \
             patch.object(embedding, "_load_local", side_effect=AssertionError("primary loaded model")):
            item = memory.remember("周末一起学习日语", source="manual")
            self.assertIsNotNone(item)
            self.assertFalse(item.get("vector"))
            with self.assertRaises(embedding.EmbeddingError):
                embedding.embed_texts(["test again"])
            self.assertEqual(client.call_count, 1)  # Cooldown avoids repeated waits.
            results = memory.search("学习日语", [("home", "")])
            self.assertTrue(any("学习日语" in row["text"] for row in results))
        self.assertEqual(self.client.get("/api/health").status_code, 200)

    def test_external_api_bypasses_worker_and_local_model(self):
        self.delegated()
        with patch.object(compute, "request_sync", side_effect=AssertionError("worker contacted")), \
             patch.object(embedding, "_embed_cloud", return_value=[[1, 0]]) as cloud:
            self.assertEqual(embedding.embed_texts(["hello"], engine="cloud"), [[1, 0]])
        cloud.assert_called_once()

    def test_lightweight_native_does_not_load_local_model(self):
        self.settings.runtime_profile = "lightweight"
        with patch.object(embedding, "_load_local", side_effect=AssertionError("loaded")):
            with self.assertRaises(embedding.EmbeddingError):
                embedding.embed_texts(["hello"])
        self.assertEqual(self.client.post("/api/voice/tts", json={"text": "hello"}).status_code, 503)
        self.assertEqual(self.client.post("/api/images/generate", json={"prompt": "hello"}).status_code, 503)

    def test_native_mode_preserves_local_embeddings(self):
        with patch.object(embedding, "_embed_local", return_value=[[0, 1]]) as local:
            self.assertEqual(embedding.embed_texts(["hello"]), [[0, 1]])
        local.assert_called_once()

    def test_bad_worker_vectors_never_return_as_valid_embeddings(self):
        self.delegated()
        for result in [{"model": "wrong", "vectors": [[1]]},
                       {"model": self.settings.embed_local_model, "vectors": [[float("nan")]]},
                       {"model": self.settings.embed_local_model, "vectors": []},
                       {"model": self.settings.embed_local_model, "vectors": "invalid"}]:
            with patch.object(compute, "request_sync", return_value=result):
                with self.assertRaises(embedding.EmbeddingError):
                    embedding.embed_texts(["hello"])

    def test_delegated_images_saved_only_on_primary(self):
        self.delegated()
        raw = b"test image bytes"
        async def result(task, body=None):
            return {"protocol": 1, "images": [{"mime": "image/png",
                    "data": base64.b64encode(raw).decode()}]}
        with patch.object(compute, "request_async", side_effect=result), \
             patch.object(imagegen.attachments, "save_image", return_value={
                 "id": "id", "orig": "/api/files/a.png", "thumb": "/api/files/thumb/a.png"}) as save, \
             patch.object(imagegen, "_run_comfyui", side_effect=AssertionError("local compute")):
            response = self.client.post("/api/images/generate", json={"prompt": "hello"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(save.call_args.args[1], raw)

    def test_offline_images_do_not_replay_locally(self):
        self.delegated()
        with patch.object(compute, "image_bytes", side_effect=compute.ComputeUnavailable("offline")), \
             patch.object(imagegen, "_run_comfyui", side_effect=AssertionError("local retry")):
            response = self.client.post("/api/images/generate", json={"prompt": "hello"})
        self.assertEqual(response.status_code, 503)

    def test_protocol_mismatch_and_auth_error_report_offline_without_secret(self):
        self.delegated()
        original = httpx.AsyncClient
        for response in [httpx.Response(401, text=TOKEN),
                         httpx.Response(200, json={"protocol": 999}),
                         httpx.Response(200, text="invalid")]:
            transport = httpx.MockTransport(lambda request: response)
            with patch.object(compute.httpx, "AsyncClient", side_effect=lambda **kw:
                              original(transport=transport, **kw)):
                result = asyncio.run(compute.status())
            self.assertFalse(result["online"])
            self.assertNotIn(TOKEN, json.dumps(result))


if __name__ == "__main__":
    unittest.main()
