#!/usr/bin/env bash
# One-command start: build the UI if needed, then serve UI + API on :5800.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d backend/.venv ]; then
  echo "▸ Creating Python venv…"
  python3 -m venv backend/.venv
  backend/.venv/bin/pip install -q -r backend/requirements.txt
fi

if [ ! -d out ]; then
  echo "▸ Building UI (first run)…"
  command -v pnpm >/dev/null || { echo "pnpm not found — install Node + pnpm"; exit 1; }
  pnpm install
  pnpm build
fi

echo "▸ ONVIF Camera Testing Console → http://localhost:${PORT:-5800}"
cd backend && exec .venv/bin/uvicorn server:app --host 0.0.0.0 --port "${PORT:-5800}"
