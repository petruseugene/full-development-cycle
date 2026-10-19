#!/usr/bin/env bash
# Starts the dev-cycle dashboard against a target project's docs/features.
# Usage: run-dashboard.sh [project-root]   (default: current working directory)
set -euo pipefail

PROJECT_ROOT="${1:-$PWD}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DASHBOARD_DIR="$SCRIPT_DIR/../dashboard"
FEATURES_DIR="$PROJECT_ROOT/docs/features"

if [[ ! -d "$DASHBOARD_DIR" ]]; then
  echo "ERROR: dashboard not found at $DASHBOARD_DIR" >&2
  exit 1
fi

if [[ ! -d "$FEATURES_DIR" ]]; then
  echo "WARN: $FEATURES_DIR does not exist yet — the dashboard will start empty." >&2
fi

cd "$DASHBOARD_DIR"
if [[ ! -d node_modules ]]; then
  echo "Installing dashboard dependencies (first run)…"
  npm install --no-audit --no-fund
fi

echo "Dashboard → http://127.0.0.1:3737  (features: $FEATURES_DIR)"
DASHBOARD_FEATURES_DIR="$FEATURES_DIR" exec npm run dev
