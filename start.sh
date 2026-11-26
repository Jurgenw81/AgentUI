#!/usr/bin/env bash
# AgentUI — one-command launcher. Usage: ./start.sh   (PORT=3000 by default)
set -euo pipefail
cd "$(dirname "$0")"
PORT="${PORT:-3000}"

command -v python3 >/dev/null || { echo "Python 3.10+ is required"; exit 1; }
command -v npm >/dev/null || { echo "Node.js 18+ is required"; exit 1; }

if [ ! -x backend/.venv/bin/uvicorn ]; then
  echo "▸ Setting up Python environment…"
  python3 -m venv backend/.venv
  backend/.venv/bin/pip install -q --upgrade pip
  backend/.venv/bin/pip install -q -r backend/requirements.txt
fi

if [ ! -d frontend/node_modules ]; then
  echo "▸ Installing frontend packages…"
  (cd frontend && npm install --silent)
fi

echo "▸ Building the web UI…"
(cd frontend && npx vite build --logLevel error)

if command -v docker >/dev/null && docker info >/dev/null 2>&1; then
  docker image inspect python:3.12-slim >/dev/null 2>&1 || (docker pull -q python:3.12-slim >/dev/null 2>&1 &)
fi

if (exec 3<>"/dev/tcp/127.0.0.1/${PORT}") 2>/dev/null; then
  echo ""
  echo "  ✗ Port ${PORT} is already in use (is AgentUI already running?)."
  echo "    Open http://localhost:${PORT}, stop the other process with:  kill \$(lsof -t -i:${PORT})"
  echo "    or use another port:  PORT=4000 ./start.sh"
  exit 1
fi

echo ""
echo "  ✦ Starting AgentUI →  http://localhost:${PORT}   (Ctrl+C to stop)"
echo ""
cd backend
export AGENTUI_URL="http://127.0.0.1:${PORT}"
exec .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port "$PORT"
