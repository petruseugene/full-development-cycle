# Skill-Stack Workflow

How the custom skills in `.claude/skills/` hand off to ship a feature or a bugfix end to end. Triggered when a user invokes the orchestrator with a feature request (`/orchestrator build X`) or a bug report — the orchestrator runs the appropriate sub-flow below. Source of truth: [`.claude/skills/_playbook.md`](../../.claude/skills/_playbook.md); this page is the visual companion.

## Feature flow

```mermaid
flowchart TD
    Start([User: build feature X]) --> Interview[orchestrator<br/>feature-start interview]
    Interview --> Discovery[discovery<br/>writes discovery.md]
    Discovery --> ArchCheck{overview.md missing<br/>OR architecturally<br/>significant?}
    ArchCheck -- yes --> Architector[architector<br/>writes overview / ADR / .mmd]
    ArchCheck -- no --> Spec
    Architector --> Spec[spec-writer<br/>writes spec.md]
    Spec --> DesignCheck{design_source<br/>provided?}
    DesignCheck -- no --> Wireframer[wireframer<br/>writes wireframes/*.html]
    DesignCheck -- yes --> Plan
    Wireframer --> Plan[plan-writer<br/>writes plan.md]
    Plan --> Branch[git-agent<br/>create feature branch]

    Branch --> TaskLoop

    subgraph TaskLoop[Per-task loop]
        direction TB
        TaskStart([Task N status: IN PROGRESS]) --> ImplCheck{tag?}
        ImplCheck -- frontend --> FE[frontend-dev]
        ImplCheck -- backend --> BE[backend-dev]
        ImplCheck -- mixed --> FE
        FE --> Static[static-checker<br/>lint + typecheck + format]
        BE --> Static
        Static --> StaticVerdict{passed?}
        StaticVerdict -- FAILED<br/>cycles less than 3 --> ImplCheck
        StaticVerdict -- PASSED --> AutoCheck
        AutoCheck{auto_tests<br/>enabled?} -- yes --> AutoTest[auto-tester<br/>status: IN TESTING]
        AutoCheck -- no --> Review
        AutoTest --> Review[code-reviewer]
        Review --> Verdict{verdict?}
        Verdict -- CHANGES_REQUIRED<br/>cycles less than 3 --> ImplCheck
        Verdict -- BLOCKED after 3 --> TaskBlocked([status: BLOCKED → escalate])
        Verdict -- APPROVED --> Commit[git-agent<br/>commit task]
        Commit --> TaskDone([status: DONE])
    end

    TaskLoop --> MoreTasks{more tasks?}
    MoreTasks -- yes --> TaskLoop
    MoreTasks -- no --> VisualCheck{visual_tests<br/>enabled?}
    VisualCheck -- yes --> Visual[visual-tester<br/>writes test-report.md]
    VisualCheck -- no --> Ship
    Visual --> VisualVerdict{passed?}
    VisualVerdict -- failed,<br/>rewind to single task<br/>per test-report.md breadcrumb<br/>(escalate if unknown,<br/>cycles less than 3) --> TaskStart
    VisualVerdict -- passed --> Ship[git-agent<br/>push → PR → merge → delete branch]
    Ship --> Done([Feature shipped])

    classDef agent fill:#1e3a5f,stroke:#5b8cb8,color:#e8f1ff
    classDef decision fill:#3a2f1e,stroke:#b89968,color:#fff5e0
    classDef terminal fill:#1f3a2a,stroke:#5fb88c,color:#e8ffef
    class Discovery,Architector,Spec,Wireframer,Plan,FE,BE,Static,AutoTest,Review,Visual,Interview,Branch,Commit,Ship agent
    class ArchCheck,DesignCheck,ImplCheck,StaticVerdict,AutoCheck,Verdict,MoreTasks,VisualCheck,VisualVerdict decision
    class Start,Done,TaskStart,TaskDone,TaskBlocked terminal
```

## Bugfix flow

```mermaid
flowchart TD
    Start([User: bug report]) --> Interview[orchestrator<br/>bug-start interview]
    Interview --> Discovery[discovery<br/>reproduce + root-cause<br/>writes discovery.md]
    Discovery --> Branch[git-agent<br/>create fix branch]
    Branch --> ImplCheck{frontend or<br/>backend?}
    ImplCheck -- frontend --> FE[frontend-dev]
    ImplCheck -- backend --> BE[backend-dev]
    FE --> AutoCheck
    BE --> AutoCheck
    AutoCheck{auto_tests<br/>enabled?} -- yes --> AutoTest[auto-tester<br/>adds regression test]
    AutoCheck -- no --> Review
    AutoTest --> Review[code-reviewer]
    Review --> Verdict{verdict?}
    Verdict -- CHANGES_REQUIRED<br/>cycles less than 3 --> ImplCheck
    Verdict -- BLOCKED after 3 --> Blocked([escalate])
    Verdict -- APPROVED --> VisualCheck
    VisualCheck{visual_tests AND<br/>frontend bug?} -- yes --> Visual[visual-tester]
    VisualCheck -- no --> Ship
    Visual --> Ship[git-agent<br/>commit → push → PR → merge]
    Ship --> Done([Fix shipped])

    classDef agent fill:#1e3a5f,stroke:#5b8cb8,color:#e8f1ff
    classDef decision fill:#3a2f1e,stroke:#b89968,color:#fff5e0
    classDef terminal fill:#1f3a2a,stroke:#5fb88c,color:#e8ffef
    class Discovery,FE,BE,AutoTest,Review,Visual,Interview,Branch,Ship agent
    class ImplCheck,AutoCheck,Verdict,VisualCheck decision
    class Start,Done,Blocked terminal
```

