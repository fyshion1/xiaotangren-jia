"""Optional trusted tavern host. No card parsing or rendering lives here."""
import importlib
import importlib.util
import sys
from pathlib import Path

from fastapi import HTTPException
from .optional_plugins import HostSDK

from .data_paths import features_root

FEATURES_DIR = features_root()
PACKAGE = 'tavern_feature'


class TavernSDK(HostSDK):
    def __getattr__(self, name):
        if name == 'get_settings':
            from .config import get_settings
            return get_settings
        if name == 'MAIN_PERSONA_ID':
            from .seed_profiles import MAIN_PERSONA_ID
            return MAIN_PERSONA_ID
        return super().__getattr__(name)


def installed():
    from .plugin_state import enabled as plugin_enabled
    return plugin_enabled('tavern') and (FEATURES_DIR / 'tavern' / PACKAGE / '__init__.py').is_file()


def enabled():
    from . import db
    return installed() and db.get_settings().get('tavern_mode') == 'true'


def load(name):
    if not installed():
        raise HTTPException(404, '酒馆插件未安装，请先安装 features/tavern')
    if PACKAGE not in sys.modules:
        folder = FEATURES_DIR / 'tavern' / PACKAGE
        spec = importlib.util.spec_from_file_location(PACKAGE, folder / '__init__.py',
                                                     submodule_search_locations=[str(folder)])
        package = importlib.util.module_from_spec(spec)
        sys.modules[PACKAGE] = package
        sys.modules[PACKAGE + '.host'] = TavernSDK(PACKAGE + '.host')
        try:
            spec.loader.exec_module(package)
        except BaseException:
            sys.modules.pop(PACKAGE, None)
            sys.modules.pop(PACKAGE + '.host', None)
            raise
    return importlib.import_module(PACKAGE + '.' + name)
