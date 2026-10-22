"""Core configuration and journal API for the optional tools feature."""
from __future__ import annotations

import json
import time
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .. import db
from .. import expert_mode
from ..providers import openai
from .. import tool_feature

ToolName = Literal["web_search", "reminder_draft", "project_cost_record", "project_cost_query", "daily_life_record", "daily_life_query", "knowledge_search", "knowledge_read", "knowledge_propose"]
SETTING_KEY = "agent_tools_v1"


class ToolSettings(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    enabled: bool = False
    web_enabled: bool = True
    pet_enabled: bool = True
    owner_persona_id: str = Field(default="dalaoda", min_length=1, max_length=120)
    allowed_names: list[ToolName] = Field(default_factory=lambda: ['web_search'], max_length=9)
    max_turns: int = Field(default=6, ge=1, le=8)
    max_calls: int = Field(default=8, ge=1, le=12)
    qq_enabled: bool = True
    timeout_seconds: int = Field(default=60, ge=5, le=120)

def saved_settings() -> ToolSettings:
    try:
        raw = json.loads(db.get_settings().get(SETTING_KEY, '{}'))
        if isinstance(raw, dict):
            raw.pop('root', None)
            raw.pop('max_bytes', None)
            if isinstance(raw.get('allowed_names'), list):
                retired = {'local_dir', 'local_read', 'local_find', 'local_info'}
                raw['allowed_names'] = [name for name in raw['allowed_names'] if name not in retired]
        return ToolSettings.model_validate(raw)
    except (ValidationError, ValueError, TypeError):
        # Legacy settings endpoint can store arbitrary strings; invalid config
        # must fail closed instead of accidentally enabling capabilities.
        return ToolSettings()


NETWORK_KEY = 'network_access_v1'
NETWORK_NAMES = frozenset({'web_search', 'lyrics_search', 'lyrics_read'})


def network_settings() -> dict:
    try:
        raw = json.loads(db.get_settings().get(NETWORK_KEY, '{}'))
        return {name: raw.get(name, True) is True for name in ('core', 'qq_bridge', 'desktop_pet')}
    except (ValueError, TypeError, AttributeError):
        return dict(core=False, qq_bridge=False, desktop_pet=False)


def settings() -> ToolSettings:
    config = saved_settings()
    if not tool_feature.installed():
        return config.model_copy(update={'enabled': False, 'allowed_names': []})
    if expert_mode.enabled():
        return config
    channels = network_settings()
    # Browser and legacy tool configuration cannot grant ordinary mode extra tools.
    return config.model_copy(update={
        'enabled': tool_feature.network_available(), 'allowed_names': ['web_search'] if tool_feature.network_available() else [],
        'web_enabled': channels['core'], 'qq_enabled': channels['qq_bridge'],
        'pet_enabled': channels['desktop_pet'],
        'owner_persona_id': db.get_active_persona_id() or 'dalaoda',
    })


def initialize():
    with db._tx() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS tool_runs (
                id TEXT PRIMARY KEY, request_id TEXT NOT NULL, persona_id TEXT NOT NULL,
                session_id TEXT NOT NULL, feature_id TEXT NOT NULL, status TEXT NOT NULL,
                created_at REAL NOT NULL, finished_at REAL, events TEXT NOT NULL DEFAULT '[]'
            );
            CREATE INDEX IF NOT EXISTS idx_tool_runs_session ON tool_runs(persona_id, session_id, created_at);
        """)
        conn.execute("UPDATE tool_runs SET status='interrupted',finished_at=? WHERE status='running' AND created_at<?",
                     (time.time(), time.time() - 180))


def available(feature_id: str, persona_id: str, config: ToolSettings | None = None) -> bool:
    if not tool_feature.installed():
        return False
    config = config or settings()
    if not expert_mode.enabled():
        config = settings()
    return bool(config.enabled and effective_names(config) and persona_id == config.owner_persona_id
                and ((feature_id == "core" and config.web_enabled)
                     or (feature_id == "desktop_pet" and config.pet_enabled)
                     or (feature_id == "qq_bridge" and config.qq_enabled)))


def recent_runs(persona_id: str, session_id: str = "") -> list[dict]:
    initialize()
    where, args = "persona_id=?", [persona_id]
    if session_id:
        where += " AND session_id=?"
        args.append(session_id)
    with db._tx() as conn:
        rows = conn.execute(f"SELECT * FROM tool_runs WHERE {where} ORDER BY created_at DESC LIMIT 20", args).fetchall()
    return [{**dict(row), "events": json.loads(row["events"])} for row in rows]


def provider_installed(group):
    if not tool_feature.installed():
        return False
    if group == 'network':
        return tool_feature.network_available()
    if group == 'project_costs':
        return (tool_feature.FEATURES_DIR / 'project-costs').is_dir()
    return group in ('knowledge', 'reminders')


def capabilities():
    return tool_feature.load('catalog').CAPABILITIES if tool_feature.installed() else []


def effective_names(config):
    return {item['name'] for item in capabilities()
            if item['name'] in config.allowed_names and provider_installed(item['group'])}


def groups():
    return [{**group, 'installed': provider_installed(group['id'])}
            for group in (tool_feature.load('catalog').GROUPS if tool_feature.installed() else [])]


async def generate(*args, **kwargs):
    return await tool_feature.load().generate(*args, **kwargs)


def __getattr__(name):
    if name == 'CAPABILITIES':
        return capabilities()
    if name in ('web_search', 'lyrics_search'):
        return tool_feature.load(name)
    if name in ('ModeAwarePolicy', 'ToolExecutor'):
        return getattr(tool_feature.load(), name)
    raise AttributeError(name)
