import asyncio
import sys
import types
import unittest
import tempfile
from pathlib import Path
from unittest.mock import patch

from starlette.requests import Request
from app.routers.media import transcribe_local_audio
from app.services import qq_audio_setup
from fastapi import HTTPException


class QQAudioTests(unittest.TestCase):
    def test_bundled_ffmpeg_used_when_system_is_missing(self):
        with tempfile.TemporaryDirectory() as temp:
            executable = Path(temp) / 'ffmpeg.exe'
            executable.write_bytes(b'test fixture')
            module = types.SimpleNamespace(get_ffmpeg_exe=lambda: str(executable))
            with patch.object(qq_audio_setup.shutil, 'which', return_value=None), \
                 patch.dict(sys.modules, {'imageio_ffmpeg': module}):
                self.assertEqual(qq_audio_setup.ffmpeg_executable(), str(executable))
            with patch.object(qq_audio_setup.shutil, 'which', return_value='system-ffmpeg'):
                self.assertEqual(qq_audio_setup.ffmpeg_executable(), 'system-ffmpeg')

    def test_missing_components_reported_without_inference(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(qq_audio_setup.local_voice, 'MODEL_DIR', Path(temp)), \
             patch.object(qq_audio_setup, 'dependency', return_value=False), \
             patch.object(qq_audio_setup, 'ffmpeg_executable', return_value=None):
            result = qq_audio_setup.diagnostics()
        self.assertFalse(result['ready'])
        self.assertEqual(len(result['missing_models']), 3)
        message = qq_audio_setup.missing_message(result['checks'])
        for expected in ['pilk', 'sherpa-onnx', 'FFmpeg', 'Paraformer', 'install-features.py']:
            self.assertIn(expected, message)

    def test_audio_missing_model_returns_actionable_503(self):
        async def receive():
            return {'type': 'http.request', 'body': b'#!SILK_V3test', 'more_body': False}
        with patch.object(qq_audio_setup, 'diagnostics', return_value={'checks': {
            'sherpa_onnx': True, 'pilk': True, 'ffmpeg': True, 'model_files': False}}):
            with self.assertRaises(HTTPException) as error:
                asyncio.run(transcribe_local_audio(Request({'type': 'http'}, receive)))
        self.assertEqual(error.exception.status_code, 503)
        self.assertIn('Paraformer', error.exception.detail)

    def test_empty_model_is_not_ready(self):
        from app.services import local_voice
        with tempfile.TemporaryDirectory() as temp, patch.object(local_voice, 'MODEL_DIR', Path(temp)):
            for name in qq_audio_setup.MODEL_FILES:
                (Path(temp) / name).touch()
            self.assertFalse(local_voice.local_asr_ready())
            for name in qq_audio_setup.MODEL_FILES:
                (Path(temp) / name).write_bytes(b'test fixture')
            self.assertTrue(local_voice.local_asr_ready())

    def test_silk_decoded_before_ffmpeg(self):
        async def receive():
            return {'type': 'http.request', 'body': b'\x02#!SILK_V3test', 'more_body': False}

        def decode(source, destination, rate):
            self.assertEqual(rate, 16000)
            self.assertTrue(Path(source).read_bytes().startswith(b'\x02#!SILK_V3'))
            Path(destination).write_bytes(bytes(32000))

        def convert(args, **kwargs):
            self.assertEqual(args[3:9], ['-f', 's16le', '-ar', '16000', '-ac', '1'])
            return types.SimpleNamespace(stdout=bytes(32000))

        with patch.dict(sys.modules, {'pilk': types.SimpleNamespace(decode=decode)}), \
             patch.object(qq_audio_setup, 'diagnostics', return_value={'checks': {
                 'sherpa_onnx': True, 'pilk': True, 'ffmpeg': True, 'model_files': True}}), \
             patch('app.routers.media.shutil.which', return_value='ffmpeg'), \
             patch('app.routers.media.subprocess.run', side_effect=convert), \
             patch('app.services.local_voice.transcribe_pcm', return_value='听得到'):
            result = asyncio.run(transcribe_local_audio(Request({'type': 'http'}, receive)))
        self.assertEqual(result, {'text': '听得到', 'provider': 'local'})
