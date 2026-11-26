#!/usr/bin/env bash
# Development mode: backend with auto-reload on :8000, Vite with hot reload on :3000.
set -euo pipefail
cd "$(dirname "$0")"
trap 'kill 0' EXIT
(cd backend && AGENTUI_URL=http://127.0.0.1:8000 .venv/bin/uvicorn app.main:app --reload --port 8000) &
(cd frontend && npm run dev) &
wait
