"""Optional feature downloads after cloning the main repository (Python 3.10+)."""
from pathlib import Path
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.request

REPO = Path(__file__).resolve().parent
CHOICES = (("桌宠", "desktop-pet"), ("QQ 桥", "qq-bridge"))


def download(url, target):
    """Publish only complete downloads; leave existing models untouched."""
    if target.is_file() and target.stat().st_size:
        print(f"已存在，跳过：{target.name}")
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=target.parent, suffix=".download")
    try:
        with os.fdopen(fd, "wb") as output, urllib.request.urlopen(url, timeout=60) as response:
            expected = getattr(response, "headers", {}).get("Content-Length")
            shutil.copyfileobj(response, output)
        if expected is not None and Path(temporary).stat().st_size != int(expected):
            raise ValueError("下载未完成，请重新运行安装器")
        if not Path(temporary).stat().st_size:
            raise ValueError("下载文件为空")
        os.replace(temporary, target)
    finally:
        Path(temporary).unlink(missing_ok=True)


def install_web():
    plugin = REPO / 'features' / 'tools' / 'src' / 'xiaotangren_tools' / '__init__.py'
    if not plugin.is_file():
        raise FileNotFoundError('请先将独立工具插件安装到 features/tools；本体不再附带联网适配。详见 docs/guides/optional-components.md。')
    subprocess.run(["uv", "tool", "install", "--with", "httpx>=0.27,<1", "omnireach"], check=True)
    print("联网工具已安装；安装 CLI 不代表所有搜索来源已就绪。")
    print("Google 等来源还需 Chrome 桥接：运行 omnireach bridge install，按提示加载扩展，保持 Chrome 开启。")
    print("可用 omnireach doctor 检查来源；然后在聊天、QQ 桥或桌宠各自的联网开关中设置。详见 docs/guides/optional-components.md。")


def install_embedding():
    subprocess.run(["uv", "sync", "--locked", "--inexact", "--extra", "memory", "--python", "3.11"],
                   cwd=REPO / "backend", check=True)
    model = 'BAAI/bge-small-zh-v1.5'
    mirror = os.environ.get('HF_MIRROR', 'https://huggingface.co').rstrip('/')
    target = REPO / 'backend/data/models/embedding' / model.replace('/', '__')
    # Same layout as download_embedding.sh and the backend's existing offline loader.
    for name in ('config.json', 'config_sentence_transformers.json', 'modules.json',
                 'sentence_bert_config.json', 'model.safetensors', 'tokenizer.json',
                 'tokenizer_config.json', 'special_tokens_map.json', 'vocab.txt', '1_Pooling/config.json'):
        print(f'下载语义检索文件：{name}')
        download(f'{mirror}/{model}/resolve/main/{name}', target / name)
    print('按意思查找组件已安装。重启小家后，本地语义检索可使用这份模型；不安装仍可关键词检索。')
    print('未修改已有云端或委托算力设置，也未自动重建索引。更换已有向量模型后，请在记忆/知识资料界面重建对应索引。')


def install_asr(qq_only=False):
    # --inexact retains other optional packages already installed by the user.
    subprocess.run(["uv", "sync", "--locked", "--inexact", "--extra", "qq-asr" if qq_only else "local-voice", "--python", "3.11"],
                   cwd=REPO / "backend", check=True)
    mirror = os.environ.get("VOICE_MODEL_MIRROR", "https://huggingface.co").rstrip("/")
    asr = "csukuangfj/sherpa-onnx-streaming-paraformer-bilingual-zh-en"
    for name in ("tokens.txt", "encoder.int8.onnx", "decoder.int8.onnx"):
        print(f"下载本地识别模型：{name}")
        download(f"{mirror}/{asr}/resolve/main/{name}", REPO / "backend/data/asr/paraformer-zh-en" / name)


def install_qq_asr():
    install_asr(qq_only=True)
    print("QQ 语音转写组件已安装（未安装朗读音色）。重启小家，在 QQ 桥面板检查语音依赖。")
    print("声音设置可选 QQ 转写＋本地兜底，或直接本地识别；不会自动切换到云端或修改已有设置。")


def install_voice():
    install_asr()
    mirror = os.environ.get("VOICE_MODEL_MIRROR", "https://huggingface.co").rstrip("/")
    voice = "zh_CN-huayan-medium.onnx"
    for name in (voice, voice + ".json"):
        print(f"下载本地朗读音色：{name}")
        download(f"{mirror}/rhasspy/piper-voices/resolve/main/zh/zh_CN/huayan/medium/{name}",
                 REPO / "backend/data/tts/piper" / name)
    print("本地语音组件已安装。重启后端，在朗读中选择 Piper，或在通话中选择本地 Paraformer / Piper。")


