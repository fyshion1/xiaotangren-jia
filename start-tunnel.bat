@echo off
title Xiaotangren Jia - tunnel

echo ========================================
echo   Xiaotangren Jia - public tunnel
echo ========================================
echo.

rem --- 1. pick the port: dev frontend 5173 first, otherwise the all-in-one 8000 ---
rem NOTE: keep this file ASCII-only with CRLF endings. cmd finds the end of an
rem if(...) block by scanning for the closing paren, which misfires with LF
rem endings. So: no paren blocks, no delayed expansion, only goto labels.
set PORT=5173
netstat -ano | findstr /c:"LISTENING" | findstr /c:":5173 " >nul 2>nul
if not errorlevel 1 goto found
set PORT=8000
netstat -ano | findstr /c:"LISTENING" | findstr /c:":8000 " >nul 2>nul
if not errorlevel 1 goto found

echo [X] Neither :5173 nor :8000 is listening.
echo     Start the app first (start.bat), then run this again.
pause
exit /b 1

:found
echo [1/2] Serving  http://127.0.0.1:%PORT%
echo.

rem --- 2. cloudflared: quick tunnel, no account needed ---
rem Check the script's own folder FIRST, by absolute path. A bare "cloudflared"
rem name is unreliable: with NoDefaultCurrentDirectoryInExePath=1 (set by some
rem shells) cmd will not run it from the current directory even though
rem where.exe finds it - the script then skipped the fallback and died.
set CF=cloudflared
if exist "%~dp0cloudflared.exe" set CF=%~dp0cloudflared.exe
if exist "%~dp0cloudflared.exe" goto run
where cloudflared >nul 2>nul
if not errorlevel 1 goto run
goto nocf

:nocf
echo [X] cloudflared not found.
echo.
echo     Download once (about 20 MB, no account needed):
echo       https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe
echo     Save it next to this script as  cloudflared.exe  and run again.
echo.
echo     Alternative with an npm account instead:
echo       npm i -g localtunnel
echo       lt --port %PORT%
pause
exit /b 1

:run
echo [2/2] Opening a public tunnel ...
echo.
echo   A https://xxxx.trycloudflare.com URL will appear below.
echo   Open THAT on your phone over mobile data - on any network, anywhere.
echo.
echo   Keep this window open. Close it (or Ctrl+C) to cut the tunnel.
echo.
"%CF%" tunnel --url http://127.0.0.1:%PORT%

echo.
echo Tunnel closed.
pause
