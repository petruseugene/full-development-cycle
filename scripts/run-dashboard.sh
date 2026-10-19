#!/usr/bin/env bash
# Starts the dev-cycle dashboard against a target project's docs/features.
# Usage: run-dashboard.sh [--agent=auto|on|off] [--no-agent] [project-root]
#   project-root defaults to the current working directory; flags may appear anywhere.
#   If several positional paths are given, the LAST one wins. Every argument is treated as
#   data (never eval'd or word-split); a leading "--" ends flag parsing.
set -euo pipefail

PROJECT_ROOT=""
AGENT_FLAG=""
END_OF_FLAGS=0
for arg in "$@"; do
  if [[ "$END_OF_FLAGS" == 1 ]]; then PROJECT_ROOT="$arg"; continue; fi
  case "$arg" in
    --) END_OF_FLAGS=1 ;;
    --agent=*)
      AGENT_FLAG="${arg#--agent=}"
      case "$AGENT_FLAG" in
        auto|on|off) ;;
        *) echo "ERROR: invalid --agent value '$AGENT_FLAG' (expected auto|on|off)" >&2; exit 2 ;;
      esac
      ;;
    --no-agent) AGENT_FLAG="off" ;;
    -*) echo "ERROR: unknown option '$arg'" >&2; exit 2 ;;
    *) PROJECT_ROOT="$arg" ;;
  esac
done
PROJECT_ROOT="${PROJECT_ROOT:-$PWD}"
if [[ -n "$AGENT_FLAG" ]]; then
  export DASHBOARD_AGENT="$AGENT_FLAG"
fi
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

export NEXT_TELEMETRY_DISABLED=1

cd "$DASHBOARD_DIR"
if [[ ! -d node_modules ]]; then
  echo "Installing dashboard dependencies (first run)…"
  npm install --no-audit --no-fund
fi

echo "Dashboard → http://127.0.0.1:3737  (features: $FEATURES_DIR, agent: ${DASHBOARD_AGENT:-env/default})"
DASHBOARD_FEATURES_DIR="$FEATURES_DIR" exec npm run dev