## Hotfix flow

Same loop as bugfix, with two deltas: branch cut from the latest release
tag (not `main`), and a cherry-pick of the merge commit forward to `main`
after the release-line merge. Full command recipe in
[`.claude/skills/git-agent/references/hotfix.md`](../../.claude/skills/git-agent/references/hotfix.md).

```mermaid
flowchart TD
    Start([User: hotfix report]) --> Interview[orchestrator<br/>hotfix-start interview]
    Interview --> Discovery[discovery<br/>reproduce on released code<br/>writes discovery.md]
    Discovery --> TagLookup[git-agent<br/>find latest release tag<br/>gh release view --json tagName]
    TagLookup --> Branch[git-agent<br/>branch hotfix/slug<br/>from release tag]
    Branch --> ImplCheck{frontend or<br/>backend?}
    ImplCheck -- frontend --> FE[frontend-dev]
    ImplCheck -- backend --> BE[backend-dev]
    FE --> AutoCheck
    BE --> AutoCheck
    AutoCheck{auto_tests<br/>enabled?} -- yes --> AutoTest[auto-tester<br/>adds regression test]
    AutoCheck -- no --> Review
    AutoTest --> Review[code-reviewer]
    Review --> Verdict{verdict?}
    Verdict -- CHANGES_REQUIRED<br/>cycles less than 3 --> ImplCheck
    Verdict -- BLOCKED after 3 --> Blocked([escalate])
    Verdict -- APPROVED --> VisualCheck
    VisualCheck{visual_tests AND<br/>frontend bug?} -- yes --> Visual[visual-tester]
    VisualCheck -- no --> MergeRelease
    Visual --> MergeRelease[git-agent<br/>commit → push → PR<br/>→ merge into release line]
    MergeRelease --> CherryPick[git-agent<br/>cherry-pick merge SHA<br/>forward to main]
    CherryPick --> Conflict{conflict?}
    Conflict -- yes --> Escalate([abort, BLOCKED<br/>surface conflict to user])
    Conflict -- no --> ForwardPort[git-agent<br/>push forward-port PR → merge]
    ForwardPort --> Done([Hotfix shipped<br/>release + main])

    classDef agent fill:#1e3a5f,stroke:#5b8cb8,color:#e8f1ff
    classDef decision fill:#3a2f1e,stroke:#b89968,color:#fff5e0
    classDef terminal fill:#1f3a2a,stroke:#5fb88c,color:#e8ffef
    class Discovery,FE,BE,AutoTest,Review,Visual,Interview,TagLookup,Branch,MergeRelease,CherryPick,ForwardPort agent
    class ImplCheck,AutoCheck,Verdict,VisualCheck,Conflict decision
    class Start,Done,Blocked,Escalate terminal
```

## Legend

- **Blue rounded box** — agent skill from `.claude/skills/`. Each is a leaf subagent dispatched by the orchestrator.
- **Amber diamond** — decision the orchestrator makes from `feature.json` flags or subagent verdicts.
- **Green pill** — terminal state.

## Skill ownership at a glance

| Skill | Owns |
|---|---|
| `orchestrator` | Top-level driver; runs the interview, dispatches every phase, updates `feature.json`, renders the dashboard. Never writes implementation code. |
| `discovery` | Greps the codebase + researches external libs. Produces `discovery.md`. |
| `architector` | Architecture intake, ADRs, Mermaid C4 diagrams. Produces `docs/architecture/overview.md`, `decisions/ADR-NNNN-*.md`, `diagrams/*.mmd`. |
| `spec-writer` | Problem / goals / non-goals / requirements / acceptance criteria. Produces `spec.md`. |
| `wireframer` | Standalone HTML/CSS mockups, one per screen. Produces `wireframes/*.html`. |
| `plan-writer` | Decomposes the spec into tagged tasks. Produces `plan.md`. |
| `frontend-dev` / `backend-dev` | Implements one task end-to-end against its acceptance criteria. |
| `auto-tester` | Writes + runs unit/integration tests for the just-implemented task. |
| `code-reviewer` | Reviews the diff for one task. Returns APPROVED or CHANGES_REQUIRED. Appends to `review.md`. |
| `visual-tester` | Drives the running dev server with Playwright across 3 breakpoints. Produces `test-report.md`. |
| `git-agent` | Owns all `git` and `gh` commands: branch, commits, push, PR, merge. |
| `static-checker` | Runs lint + typecheck + formatter in read-only mode per task. Produces a section in `test-report.md`. |
| `security-reviewer` | Diff-based OWASP / secrets / authz review per task. Appends a security section to `review.md`. |
| `a11y-auditor` | Runs axe-core against the dev server; reports WCAG AA failures. Produces a section in `test-report.md`. |
| `dependency-auditor` | npm / pip / cargo / go audit + license check, once per feature. Produces a section in `test-report.md`. |
| `release-manager` | Conventional-commit → semver bump + Keep-a-Changelog entry. Stages `CHANGELOG.md` and the manifest version. |
| `db-migrator` | Owns the project's migration files. Enforces reversibility and zero-downtime patterns. Writes the migration file. |

## Skip conditions

- **architector** skipped when `overview.md` exists AND user did not flag the feature as architecturally significant.
- **wireframer** skipped when `feature.json.design_source` is set (existing design provided).
- **auto-tester** skipped when `feature.json.auto_tests == false`.
- **visual-tester** skipped when `feature.json.visual_tests == false`.

## Loop limits

- Per task: max **3** implementer ↔ reviewer cycles before the task is marked `[BLOCKED]` and escalated to the user.
- Per feature: max **3** implementer ↔ visual-tester cycles before the same.
