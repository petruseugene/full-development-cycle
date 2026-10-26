---
description: Start the dev-cycle dashboard for the current project (reads its docs/features).
---

Start the dev-cycle dashboard in the background and report the URL:

The arguments are captured through a quoted heredoc, so shell metacharacters in them
(`;`, `$(...)`, backticks, `&`) are data and never executed. They are split on whitespace
only (no globbing, no eval) and passed to the script as separate words:

```bash
read -r -a DASH_ARGS <<'DEV_CYCLE_ARGS_EOF'
$ARGUMENTS
DEV_CYCLE_ARGS_EOF
bash "${CLAUDE_PLUGIN_ROOT}/scripts/run-dashboard.sh" "${DASH_ARGS[@]+"${DASH_ARGS[@]}"}"
```

If `${CLAUDE_PLUGIN_ROOT}` is empty, resolve the plugin directory instead:

```bash
read -r -a DASH_ARGS <<'DEV_CYCLE_ARGS_EOF'
$ARGUMENTS
DEV_CYCLE_ARGS_EOF
DASHBOARD_SCRIPT=$(find ~/.claude/plugins -maxdepth 6 -type f -path '*dev-cycle*/scripts/run-dashboard.sh' 2>/dev/null | head -1)
PLUGIN_ROOT=$(dirname "$(dirname "$DASHBOARD_SCRIPT")")
bash "$PLUGIN_ROOT/scripts/run-dashboard.sh" "${DASH_ARGS[@]+"${DASH_ARGS[@]}"}"
```

The project root is the current directory unless a positional path is given in the
arguments (the last positional path wins), e.g. `/dev-cycle:dashboard ~/code/app --agent=off`.
Residual limitations: a project path containing spaces cannot be passed (words are split
on whitespace), and an argument line that is exactly `DEV_CYCLE_ARGS_EOF` would end the heredoc.

Optional arguments: `--agent=on|off|auto` sets the chat agent mode (default `auto`: chat
is shown only when `ANTHROPIC_API_KEY` is set and valid) and `--no-agent` is an alias for
`--agent=off`, e.g. `/dev-cycle:dashboard --agent=off`.

Then tell the user the dashboard is available at http://127.0.0.1:3737 and that
it is watching `docs/features/` of this project.
