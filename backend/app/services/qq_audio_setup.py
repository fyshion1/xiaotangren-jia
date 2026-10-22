"""Read-only checks for the backend environment actually serving QQ audio."""
import importlib
import shutil
from pathlib import Path

from . import local_voice

MODEL_FILES = ('tokens.txt', 'encoder.int8.onnx', 'decoder.int8.onnx')


def ffmpeg_executable():
    system = shutil.which('ffmpeg')
    if system:
        return system
    try:
        from imageio_ffmpeg import get_ffmpeg_exe
        executable = get_ffmpeg_exe()
        return executable if Path(executable).is_file() else None
    except (ImportError, OSError, RuntimeError):
        return None


def dependency(name):
    try:
        importlib.import_module(name)
        return True
    except (ImportError, OSError, RuntimeError):
        return False


def diagnostics():
    from ..routers.nest import _setting
    files = {name: (local_voice.MODEL_DIR / name).is_file() and
             (local_voice.MODEL_DIR / name).stat().st_size > 0 for name in MODEL_FILES}
    checks = {'sherpa_onnx': dependency('sherpa_onnx'), 'pilk': dependency('pilk'),
              'ffmpeg': bool(ffmpeg_executable()), 'model_files': all(files.values())}
    return {'ready': all(checks.values()), 'checks': checks,
            'missing_models': [name for name, ready in files.items() if not ready],
            'model_dir': str(local_voice.MODEL_DIR),
            'engine': _setting('qq_bridge', 'asr.engine', 'qq'),
            'fallback': _setting('qq_bridge', 'asr.fallback', 'local'),
            'instructions': '在仓库根目录运行 python install-features.py，选择 QQ 语音转写功能；会安装识别依赖、模型、QQ 解码器与 FFmpeg。重启小家后再检查。模型和可选依赖不随 Git clone 分发。',
            'note': '此检查不加载模型、不调用 QQ 或云端；全部就绪只表示静态依赖齐全，仍需实际语音验证。'}


def missing_message(checks):
    names = {'sherpa_onnx': 'sherpa-onnx 运行依赖', 'pilk': 'QQ SILK 解码依赖 pilk',
             'ffmpeg': 'FFmpeg（系统或组件提供的版本）', 'model_files': 'Paraformer 模型文件'}
    missing = [label for key, label in names.items() if not checks.get(key)]
    return '本地语音识别未就绪，缺少：' + '、'.join(missing) + '。在仓库根目录运行 python install-features.py 并选择 QQ 语音转写功能，然后重启小家。'
