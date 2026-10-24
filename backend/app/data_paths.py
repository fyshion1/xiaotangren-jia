"""Core data locations, retaining the existing layout for compatibility.

Do not relocate data implicitly. External personal libraries retain their own
explicit overrides; a future workspace migration can change this single policy.
"""
import os
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]


def runtime_root() -> Path:
    return PROJECT_ROOT / 'backend' / 'data'


def personal_database_root() -> Path:
    return Path(os.getenv('PERSONAL_DATABASE_ROOT', str(PROJECT_ROOT / '个人数据库'))).resolve()


def personal_memory_root() -> Path:
    return Path(os.getenv('PERSONAL_MEMORY_ROOT', str(PROJECT_ROOT / '个人记忆库'))).resolve()
