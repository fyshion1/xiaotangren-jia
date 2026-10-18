@echo off
REM Double-click me: brings up the Chrome bridge omnireach needs.
REM All the logic lives in omnireach-chrome.ps1 next to this file.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0omnireach-chrome.ps1" %*
pause