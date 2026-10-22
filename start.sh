#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

echo "========================================"
echo "  小糖人之家 - 启动中..."
echo "========================================"

echo "[1/2] 启动后端 :8000 ..."
if [ -x backend/.venv/bin/python ]; then
  BACKEND_PYTHON=.venv/bin/python
else
  BACKEND_PYTHON=.venv/Scripts/python.exe
fi
(cd backend && "$BACKEND_PYTHON" -m uvicorn app.main:app --port 8000) &
BACK_PID=$!

echo "[2/2] 启动前端 :5173（已开启局域网访问）..."
(cd frontend && npm run dev) &
FRONT_PID=$!

trap 'kill $BACK_PID $FRONT_PID 2>/dev/null' EXIT

echo ""
echo "启动完成！后端 http://localhost:8000 ，前端 http://localhost:5173"
echo ""
echo "手机 / 同网段设备可用下面任一地址打开（同一 Wi-Fi 或校园网）："
# 打印本机局域网 IPv4（Windows 的 ipconfig / Linux 的 hostname -I 都试一遍）。
# 过滤掉 169.254.*（APIPA 自分配地址，根本不可路由）；10./192.168. 排前面，
# 172.x 多为虚拟网卡（WSL/Hyper-V），放最后。
{
  ipconfig 2>/dev/null | grep -i "IPv4" | sed 's/.*: *//' || true
  hostname -I 2>/dev/null | tr ' ' '\n' || true
} | grep -E '^[0-9]+\.' | grep -vE '^169\.254\.' | sort -u | awk '
  /^10\./ || /^192\.168\./ { print "1 " $0; next }
  { print "2 " $0 }
' | sort | sed 's/^[12] //' | while read -r ip; do
  echo "   http://$ip:5173"
done
echo "   （手机连的是哪个网，就用哪个 IP；虚拟网卡那些打不开）"
echo "   （保持本机两个服务开着即可）"
echo ""
echo "按 Ctrl+C 停止服务。"
wait
