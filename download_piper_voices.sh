#!/usr/bin/env bash
# 下载 piper 本地 TTS 音色（约 60MB/个，放在 backend/data/tts/piper/）。
# 用法：bash download_piper_voices.sh   （或直接执行）
set -e
cd "$(dirname "$0")"

DIR="backend/data/tts/piper"
mkdir -p "$DIR"

MIRROR="${PIPER_MIRROR:-https://hf-mirror.com}"   # 国内镜像；官方源用 https://huggingface.co

# 音色:文件名（piper 官方仓库路径 zh/zh_CN/<voice>/<quality>/zh_CN-<voice>-<quality>.onnx）
VOICES="
huayan:medium
xiao_ya:medium
chaowen:medium
"

echo "==> 下载 piper 中文音色到 $DIR（源：$MIRROR）"
for pair in $VOICES; do
  voice="${pair%%:*}"
  quality="${pair##*:}"
  onnx="zh_CN-${voice}-${quality}.onnx"
  url="$MIRROR/rhasspy/piper-voices/resolve/main/zh/zh_CN/${voice}/${quality}/${onnx}"

  if [ -s "$DIR/$onnx" ]; then
    echo "  [跳过] $onnx 已存在（$(du -h "$DIR/$onnx" | cut -f1)）"
    continue
  fi

  echo "  [下载] $onnx ..."
  # 优先 curl；没有就退回 wget
  if command -v curl >/dev/null 2>&1; then
    curl -fSL --retry 3 -o "$DIR/$onnx" "$url"
    curl -fSL --retry 3 -o "$DIR/$onnx.json" "$url.json"
  elif command -v wget >/dev/null 2>&1; then
    wget -O "$DIR/$onnx" "$url"
    wget -O "$DIR/$onnx.json" "$url.json"
  else
    echo "  错误：需要 curl 或 wget。请先安装其一。"; exit 1
  fi

  # 校验：文件必须是 onnx（偶发会拿到「Entry not found」文本）
  if head -c 200 "$DIR/$onnx" | grep -qi "not found"; then
    echo "  错误：$onnx 下载失败（官方仓库可能已删除该音色）。请到 piper 仓库手动确认。" >&2
    rm -f "$DIR/$onnx" "$DIR/$onnx.json"
    exit 1
  fi
  echo "  [完成] $onnx（$(du -h "$DIR/$onnx" | cut -f1)）"
done

echo "==> 全部就绪。启动后 GET /api/voice/voices?engine=piper 会列出这些音色。"