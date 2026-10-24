"""Startup preferences shared by the launcher and the settings API."""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

from pydantic import BaseModel, ConfigDict, StrictBool, model_validator

from .data_paths import runtime_root

SETTINGS_PATH = runtime_root() / "launcher.json"


class StartupSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    backend: StrictBool = True
    frontend: StrictBool = True
    qq_bridge: StrictBool = True
    desktop_pet: StrictBool = True
    autonomous_activity: StrictBool = False

    @model_validator(mode="after")
    def dependencies(self):
        if not self.backend and (self.qq_bridge or self.desktop_pet or self.autonomous_activity):
            raise ValueError("功能服务需要后端，请同时开启后端或取消相关功能")
        return self


def load_startup() -> StartupSettings:
    from .expert_mode import enabled
    if not enabled():
        # Ordinary users always start installed services, regardless of old preferences.
        return StartupSettings(autonomous_activity=False)
    try:
        return StartupSettings.model_validate_json(SETTINGS_PATH.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return StartupSettings()


def save_startup(settings: StartupSettings) -> StartupSettings:
    SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix="launcher-", suffix=".tmp", dir=SETTINGS_PATH.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(settings.model_dump(), stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        os.replace(name, SETTINGS_PATH)
    finally:
        Path(name).unlink(missing_ok=True)
    return settings
