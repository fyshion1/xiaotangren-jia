import io
import tempfile
import unittest
import shutil
import subprocess
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image
from app.routers import messages, media
from app.services import attachments


class AttachmentPrepareTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        p = patch.object(attachments, 'ATTACHMENTS_DIR', self.root)
        p.start(); self.addCleanup(p.stop)
        app = FastAPI(); app.include_router(messages.router)
        self.client = TestClient(app); self.addCleanup(self.client.close)
        output = io.BytesIO(); Image.new('RGB', (16, 16), 'red').save(output, 'PNG')
        self.image = output.getvalue()

    def upload(self, name, raw, mime):
        return self.client.post('/attachments/prepare', data={'session_id': 'single-test'}, files={'file': (name, raw, mime)})

    def test_image_is_saved_as_local_reference(self):
        result = self.upload('test.png', self.image, 'image/png')
        self.assertEqual(result.status_code, 200, result.text)
        url = result.json()['images'][0]
        self.assertTrue(url.startswith('/api/files/single-test/orig/'))
        self.assertTrue(attachments._resolve_local(url).is_file())

    def test_invalid_image_and_pdf_fail_clearly(self):
        self.assertEqual(self.upload('bad.png', b'bad', 'image/png').status_code, 422)
        response = self.upload('test.pdf', b'%PDF', 'application/pdf')
        self.assertEqual(response.status_code, 422)
        self.assertIn('PDF', response.text)

    def test_video_reuses_analyzer_and_persists_frames(self):
        with patch.object(media, 'analyze_video', AsyncMock(return_value={'frames': ['frame'], 'task_id': 'test'})) as analyze, patch.object(media, '_load_frame', return_value=(self.image, 'image/png')), patch.object(media, '_resolve_task', return_value=self.root / 'task'), patch.object(media, '_cleanup') as cleanup:
            result = self.upload('clip.mp4', b'video', 'video/mp4')
            self.assertEqual(result.status_code, 200, result.text)
            self.assertTrue(result.json()['attachment'].endswith('.mp4'))
            self.assertEqual(len(result.json()['images']), 1)
            analyze.assert_awaited_once(); cleanup.assert_called_once()

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'ffmpeg unavailable')
    def test_real_short_video_extracts_persistent_frames(self):
        clip = self.root / 'clip.mp4'
        subprocess.run([shutil.which('ffmpeg'), '-y', '-f', 'lavfi', '-i', 'color=c=red:s=160x120:d=3', '-pix_fmt', 'yuv420p', str(clip)], capture_output=True, check=True, timeout=20)
        with patch.object(media, 'ROOT', self.root / 'tasks'):
            result = self.upload('clip.mp4', clip.read_bytes(), 'video/mp4')
        self.assertEqual(result.status_code, 200, result.text)
        self.assertGreater(len(result.json()['images']), 0)
        for url in [result.json()['attachment'], *result.json()['images']]:
            self.assertTrue(attachments._resolve_local(url).is_file())
        self.assertFalse(list((self.root / 'tasks').iterdir()))
