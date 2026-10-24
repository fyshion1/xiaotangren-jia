"""Public path rules and neutral model defaults; never access runtime data."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('public_tree', ROOT / 'tools/check_public_tree.py')
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class PublicSourceBoundaryTests(unittest.TestCase):
    def test_private_authoring_and_runtime_paths_are_rejected(self):
        paths = [
            '规划探讨.md', '角色设定.md', '项目坑点总结.md', '项目要求.txt',
            'docs/research/private.md', 'docs/plans/private.md',
            'docs/tool-agent-evidence/live.json', 'assets/酒馆角色卡/card.png',
            'evals/memory/model-runs/example/results.json',
            'backend/config/runtime.json', 'backend/data/settings.json',
        ]
        self.assertEqual(guard.violations(paths), paths)

    def test_source_synthetic_cases_and_public_guides_are_allowed(self):
        self.assertEqual(guard.violations([
            'backend/app/db.py', 'docs/guides/character-packs.md',
            'evals/memory/cases.json', 'evals/memory/tests/test_semantic.py',
            'frontend/src/data/characters.ts', 'assets/LICENSE.md',
        ]), [])

    def test_no_author_provider_or_model_is_used_as_a_default(self):
        from app.config import Settings
        with patch.dict('os.environ', {}, clear=True):
            settings = Settings(_env_file=None)
        self.assertEqual(settings.model_base_url, '')
        self.assertEqual(settings.model_api_key, '')
        self.assertEqual(settings.model_chat, '')
        self.assertEqual(settings.model_vision, '')


if __name__ == '__main__':
    unittest.main()
