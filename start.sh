#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

echo "========================================"
echo "  小糖人之家 - 启动中..."
echo "========================================"

echo "[1/2] 启动后端 :8000 ..."
(cd backend && .venv/Scripts/python.exe -m uvicorn app.main:app --port 8000) &
BACK_PID=$!

echo "[2/2] 启动前端 :5173（已开启局域网访问）..."
(cd frontend && npm run dev) &
FRONT_PID=$!

trap 'kill $BACK_PID $FRONT_PID 2>/dev/null' EXIT

echo ""
echo "启动完成！后端 http://localhost:8000 ，前端 http://localhost:5173"
echo ""
echo "手机 / 同网段设备可用下面任一地址打开（同一 Wi-Fi 或校园网）："
# 打印本机局域网 IPv4（Windows 的 ipconfig / Linux 的 hostname -I 都试一遍）
{
  ipconfig 2>/dev/null | grep -i "IPv4" | sed 's/.*: *//' || true
  hostname -I 2>/dev/null | tr ' ' '\n' || true
} | grep -E '^[0-9]+\.' | sort -u | while read -r ip; do
  echo "   http://$ip:5173"
done
echo "   （保持本机两个服务开着即可）"
echo ""
echo "按 Ctrl+C 停止服务。"
wait
