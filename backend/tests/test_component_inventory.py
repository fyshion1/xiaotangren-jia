import asyncio
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from app import components
from app.routers import voice


class ComponentInventoryTests(unittest.TestCase):
    def config(self, **values):
        return SimpleNamespace(**({'dashscope_api_key':'','soniox_api_key':'','fish_audio_api_key':''} | values))

    def test_missing_components_fail_closed_without_network_or_model_load(self):
        with patch.object(components,'package_present',return_value=False), \
             patch.object(components,'get_settings',return_value=self.config()), \
             patch.object(components,'local_asr_ready') as ready:
            self.assertEqual(components.inventory()['voice'],{
                'installed':False,'tts_available':False,'local_asr_ready':False,'cloud_configured':False})
            ready.assert_not_called()
            self.assertTrue(all(not row['available'] for row in asyncio.run(voice.list_engines())))
            self.assertEqual(asyncio.run(voice.list_voices('edge')),[])
            from fastapi import HTTPException
            with self.assertRaises(HTTPException) as error:
                asyncio.run(voice.tts(voice.TTSRequest(text='test')))
            self.assertEqual(error.exception.status_code,409)

    def test_qq_asr_does_not_claim_tts_is_available(self):
        with patch.object(components,'package_present',side_effect=lambda name:name=='sherpa_onnx'), \
             patch.object(components,'get_settings',return_value=self.config()), \
             patch.object(components,'local_asr_ready',return_value=True):
            result=components.inventory()['voice']
            self.assertTrue(result['installed'])
            self.assertTrue(result['local_asr_ready'])
            self.assertFalse(result['tts_available'])

    def test_cloud_configuration_is_boolean_and_never_returns_keys(self):
        with patch.object(components,'package_present',return_value=False), \
             patch.object(components,'get_settings',return_value=self.config(dashscope_api_key='test-only-secret')):
            result=components.inventory()['voice']
            self.assertTrue(result['installed'])
            self.assertTrue(result['cloud_configured'])
            self.assertNotIn('test-only-secret',str(result))

    def test_local_tts_needs_runtime_and_both_nonempty_model_files(self):
        with tempfile.TemporaryDirectory() as folder, \
             patch.object(components,'PIPER_DIR',Path(folder)), \
             patch.object(components,'PIPER_VOICES',('test',)), \
             patch.object(components,'package_present',return_value=True):
            model=Path(folder)/'test.onnx'
            model.write_bytes(b'model')
            self.assertFalse(components.piper_ready())
            config=Path(folder)/'test.onnx.json'
            config.touch()
            self.assertFalse(components.piper_ready())
            config.write_text('{}')
            self.assertTrue(components.piper_ready())


if __name__=='__main__':
    unittest.main()
