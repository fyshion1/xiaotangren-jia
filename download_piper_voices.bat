@echo off
setlocal
rem 下载 piper 本地 TTS 音色（约 60MB/个，放在 backend\data\tts\piper\）。
rem 需要 curl（Win10 1803+ 自带）或 wget。

set DIR=backend\data\tts\piper
if not exist "%DIR%" mkdir "%DIR%"

set MIRROR=https://hf-mirror.com
if not "%PIPER_MIRROR%"=="" set MIRROR=%PIPER_MIRROR%

echo == 下载 piper 中文音色到 %DIR%（源：%MIRROR%）

for %%V in (huayan xiao_ya chaowen) do (
  set ONNX=zh_CN-%%V-medium.onnx
  if exist "%DIR%\!ONNX!" (
    echo   [跳过] !ONNX! 已存在
  ) else (
    echo   [下载] !ONNX! ...
    curl -fSL --retry 3 -o "%DIR%\!ONNX!" "%MIRROR%/rhasspy/piper-voices/resolve/main/zh/zh_CN/%%V/medium/!ONNX!"
    curl -fSL --retry 3 -o "%DIR%\!ONNX!.json" "%MIRROR%/rhasspy/piper-voices/resolve/main/zh/zh_CN/%%V/medium/!ONNX!.json"
  )
)

echo == 完成。启动后 GET /api/voice/voices?engine=piper 会列出这些音色。
pause