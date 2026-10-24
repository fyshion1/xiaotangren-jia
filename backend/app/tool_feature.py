"""Load the optional local tools feature without making it a core dependency."""
import importlib
import importlib.util
import sys
from pathlib import Path

from .optional_plugins import HostSDK

FEATURES_DIR = Path(__file__).resolve().parents[2] / 'features'
PACKAGE = 'xiaotangren_tools'


def installed() -> bool:
    from .plugin_state import enabled
    return enabled('tools') and (FEATURES_DIR / 'tools' / 'src' / PACKAGE / '__init__.py').is_file()


def load(name='integration'):
    if not installed():
        raise RuntimeError('工具插件未安装，请先安装 features/tools')
    if PACKAGE not in sys.modules:
        folder = FEATURES_DIR / 'tools' / 'src' / PACKAGE
        spec = importlib.util.spec_from_file_location(PACKAGE, folder / '__init__.py',
                                                     submodule_search_locations=[str(folder)])
        package = importlib.util.module_from_spec(spec)
        sys.modules[PACKAGE] = package
        try:
            spec.loader.exec_module(package)
        except Exception:
            sys.modules.pop(PACKAGE, None)
            raise
    sys.modules.setdefault(PACKAGE + '.host', HostSDK(PACKAGE + '.host'))
    return importlib.import_module(PACKAGE + '.' + name)


def network_available() -> bool:
    return installed() and load('web_search').available()
