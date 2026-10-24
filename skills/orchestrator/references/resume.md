# Resume after compaction

Run `feature resume` when the SessionStart hook prints `dev-cycle: active feature …`, after context compaction, or whenever you are unsure of the feature's state. It is read-only: no writes, no git, no network.

```bash
node "$CLI" feature resume --feature <abs feature dir>
```

It prints about 20 lines: track, tasks or areas with status, recorded gates, `dod: needs …`, open decisions, `spec analyze` counts, waiting owner tasks, the `tokens:` line, budget and `next:`. Add `--json` for the full object.

## Rules

- Trust `dod: needs` and the `next:` lines over memory; run the first `next:` command, then re-run `feature resume`.
- Record every subagent report with `history add … --agent-id <agentId>` (from the launch result or task-notification). Without it the tokens are a self-estimate and the CLI prints `warning: no --agent-id: tokens are a self-estimate; pass --agent-id <id> for measured tokens`.
- With profile `strict_tokens: true` that call exits 2 and writes nothing: retry with `--agent-id`.
- `dod` and `ship` print `tokens: <m> measured / <e> estimated entries`; a high estimated count means cost data has gaps. Mention it in the final report.
