"""Availability contract for trusted, optional personal-data management panels."""
import json
from . import plugin_state
from .data_paths import PROJECT_ROOT

FEATURES_DIR = PROJECT_ROOT / 'features'
PANELS = {'personal_profile': ('personal-profile','personal-space.profile'),
          'personal_database': ('personal-database','personal-space.database')}


def panel(identifier):
    folder, slot = PANELS[identifier]
    manifest = FEATURES_DIR / folder / 'plugin.json'
    installed = manifest.is_file()
    compatible = False
    if installed:
        try:
            if manifest.stat().st_size <= 16384:
                data = json.loads(manifest.read_text(encoding='utf-8-sig'))
                compatible = (isinstance(data, dict) and data.get('id') == identifier
                              and data.get('kind') == 'personal-space-panel'
                              and type(data.get('host_api')) is int and data['host_api'] == 1)
        except (OSError, ValueError):
            pass
    return dict(id=identifier,slot=slot,installed=installed,compatible=compatible,
                enabled=installed and compatible and plugin_state.enabled(identifier),
                hidden=not plugin_state.visible(identifier))


def enabled(identifier):
    return panel(identifier)['enabled']
