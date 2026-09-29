@echo off
chcp 65001 >nul
title 小糖人之家

echo ========================================
echo   小糖人之家 - 启动中...
echo ========================================

echo.
echo [1/2] 启动后端 :8000 ...
start "xiaotang-backend" cmd /k "cd /d %~dp0backend && uv run uvicorn app.main:app --port 8000"

echo [2/2] 启动前端 :5173 ...
start "xiaotang-frontend" cmd /k "cd /d %~dp0frontend && npm run dev"

echo.
echo 启动完成！后端 http://localhost:8000 ，前端 http://localhost:5173
echo 关闭对应窗口即可停止服务。
echo.
pause