#!/usr/bin/env bash
# 下载本地 embedding 模型（默认 bge-small-zh-v1.5，约 100MB），放进 backend/data/models/embedding/。
# 记忆 RAG（§9.2.1）默认走本地模型，离线、CPU 可跑。
# 用法：bash download_embedding.sh
set -e
cd "$(dirname "$0")"

MODEL="${EMBED_MODEL:-BAAI/bge-small-zh-v1.5}"
DIR="backend/data/models/embedding/${MODEL//\//__}"   # BAAI/bge-... → .../BAAI__bge-...
MIRROR="${HF_MIRROR:-https://hf-mirror.com}"          # 国内镜像；官方源用 https://huggingface.co

mkdir -p "$DIR"

echo "==> 下载 embedding 模型 $MODEL 到 $DIR（源：$MIRROR）"

# 文件清单：sentence-transformers 加载所需的全部文件
FILES="
config.json
config_sentence_transformers.json
modules.json
sentence_bert_config.json
model.safetensors
tokenizer.json
tokenizer_config.json
special_tokens_map.json
vocab.txt
1_Pooling/config.json
"

fetch() {
  local rel="$1" out="$DIR/$1"
  mkdir -p "$(dirname "$out")"
  if [ -s "$out" ]; then
    echo "  [跳过] $rel"
    return 0
  fi
  local url="$MIRROR/$MODEL/resolve/main/$rel"
  local tmp="$out.part"          # 先写临时文件，成功才改名 —— 中断不会留下半个当成完整的
  echo "  [下载] $rel ..."
  if command -v curl >/dev/null 2>&1; then
    curl -fSL --retry 3 -o "$tmp" "$url" || { rm -f "$tmp"; return 1; }
  elif command -v wget >/dev/null 2>&1; then
    wget -O "$tmp" "$url" || { rm -f "$tmp"; return 1; }
  else
    echo "  错误：需要 curl 或 wget。请先安装其一。" >&2
    exit 1
  fi
  mv -f "$tmp" "$out"
}

ok=1
for f in $FILES; do
  fetch "$f" || true
done

# 权重至少要有 safetensors 或 pytorch_model.bin 之一
if [ ! -s "$DIR/model.safetensors" ] && [ ! -s "$DIR/pytorch_model.bin" ]; then
  echo "  [补下载] pytorch_model.bin（部分镜像没有 safetensors）..."
  fetch "pytorch_model.bin" || ok=0
fi

if [ "$ok" = "0" ] || { [ ! -s "$DIR/model.safetensors" ] && [ ! -s "$DIR/pytorch_model.bin" ]; }; then
  echo "==> 下载不完整。可改用官方 huggingface-cli："
  echo "    huggingface-cli download $MODEL --local-dir \"$DIR\""
  exit 1
fi

echo "==> 就绪：$DIR"
echo "    依赖还需装：uv pip install --python backend/.venv/Scripts/python.exe -e \"backend[memory]\""
echo "    验证：curl http://127.0.0.1:8000/api/memories/status（会回报 available / dim / stale_vectors）"