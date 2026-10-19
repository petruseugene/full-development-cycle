---
name: using-dev-cycle
disable-model-invocation: true
description: Use when starting any conversation in a repo with the dev-cycle plugin - routes feature, bugfix, architecture, and planning requests to the right dev-cycle skill before any other action.
---

<SUBAGENT-STOP>
If you were dispatched as a subagent to execute a specific dev-cycle task, ignore
this skill and follow your dispatch prompt.
</SUBAGENT-STOP>

# Using dev-cycle

## When to use

Read at the start of every session. It decides *whether* a request belongs to the
dev-cycle pipeline and *which* skill takes it.

## Required reading

1. Read `${CLAUDE_PLUGIN_ROOT}/skills/playbook/SKILL.md` (the core) — but only once a
   dev-cycle skill has been selected below. Do not read it for out-of-scope requests.

## The job

Route the request. If it matches a row, invoke that skill BEFORE any other action —
before exploring the codebase, before clarifying questions.

| Request looks like | Route |
|---|---|
| "build X", "add feature", "implement Y end-to-end", "ship X" | Skill `dev-cycle:orchestrator` |
| "fix bug", "X is broken", "hotfix" | Skill `dev-cycle:orchestrator` (bugfix flow) |
| "how should we structure X", "which architecture", "ADR", "C4 diagram" | Skill `dev-cycle:architector` |
| "write a spec for X" (without implementing it) | `/dev-cycle:spec-writer`, or Read `${CLAUDE_PLUGIN_ROOT}/skills/spec-writer/SKILL.md` |
| "decompose X into tasks", "write a plan" (without implementing it) | `/dev-cycle:plan-writer`, or Read `${CLAUDE_PLUGIN_ROOT}/skills/plan-writer/SKILL.md` |
| "review this diff/branch" | `/dev-cycle:code-reviewer`, or Read `${CLAUDE_PLUGIN_ROOT}/skills/code-reviewer/SKILL.md` |
| "show me the feature dashboard" | `/dev-cycle:dashboard` |

Only the orchestrator and architector are invoked through the Skill tool. Standalone
routes use a slash command or read-by-path, never the Skill tool.

The phrases above are English examples. Match the request by intent, not wording:
requests in any language (e.g. Russian "добавь фичу", "исправь баг") route the same way.

NOT dev-cycle work — handle normally, do not invoke the pipeline:
- One-line edits, renames, formatting
- "How does this work" questions, reading code, explanations
- Step-by-step pair programming where the user is driving

Rules:
- The orchestrator NEVER writes feature code — it dispatches subagents.
- Individual dev-cycle skills (`dev-cycle:frontend-dev`, `dev-cycle:auto-tester`,
  `dev-cycle:cli-fallback`, ...) are dispatched BY the orchestrator, not invoked
  directly by the user — unless the user names one explicitly.
- Announce the chosen route in one line.
- User instructions (CLAUDE.md, direct requests) override this routing.

## Output contract

This skill produces no report. It only selects the next skill to invoke.
