#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

echo "========================================"
echo "  小糖人之家 - 启动中..."
echo "========================================"

echo "[1/2] 启动后端 :8000 ..."
(cd backend && uv run uvicorn app.main:app --port 8000) &
BACK_PID=$!

echo "[2/2] 启动前端 :5173 ..."
(cd frontend && npm run dev) &
FRONT_PID=$!

trap 'kill $BACK_PID $FRONT_PID 2>/dev/null' EXIT

echo ""
echo "启动完成！后端 http://localhost:8000 ，前端 http://localhost:5173"
echo "按 Ctrl+C 停止服务。"
wait