"""Fixed-path loader for the optional local presentation package."""
import importlib
import importlib.util
import sys
from pathlib import Path

from .data_paths import features_root

FEATURE_DIR = features_root() / "xiaotangren-theme"
PACKAGE = "xiaotangren_theme"

def installed():
    from .plugin_state import enabled
    return enabled("xiaotangren_theme") and (FEATURE_DIR / PACKAGE / "__init__.py").is_file()

def load(name):
    if not installed():
        raise RuntimeError("Xiaotangren theme is not installed")
    if PACKAGE not in sys.modules:
        folder = FEATURE_DIR / PACKAGE
        spec = importlib.util.spec_from_file_location(PACKAGE, folder / "__init__.py",
                                                    submodule_search_locations=[str(folder)])
        package = importlib.util.module_from_spec(spec)
        sys.modules[PACKAGE] = package
        try:
            spec.loader.exec_module(package)
        except BaseException:
            sys.modules.pop(PACKAGE, None)
            raise
    return importlib.import_module(PACKAGE + "." + name)


def app_name():
    return load("metadata").NAME if installed() else "Shionarium"


def default_character_id():
    return load("metadata").DEFAULT_CHARACTER_ID if installed() else "assistant"
