@echo off
setlocal
title Xiaotangren Jia

echo ========================================
echo    Xiaotangren Jia - starting...
echo ========================================

echo.
echo [1/2] Starting backend on :8000 ...
start "xiaotang-backend" cmd /k "cd /d %~dp0backend && .venv\Scripts\python.exe -m uvicorn app.main:app --port 8000 --reload"

echo [2/2] Starting frontend on :5173 (LAN enabled) ...
start "xiaotang-frontend" cmd /k "cd /d %~dp0frontend && npm run dev"

echo.
echo Done!  Backend  http://localhost:8000
echo        Frontend http://localhost:5173
echo.
echo Phone / other devices on the same Wi-Fi or campus LAN:
rem Skip 169.254.* (APIPA, unroutable). Most likely the real LAN IP:
ipconfig | findstr /c:"IPv4" | findstr /v "169.254."
echo   (open http://<that IP>:5173 on your phone; ignore virtual adapters)
echo.
echo Close the two windows to stop the servers.
pause
