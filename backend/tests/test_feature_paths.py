"""Distribution paths must not fall back to the developer's private plugins."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from app.data_paths import PROJECT_ROOT, features_root


class FeaturePathTests(unittest.TestCase):
    def test_default_keeps_existing_installation(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(features_root(), PROJECT_ROOT / 'features')

    def test_relative_override_is_rejected(self):
        with patch.dict(os.environ, {'SHIONARIUM_PLUGINS_DIR': '../private-plugins'}):
            with self.assertRaisesRegex(ValueError, 'absolute'):
                features_root()

    def test_external_collection_is_shared_by_all_hosts(self):
        with tempfile.TemporaryDirectory(prefix='Shionarium paths ') as tmp:
            root = Path(tmp)
            plugins = root / 'external plugins'
            (plugins / 'desktop-pet').mkdir(parents=True)
            for folder, package in [('xiaotangren-theme', 'xiaotangren_theme'), ('tavern', 'tavern_feature'), ('tools/src', 'xiaotangren_tools')]:
                entry = plugins / folder / package / '__init__.py'
                entry.parent.mkdir(parents=True)
                entry.touch()
            code = '''
import sys
from pathlib import Path
from app import plugin_state
root = Path(sys.argv[1]).resolve()
plugin_state.STATE_PATH = root.parent/'test-state.json'
plugin_state.STATE_PATH.write_text('{"xiaotangren_theme":{"disabled":true},"tavern":{"disabled":true}}')
from app import data_paths, theme_feature, tavern_feature, tool_feature, expert_mode, personal_space, gemini_sync_feature, plugin_state
from app.routers import nest, plugins
from app.services import pack_catalog
from app import launcher
from app.optional_plugins import HostSDK
plugin_state.STATE_PATH.unlink()
assert data_paths.features_root() == root
for module in [tavern_feature, tool_feature, expert_mode, personal_space, gemini_sync_feature, nest, plugins, pack_catalog, launcher]:
    assert module.FEATURES_DIR == root, module.__name__
assert theme_feature.FEATURE_DIR == root/'xiaotangren-theme'
assert theme_feature.installed() and tavern_feature.installed() and tool_feature.installed()
sdk = HostSDK('test_host')
assert sdk.repo == data_paths.PROJECT_ROOT
assert sdk.features_dir == root
assert plugins.paths({'folder':'tavern'})[0] == root/'tavern'
assert nest._runner('desktop_pet')['cwd'] == root/'desktop-pet'
'''
            env = dict(os.environ, SHIONARIUM_PLUGINS_DIR=str(plugins))
            result = subprocess.run([sys.executable, '-X', 'utf8', '-c', code, str(plugins)],
                                    cwd=PROJECT_ROOT / 'backend', env=env, capture_output=True,
                                    text=True, encoding='utf-8', timeout=40)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_explicit_empty_collection_does_not_load_local_theme(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = dict(os.environ, SHIONARIUM_PLUGINS_DIR=tmp)
            result = subprocess.run([sys.executable, '-c',
                                     'from app import theme_feature, tool_feature, tavern_feature; assert not theme_feature.installed(); assert not tool_feature.installed(); assert not tavern_feature.installed()'],
                                    cwd=PROJECT_ROOT / 'backend', env=env, capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