def main():
    print("可选功能默认不下载，直接按回车跳过。")
    print("依次提供桌宠、QQ 桥、联网搜索、QQ 语音转写、本地说话与听写、按意思查找记忆和资料；其他功能请到 https://github.com/fyshion1 按需查看安装说明。")
    if not sys.stdin.isatty():
        print("非交互环境：跳过可选功能下载。")
        return 0
    failed = False
    for label, folder in CHOICES:
        print('桌面上显示小糖人并和她互动。' if folder == 'desktop-pet' else '在 QQ 上与小糖人聊天；另外需要兼容的 QQ 客户端和网关。')
        target = REPO / "features" / folder
        if target.exists():
            print(f"{label}：目录已存在，跳过，不修改已有文件。")
            continue
        try:
            answer = input(f"是否从 GitHub 下载{label}？[y/N] ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            print("\n已跳过剩余可选功能。")
            return int(failed)
        if answer not in ("y", "yes"):
            continue
        if not shutil.which("git"):
            print("找不到 Git，请安装后重试。")
            return 1
        result = subprocess.run(["git", "clone", f"https://github.com/fyshion1/{folder}.git", str(target)])
        if result.returncode:
            failed = True
            print(f"{label}下载失败，请检查网络和仓库访问权限；本体仍可单独使用。")
        else:
            print(f"{label}已下载。依赖、模型和账号配置请按该功能 README 完成。")
    for label, description, install in (
        ("联网搜索功能", "让小糖人上网查资料。将安装 OmniReach 搜索工具；部分来源还需 Chrome 扩展与登录，仅安装工具不保证所有来源都能访问。", install_web),
        ("QQ 语音转写功能", "让小糖人听懂 QQ 语音，作为网关转写失败时的本地兜底，也可直接本地识别。\n"
         "将安装：sherpa-onnx（CPU 语音识别运行库）；Paraformer 中英 INT8 模型和 tokens（把声音识别成文字）；"
         "pilk（解码 QQ 的 SILK 语音）；imageio-ffmpeg 及适用平台的 FFmpeg（音频转为识别所需格式）。\n"
         "依赖安装到本体后端环境，模型保存到 backend/data/asr/paraformer-zh-en；需联网下载数百 MB，占用磁盘与 CPU。"
         "识别不上传音频、不额外调用付费 ASR；聊天模型仍按原配置计费。不安装 TTS 音色、不修改系统 PATH。", install_qq_asr),
        ("本地说话与听写功能", "让小糖人把回复念出来，也能听懂你说的话。将安装识别运行库 sherpa-onnx、Paraformer 中英模型、QQ 解码器 pilk、FFmpeg 和 Piper 中文音色；已有识别模型会复用。需下载数百 MB，语音处理在本地，聊天模型仍按配置调用。", install_voice),
        ("按意思查找记忆和资料", "换一种说法也能找回相关记忆和知识资料，例如用‘上次吃的那顿饭’查找相关记录。"
         "这是语义检索，不会替你聊天，也不保证每次都能找对；不安装仍能按关键词查找。\n"
         "将安装小型中文向量模型 BGE-small-zh-v1.5（embedding，模型约 100 MB），以及 sentence-transformers、PyTorch 等运行依赖。"
         "注意：模型较小，但完整运行环境可能需要 GB 级空间，并非整个安装包只有 100 MB。CPU 可用，无需独立显卡。\n"
         "安装需联网，检索在本地运行，不上传原文、不产生云端向量调用费用；不会自动切换已有设置或重建索引。", install_embedding),
    ):
        print(f"\n{label}：{description}")
        try:
            answer = input(f"是否安装{label}？[y/N] ").strip().lower()
            if answer not in ("y", "yes"):
                continue
            if not shutil.which("uv"):
                print("找不到 uv，请先安装 uv 后重新运行。")
                failed = True
                continue
            install()
        except (EOFError, KeyboardInterrupt):
            print("\n已跳过剩余可选组件。")
            break
        except (OSError, ValueError, subprocess.CalledProcessError) as exc:
            failed = True
            print(f"{label}安装未完成：{exc}。可重新运行重试；本体文字聊天仍可单独使用。")
    return int(failed)


if __name__ == "__main__":
    raise SystemExit(main())
