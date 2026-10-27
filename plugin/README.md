# dev-cycle

A [Claude Code](https://claude.com/claude-code) plugin that takes a feature or a bugfix from idea to merged pull request through strict subagent dispatch: discovery, spec, plan, parallel implementation, review and test gates, then git.

Install:

```
/plugin marketplace add petruseugene/full-development-cycle
/plugin install dev-cycle@dev-cycle
```

This folder is the shipped plugin (runtime files only). Installation, usage, configuration and the full documentation are in the [repository README](https://github.com/petruseugene/full-development-cycle/blob/main/README.md). The version history is in the [CHANGELOG](https://github.com/petruseugene/full-development-cycle/blob/main/CHANGELOG.md). Report problems in the [issue tracker](https://github.com/petruseugene/full-development-cycle/issues).

## What dev-cycle runs and sends

Paths in this section are relative to this plugin folder (the repository's `plugin/` directory).

- **Hooks (local only):** `SessionStart` runs `scripts/session-start.sh`, which execs `scripts/session-start.py` (injects a routing primer). `PreToolUse` on Bash runs `scripts/git-guard.mjs` (denies state-changing git from subagents).
- **State CLI:** `scripts/dev-cycle.mjs` runs `git` and, for `ship`, `git push|pr|merge`, a hotfix `git branch` and `report` (`gh pr view`, skipped with `--no-network`), the GitHub CLI `gh` with your own GitHub auth (pushes branches, opens and merges PRs, creates tags). The optional `--gh-credential` flag makes git use `gh` as its credential helper.
- **Codebase map:** `map` runs `git ls-files` / `git rev-parse` locally, reads only tracked `package.json` / `pnpm-workspace.yaml` (other manifests are listed by name, not read), and has no network access.
- **Project profile commands:** `commands`, `extra_gates`, `post_merge` and `recipes` run only commands the project owner wrote in `.dev-cycle/project.json`. Post-merge steps with `confirm: true` need explicit confirmation.
- **Skills:** may run your project's test and lint tools, Playwright or simulators for visual tests, and `npx -y @axe-core/cli@4.13.0` for accessibility audits (downloads that pinned version from npm).
- **Dashboard (optional, local on 127.0.0.1:3737):** on first start it installs its npm dependencies with `npm ci --omit=dev` (production dependencies from the committed lockfile, which also runs their package install scripts, for example Next.js SWC binaries). It calls `api.anthropic.com` (a `GET /v1/models` key check and Claude Agent SDK sessions) only when `DASHBOARD_AGENT` is not `off` and a key is set, or when `DASHBOARD_AGENT=on` forces chat on (auto mode validates a set key with `GET /v1/models`), and reads `ANTHROPIC_API_KEY` from the environment or `dashboard/.env.local` for that. `ANTHROPIC_BASE_URL` overrides the host. The dashboard page loads web fonts from `fonts.googleapis.com` / `fonts.gstatic.com` in your browser.
- **Web access:** discovery and subagents may use Claude Code's web search and fetch tools.
- **Telemetry:** dev-cycle adds no telemetry of its own, and the dashboard sets `NEXT_TELEMETRY_DISABLED=1` to turn off Next.js telemetry. Claude Code and the Agent SDK follow their own settings.

## License

See [LICENSE](https://github.com/petruseugene/full-development-cycle/blob/main/LICENSE).
