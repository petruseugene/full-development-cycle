# Dev Cycle Dashboard

Live web UI for the agent system that lives in this repo. Reads `docs/features/<slug>/`
from disk (`feature.json`, `plan.md`, `review.md`, `test-report.md`) and streams updates
over Server-Sent Events backed by chokidar.

## Run

```bash
cd dashboard
npm install
npm run dev      # http://localhost:3737
```

By default the dashboard reads `../docs/features/`. Override with `DASHBOARD_FEATURES_DIR`.

To preview with the bundled demo data:

```bash
DASHBOARD_DEMO=1 npm run dev
```

## Layout

- 5-column kanban (`To do`, `In progress`, `Testing`, `Blocked`, `Merged`) — one card per task
  parsed from `plan.md`.
- KPI strip — derived from `feature.json.totals` and task statuses.
- Sidebar — pinned features + agent legend.
- Live ticker — last events from `feature.json.history` across all features.
- Task drawer — pipeline phases, review history, agent timeline.
- ⌘K command palette — search across tasks.

## Where the data comes from

Per `.claude/skills/_playbook.md`:

- `feature.json` is the orchestrator's state.
- `plan.md` task lines are parsed as `- [STATUS] **Task N** (tag): name`.
- `review.md` sections are parsed as `## Task N · cycle K — APPROVED|CHANGES_REQUIRED`.
- `test-report.md` uses the YAML frontmatter from the report contract.

The parsers degrade gracefully — missing files just mean less detail, not a crash.

<a id="anthropic-api-key"></a>
<a id="agent-sdk-setup"></a>

## Agent SDK setup

The chat drawer drives an embedded [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) session per feature, so the dashboard needs an Anthropic API key before it can start a chat. Without one the drawer renders the "Set `ANTHROPIC_API_KEY` to start a chat" alert and `POST /api/agent/[featureId]/start` returns `500 { error: 'ANTHROPIC_API_KEY not set' }`.

Set the key either in your shell or in `dashboard/.env.local`, then restart `npm run dev`:

```bash
export ANTHROPIC_API_KEY=sk-ant-…
cd dashboard
npm run dev
```

`dashboard/.env.local` is gitignored by Next.js by default — prefer it over your shell rc file if you want the key scoped to this project. Whichever path you choose, you must restart the dev server after changing the value; the SDK reads the variable at session-start time.

### Agent mode

Chat is billed at Anthropic API rates (Claude Agent SDK). Control it with `DASHBOARD_AGENT=auto|on|off`: in `auto` (the default) chat is hidden without a valid `ANTHROPIC_API_KEY`, and every `/api/agent/**` route returns 404. Force it with `/dev-cycle:dashboard --agent=on`, `--agent=off` or `--no-agent`, or set `DASHBOARD_AGENT` in `dashboard/.env.local`. Restart the dashboard after changing the env, the flag or the key. `on` skips the key check, so a Claude Code login can be used.

```bash
DASHBOARD_AGENT=off npm run dev                 # hide chat
bash scripts/run-dashboard.sh --agent=on /path/to/project
```

This section is the canonical setup target (`#anthropic-api-key`); the legacy anchor `#agent-sdk-setup` resolves to the same content so older deep-links keep working.

### Trust boundary

The Agent SDK runs **in the dashboard's Node.js process** with the same filesystem and shell permissions as the user who ran `npm run dev`. There is no extra sandbox: tools like `Bash`, `Write`, `Edit`, and `NotebookEdit` operate on your real working tree exactly as if you had typed `claude` in a terminal. The `canUseTool` approval wrapper is the only gate, and "Approve & remember" allowlists tools for the remainder of the session.

Because of that, the dev server **binds to `127.0.0.1` only** (`next dev -H 127.0.0.1`) and every `/api/agent/*` route checks the request `host` header against a loopback allowlist (`127.0.0.1`, `localhost`, `::1`) before doing any work. Non-loopback requests get a 404.

Do **not** expose the dashboard to other hosts. That means: no `-H 0.0.0.0`, no port-forwarding through SSH or `ngrok`, no reverse-proxying it behind a public domain. If you need remote access, run the dashboard on the remote machine and tunnel a browser session in (e.g. `ssh -L 3737:127.0.0.1:3737`), so the loopback check still protects the API.

### Runtime files

Each active session writes a small bundle under `dashboard/.runtime/sessions/`:

- `<featureId>.json` — session metadata: SDK `sessionId`, `startedAt`, last known status, working directory. Read on boot to detect orphaned sessions.
- `<featureId>.events.jsonl` — append-only NDJSON log of every SDK event (`assistant_text`, `tool_call`, `tool_result`, `approval_request`, `approval_resolved`, `usage`, `status`, `error`). This is the replay source for the per-feature SSE stream.
- `<featureId>.stats.json` — accumulated usage / tool-call / files-touched / per-subagent ledger, snapshotted at most every 5 seconds while events arrive and once more on session end.

The whole `dashboard/.runtime/` directory is gitignored — nothing here is tracked.

When you kill a session and start a new one for the same feature, the prior `events.jsonl` and `stats.json` are renamed with an ISO-8601 timestamp suffix before the new session starts. The rename uses a filesystem-safe form of `new Date().toISOString()` (colons and dots replaced with `-`), e.g.:

```
chat-control-panel.events.2026-05-16T14-22-07-431Z.jsonl
chat-control-panel.stats.2026-05-16T14-22-07-431Z.json
```

The active `<featureId>.json` is rewritten in place — only the event and stats logs rotate.

### Killing & resuming

- **Kill**: open the chat drawer's overflow menu (`⋯` in the drawer header) and choose **Kill session**. The SDK iterator is aborted, the session status flips to `killed`, and the empty state with the **Start orchestrator** button returns. The previous logs are rotated on the next `start`, not on kill itself.
- **Resume**: simply reopen the chat drawer for that feature — if a session metadata file exists on disk and no in-memory session is running, the drawer auto-resumes via `POST /api/agent/[featureId]/resume` (which calls the SDK's `query({ resume: sessionId, prompt: '' })`).
- **Orphaned sessions**: if the dev server was restarted while a session was running, that session is marked `orphaned` on boot. The drawer's empty state then shows a `Resume` button instead of `Start orchestrator`; clicking it runs the same resume flow.
