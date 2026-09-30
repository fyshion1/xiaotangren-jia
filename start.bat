@echo off
setlocal
title Xiaotangren Jia

echo ========================================
echo    Xiaotangren Jia - starting...
echo ========================================

echo.
echo [1/2] Starting backend on :8000 ...
start "xiaotang-backend" cmd /k "cd /d %~dp0backend && .venv\Scripts\python.exe -m uvicorn app.main:app --port 8000"

echo [2/2] Starting frontend on :5173 (LAN enabled) ...
start "xiaotang-frontend" cmd /k "cd /d %~dp0frontend && npm run dev"

echo.
echo Done!  Backend  http://localhost:8000
echo        Frontend http://localhost:5173
echo.
echo Phone / other devices on the same Wi-Fi or campus LAN:
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
  for /f "tokens=1" %%b in ("%%a") do echo        http://%%b:5173
)
echo   (open that address on your phone; keep both windows running)
echo.
echo Close the two windows to stop the servers.
pause
