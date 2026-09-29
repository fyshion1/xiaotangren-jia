@echo off
setlocal
title Xiaotangren Jia

echo ========================================
echo    Xiaotangren Jia - starting...
echo ========================================

echo.
echo [1/2] Starting backend on :8000 ...
start "xiaotang-backend" cmd /k "cd /d %~dp0backend && .venv\Scripts\python.exe -m uvicorn app.main:app --port 8000"

echo [2/2] Starting frontend on :5173 ...
start "xiaotang-frontend" cmd /k "cd /d %~dp0frontend && npm run dev"

echo.
echo Done! Backend  http://localhost:8000
echo        Frontend http://localhost:5173
echo Close the two windows to stop the servers.
echo.
pause