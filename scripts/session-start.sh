#!/usr/bin/env bash
# Injects the compact dev-cycle routing primer (skills/using-dev-cycle/primer.md)
# into every new session's context, with {{ROOT}} resolved to the plugin root.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
PRIMER="$ROOT/skills/using-dev-cycle/primer.md"

[[ -f "$PRIMER" ]] || exit 0
command -v python3 >/dev/null 2>&1 || exit 0

python3 -c '
import json, sys
text = open(sys.argv[1], encoding="utf-8").read().replace("{{ROOT}}", sys.argv[2])
banner = "dev-cycle plugin active - route requests per the primer below.\n\n"
print(json.dumps({"hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": banner + text,
}}))
' "$PRIMER" "$ROOT"
