import importlib.util
import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app.routers import tools
import asyncio

spec = importlib.util.spec_from_file_location("install_features", Path(__file__).resolve().parents[2] / "install-features.py")
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class OptionalComponentTests(unittest.TestCase):
    def test_web_install_requires_separate_tools_feature(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(installer, 'REPO', Path(folder)), \
             patch.object(installer.subprocess, 'run') as run:
            with self.assertRaises(FileNotFoundError):
                installer.install_web()
            run.assert_not_called()

    def test_default_answers_install_nothing(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(installer, "REPO", Path(folder)), \
                patch.object(installer.sys.stdin, "isatty", return_value=True), \
                patch("builtins.input", side_effect=["", "", "", "", "", ""]), \
                patch.object(installer.subprocess, "run") as run, \
                patch.object(installer.urllib.request, "urlopen") as network:
            self.assertEqual(installer.main(), 0)
            run.assert_not_called()
            network.assert_not_called()

    def test_voice_uses_expected_model_paths_and_preserves_extras(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(installer, "REPO", Path(folder)), \
                patch.object(installer.subprocess, "run") as run, \
                patch.object(installer, "download") as download:
            installer.install_voice()
            self.assertIn("--inexact", run.call_args.args[0])
            targets = [call.args[1].relative_to(folder).as_posix() for call in download.call_args_list]
            self.assertEqual(len(targets), 5)
            self.assertIn("backend/data/asr/paraformer-zh-en/encoder.int8.onnx", targets)
            self.assertIn("backend/data/tts/piper/zh_CN-huayan-medium.onnx.json", targets)

    def test_qq_asr_installs_only_recognition_models_and_keeps_extras(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(installer, 'REPO', Path(folder)), \
             patch.object(installer.subprocess, 'run') as run, patch.object(installer, 'download') as download:
            installer.install_qq_asr()
            args = run.call_args.args[0]
            self.assertIn('qq-asr', args)
            self.assertIn('--inexact', args)
            self.assertEqual(run.call_args.kwargs['cwd'], Path(folder) / 'backend')
            targets = [c.args[1].relative_to(folder).as_posix() for c in download.call_args_list]
            self.assertEqual(len(targets), 3)
            self.assertTrue(all('/asr/paraformer-zh-en/' in p for p in targets))

    def test_qq_question_explains_dependencies_and_only_yes_installs(self):
        for answer in ('', 'y'):
            with tempfile.TemporaryDirectory() as folder, patch.object(installer, 'REPO', Path(folder)), \
                 patch.object(installer.sys.stdin, 'isatty', return_value=True), \
                 patch('builtins.input', side_effect=['', '', '', answer, '', '']) as ask, \
                 patch('builtins.print') as output, patch.object(installer.shutil, 'which', return_value='uv'), \
                 patch.object(installer, 'install_qq_asr') as install:
                self.assertEqual(installer.main(), 0)
                self.assertEqual(install.call_count, int(answer == 'y'))
                self.assertIn('QQ 语音转写功能', ask.call_args_list[3].args[0])
                printed = '\n'.join(str(c.args) for c in output.call_args_list)
                for name in ('sherpa-onnx', 'Paraformer', 'pilk', 'FFmpeg'):
                    self.assertIn(name, printed)

    def test_embedding_uses_existing_backend_model_layout(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(installer, 'REPO', Path(folder)), \
             patch.object(installer.subprocess, 'run') as run, patch.object(installer, 'download') as download:
            installer.install_embedding()
            self.assertIn('memory', run.call_args.args[0])
            self.assertIn('--inexact', run.call_args.args[0])
            targets = [c.args[1].relative_to(folder).as_posix() for c in download.call_args_list]
            prefix = 'backend/data/models/embedding/BAAI__bge-small-zh-v1.5/'
            self.assertEqual(len(targets), 10)
            self.assertTrue(all(p.startswith(prefix) for p in targets))
            self.assertIn(prefix + '1_Pooling/config.json', targets)
            self.assertIn(prefix + 'model.safetensors', targets)

    def test_embedding_is_explicit_opt_in_with_plain_language_first(self):
        for answer in ('', 'y'):
            with tempfile.TemporaryDirectory() as folder, patch.object(installer, 'REPO', Path(folder)), \
                 patch.object(installer.sys.stdin, 'isatty', return_value=True), \
                 patch('builtins.input', side_effect=['', '', '', '', '', answer]), \
                 patch('builtins.print') as output, patch.object(installer.shutil, 'which', return_value='uv'), \
                 patch.object(installer, 'install_embedding') as install:
                self.assertEqual(installer.main(), 0)
                self.assertEqual(install.call_count, int(answer == 'y'))
                description = next(c.args[0] for c in output.call_args_list if c.args and '换一种说法' in str(c.args[0]))
                self.assertLess(description.index('换一种说法'), description.index('embedding'))
                self.assertIn('GB', description)

    def test_download_failure_is_not_published_and_existing_files_skipped(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "model.onnx"
            with patch.object(installer.urllib.request, "urlopen", side_effect=OSError("offline")):
                with self.assertRaises(OSError):
                    installer.download("https://example.test/model", target)
            self.assertEqual(list(Path(folder).iterdir()), [])
            with patch.object(installer.urllib.request, "urlopen", return_value=io.BytesIO(b"model")):
                installer.download("https://example.test/model", target)
            with patch.object(installer.urllib.request, "urlopen") as network:
                installer.download("https://example.test/model", target)
                network.assert_not_called()
            self.assertEqual(target.read_bytes(), b"model")

    def test_truncated_download_is_not_published(self):
        with tempfile.TemporaryDirectory() as folder:
            response = io.BytesIO(b"partial")
            response.headers = {"Content-Length": "100"}
            target = Path(folder) / "model.onnx"
            with patch.object(installer.urllib.request, "urlopen", return_value=response):
                with self.assertRaises(ValueError):
                    installer.download("https://example.test/model", target)
            self.assertEqual(list(Path(folder).iterdir()), [])

    def test_tools_report_missing_or_installed_cli(self):
        with patch.object(tools.db, "list_profiles", return_value=[]), \
                patch.object(tools.tools, "settings", return_value=tools.tools.ToolSettings()):
            for installed in (False, True):
                with patch.object(tools.tools.web_search, "available", return_value=installed):
                    self.assertIs(asyncio.run(tools.get_config())["web_search_installed"], installed)
