#!/usr/bin/env bash
# Injects the compact dev-cycle routing primer into every new session's context.
# Paths are literal ${CLAUDE_PLUGIN_ROOT}/... only (plugin validator forbids computed
# paths and inline programs); the logic lives in session-start.py.
[ -n "${CLAUDE_PLUGIN_ROOT}" ] || exit 0
command -v python3 >/dev/null 2>&1 || exit 0
exec python3 "${CLAUDE_PLUGIN_ROOT}/scripts/session-start.py"
