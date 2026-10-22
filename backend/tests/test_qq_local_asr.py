import asyncio
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from starlette.requests import Request
from app.routers.media import transcribe_local_audio


class QQAudioTests(unittest.TestCase):
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
             patch('app.routers.media.shutil.which', return_value='ffmpeg'), \
             patch('app.routers.media.subprocess.run', side_effect=convert), \
             patch('app.services.local_voice.transcribe_pcm', return_value='听得到'):
            result = asyncio.run(transcribe_local_audio(Request({'type': 'http'}, receive)))
        self.assertEqual(result, {'text': '听得到', 'provider': 'local'})
