---
description: Start the dev-cycle dashboard for the current project (reads its docs/features).
---

Start the dev-cycle dashboard in the background and report the URL:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/run-dashboard.sh" "$(pwd)"
```

If `${CLAUDE_PLUGIN_ROOT}` is empty, resolve the plugin directory instead:

```bash
DASHBOARD_SCRIPT=$(find ~/.claude/plugins -maxdepth 6 -type f -path '*dev-cycle*/scripts/run-dashboard.sh' 2>/dev/null | head -1)
PLUGIN_ROOT=$(dirname "$(dirname "$DASHBOARD_SCRIPT")")
bash "$PLUGIN_ROOT/scripts/run-dashboard.sh" "$(pwd)"
```

Then tell the user the dashboard is available at http://127.0.0.1:3737 and that
it is watching `docs/features/` of this project.
