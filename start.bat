@echo off
setlocal
chcp 65001 >nul
title Xiaotangren Jia - close this window to stop everything
cd /d "%~dp0backend"
set PYTHONIOENCODING=utf-8
set PYTHONUNBUFFERED=1
if not exist ".venv\Scripts\python.exe" (
  echo Backend Python not found. Please install backend dependencies first.
  pause
  exit /b 1
)
".venv\Scripts\python.exe" -m app.launcher %*
if errorlevel 1 (
  echo.
  echo Startup failed. Read the message above. Close this window or press any key.
  pause >nul
)
