$ErrorActionPreference = 'Stop'
$previousToken = $env:WORKER_TOKEN
if (-not $env:WORKER_TOKEN) {
    $keyFile = Join-Path $PSScriptRoot 'backend/data/compute-worker.json'
    if (Test-Path -LiteralPath $keyFile) {
        $env:WORKER_TOKEN = (Get-Content -LiteralPath $keyFile -Raw | ConvertFrom-Json).token
    }
}
Push-Location (Join-Path $PSScriptRoot 'backend')
try {
    & '.\.venv\Scripts\python.exe' -m uvicorn app.worker:app --host 0.0.0.0 --port 8010 --workers 1
    if ($LASTEXITCODE -ne 0) { throw "算力端退出：$LASTEXITCODE" }
} finally {
    Pop-Location
    $env:WORKER_TOKEN = $previousToken
}
