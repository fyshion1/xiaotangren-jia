"""Read-only optional component inventory; never loads models or probes services."""
import importlib.util

from .config import get_settings
from .services.local_voice import PIPER_DIR, PIPER_VOICES, local_asr_ready


def package_present(name: str) -> bool:
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        return False


def piper_ready() -> bool:
    return package_present('piper') and any(
        all((PIPER_DIR / f'{voice}{suffix}').is_file()
            and (PIPER_DIR / f'{voice}{suffix}').stat().st_size > 0
            for suffix in ('.onnx', '.onnx.json'))
        for voice in PIPER_VOICES
    )


def inventory() -> dict:
    cfg = get_settings()
    edge = package_present('edge_tts')
    piper = package_present('piper')
    asr = package_present('sherpa_onnx')
    cloud = bool(cfg.dashscope_api_key or cfg.soniox_api_key or cfg.fish_audio_api_key)
    return {'voice': {
        # Installed means configuration can be opened, not that calls are ready.
        'installed': edge or piper or asr or cloud,
        'tts_available': edge or piper_ready(),
        'local_asr_ready': asr and local_asr_ready(),
        'cloud_configured': cloud,
    }}
