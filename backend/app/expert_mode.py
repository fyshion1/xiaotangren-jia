"""Local, persisted developer mode. Never writable through generic settings."""
import json
import sqlite3
from pathlib import Path

from fastapi import HTTPException

from . import db

KEY = 'expert_mode_v1'
PASSPHRASE = 'xiaotangren'
from .data_paths import features_root
FEATURES_DIR = features_root()


def enabled() -> bool:
    try:
        return json.loads(db.get_settings().get(KEY, '{}')).get('enabled') is True
    except (ValueError, TypeError, AttributeError, sqlite3.Error):
        return False


def enabled_in(connection) -> bool:
    """Read mode inside an existing transaction without acquiring the DB lock again."""
    try:
        row = connection.execute('SELECT value FROM settings WHERE key=?', (KEY,)).fetchone()
        return bool(row and json.loads(row[0]).get('enabled') is True)
    except (ValueError, TypeError, AttributeError, sqlite3.Error):
        return False


def require_expert():
    if not enabled():
        raise HTTPException(403, '此功能仅在专家模式下开放')


def plugin_installed() -> bool:
    from .plugin_state import enabled as plugin_enabled
    return plugin_enabled('autonomous_activity') and (FEATURES_DIR / 'autonomous-activity' / 'autonomous_activity' / 'plugin.py').is_file()


def status() -> dict:
    from .services import qq_basic_settings
    return {'enabled': enabled(), 'autonomy_installed': plugin_installed(),
            'qq_accounts': qq_basic_settings.choices()}
