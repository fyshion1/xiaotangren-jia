#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/backend"
exec .venv/bin/python -m uvicorn app.worker:app --host 0.0.0.0 --port 8010 --workers 1
