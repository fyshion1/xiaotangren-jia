<#
  omnireach-chrome.ps1 -- bring up the Chrome bridge omnireach needs (lazy-person edition)

  Why this exists:
    The Google / Twitter / Reddit / Xiaohongshu / Douyin / TikTok sources in omnireach
    rely on a small read-only Chrome extension that reuses the session already logged
    in inside your browser. You have loaded that extension once from chrome://extensions
    and it stays there. But omnireach never launches Chrome itself -- if Chrome is not
    running, those sources all fail with
    "native bridge extension did not connect before timeout".
    This script fills that gap: start the bridge if it is down, report health if it is up.

  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\omnireach-chrome.ps1
    powershell ... -File tools\omnireach-chrome.ps1 -Probe     # also run one test search
    or just double-click tools\omnireach-chrome.bat

  Output is deliberately ASCII: a Chinese Windows console defaults to code page 936,
  and hand-written script text gets mangled on the way out. Keep messages in English.

  Deliberately NOT done here: registering this as a scheduled task or hook so Chrome
  opens by itself at login. Chrome has no "start hidden but keep the profile available"
  mode that survives --no-startup-window across versions, and the repo's start.bat only
  launches what you ask for. Run this when a search actually fails; it takes about a second
  when the bridge is already up.
#>

[CmdletBinding()]
param(
    # After bringing the bridge up, run one Google search to verify the whole path.
    [switch]$Probe,
    # How long to wait for the bridge (seconds). Chrome cold start plus the extension
    # service worker usually lands in 5-10s.
    [int]$Timeout = 30
)

$ErrorActionPreference = 'Stop'

# The omnireach CLI is not on PATH (uv puts it in %USERPROFILE%\.local\bin) -- look there.
function Resolve-OmniReach {
    $candidates = @(
        (Join-Path $env:USERPROFILE '.local\bin\omnireach.exe'),
        (Join-Path $env:USERPROFILE '.local\bin\omnireach')
    )
    foreach ($c in $candidates) {
        if (Test-Path -LiteralPath $c) { return $c }
    }
    $onPath = Get-Command omnireach -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }
    throw "omnireach not found. Install it with: uv tool install --with `"httpx>=0.27,<1`" --index-url https://pypi.tuna.tsinghua.edu.cn/simple omnireach"
}

function Resolve-Chrome {
    $candidates = @(
        (Join-Path ${env:ProgramFiles} 'Google\Chrome\Application\chrome.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
        (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
    )
    foreach ($c in $candidates) {
        if ($c -and (Test-Path -LiteralPath $c)) { return $c }
    }
    throw "chrome.exe not found -- install Chrome first."
}

# Force UTF-8 for omnireach: it reads its own yml with read_text(), which decodes as
# GBK by default on a Chinese Windows and crashes with UnicodeDecodeError.
function Invoke-OmniReach {
    param([string]$Exe, [string[]]$Arguments)
    $oldUtf8 = $env:PYTHONUTF8
    $oldIo   = $env:PYTHONIOENCODING
    $env:PYTHONUTF8 = '1'
    $env:PYTHONIOENCODING = 'utf-8'
    try {
        $raw = & $Exe @Arguments 2>&1 | Out-String
    } finally {
        $env:PYTHONUTF8 = $oldUtf8
        $env:PYTHONIOENCODING = $oldIo
    }
    return $raw
}

function Test-Bridge {
    param([string]$Exe)
    $raw = Invoke-OmniReach -Exe $Exe -Arguments @('bridge', 'status', '--json')
    return ($raw -match '"connected"\s*:\s*true')
}

function Get-ChromeProcessCount {
    return @(Get-Process -Name chrome -ErrorAction SilentlyContinue).Count
}

# ---------------------------------------------------------------- main

$omnireach = Resolve-OmniReach
Write-Host "[omnireach] CLI: $omnireach" -ForegroundColor DarkGray

if (Test-Bridge -Exe $omnireach) {
    # By far the most common case -- never touch a browser the user already has open.
    Write-Host "[omnireach] Chrome bridge already connected -- nothing to start." -ForegroundColor Green
} else {
    $chrome = Resolve-Chrome
    $running = Get-ChromeProcessCount

    if ($running -gt 0) {
        # Chrome is up but the bridge is silent: the extension is probably disabled,
        # or its service worker has not woken yet. Give it a moment before taking action.
        Write-Host "[omnireach] Chrome is running ($running processes) but the bridge is silent -- waiting for it to reconnect..." -ForegroundColor Yellow
    } else {
        Write-Host "[omnireach] Chrome is not running -- starting it silently (no window)..." -ForegroundColor Yellow
        # --no-startup-window starts the full browser process with no visible window; the
        # extension still loads. Clicking the Chrome icon later opens into this same
        # instance instead of starting a second one.
        Start-Process -FilePath $chrome -ArgumentList @(
            '--no-startup-window',
            '--no-first-run',
            '--no-default-browser-check'
        ) -WindowStyle Hidden
    }

    # Poll until the bridge answers. The extension's offscreen document polls every
    # 500ms, so this normally flips within a few seconds.
    $deadline = (Get-Date).AddSeconds($Timeout)
    $connected = $false
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 1000
        if (Test-Bridge -Exe $omnireach) { $connected = $true; break }
        Write-Host '.' -NoNewline -ForegroundColor DarkGray
    }
    Write-Host ''

    if (-not $connected -and (Get-ChromeProcessCount) -eq 0) {
        # Silent start did not take. Fall back to a normal visible Chrome so the user
        # can look at chrome://extensions themselves.
        Write-Host "[omnireach] Hidden start did not come up -- opening a normal Chrome window instead." -ForegroundColor Yellow
        Start-Process -FilePath $chrome
        Start-Sleep -Seconds 8
        $connected = Test-Bridge -Exe $omnireach
    }

    if ($connected) {
        Write-Host "[omnireach] Bridge connected." -ForegroundColor Green
    } else {
        Write-Host "[omnireach] Bridge still not connected. Check chrome://extensions:" -ForegroundColor Red
        Write-Host "             - is 'Omnireach Native Bridge' enabled?" -ForegroundColor Red
        Write-Host "             - its path should be $env:USERPROFILE\.omnireach\chrome-extension" -ForegroundColor Red
        Write-Host "             - if you changed any extension file, hit Reload there once." -ForegroundColor Red
        exit 1
    }
}

# Report which sources are actually live now.
$status = Invoke-OmniReach -Exe $omnireach -Arguments @('bridge', 'status', '--json')
if ($status -match '"commands"\s*:\s*\[([^\]]*)\]') {
    $cmds = $Matches[1].Replace('"', '').Replace(' ', '')
    Write-Host "[omnireach] extension commands: $cmds" -ForegroundColor DarkGray
}

if ($Probe) {
    Write-Host "[omnireach] probing one Google search..." -ForegroundColor DarkGray
    $out = Invoke-OmniReach -Exe $omnireach -Arguments @(
        'search', '--on', 'google', '--limit', '1', '--json', 'omnireach'
    )
    if ($out -match '"error"') {
        Write-Host $out -ForegroundColor Red
        exit 1
    }
    Write-Host "[omnireach] search path OK." -ForegroundColor Green
}