# Open decisions (tracks `full` and `lite`)

spec-writer lists genuine product forks in spec.md `## Open decisions`. You ask the owner before any wireframe, plan or code. The CLI only reads spec.md; spec-writer is the only writer.

## Steps

1. After every spec-writer `DONE` / `DONE_WITH_CONCERNS`, and before wireframer, plan-writer or any implementer, run `node <CLI> spec decisions --json --feature <f>`.
2. `{"decisions":[]}`: no question, continue.
3. Otherwise ask with `AskUserQuestion`: one question per decision, at most 4 questions per call (more than 4: several calls, in id order). Per question: `header` = the id (`D1`), `question` = the decision question, `multiSelect: false`, options in spec order. The first option is labelled `<label> (Recommended)`; every `description` is that option's consequence.
4. Apply defaults only when the owner explicitly says defaults are OK. Never on silence, a timeout or an empty answer; ask again.
5. Print one line `> DECISIONS: D1=<label>, D2=<label>` (owner free text for "Other"). Run `history add --phase spec --subagent orchestrator --status DONE --summary "decisions asked"`.
6. Re-dispatch spec-writer (normal dispatch prompt) with a block:

```
Decisions (owner answers):
D1: <answer verbatim>
D2: <answer verbatim>
```

   For defaults use the single line `all: defaults OK`. spec-writer folds the answers into spec.md.
7. Run `spec decisions --json` again. A non-empty list (a new fork) goes back to step 3. After 3 rounds still non-empty: `feature set status blocked` and escalate with the open ids.

## Rules

- Never hand-edit spec.md: do not tick, move or delete decisions yourself.
- Exit 2 from `spec decisions` (malformed block): re-dispatch spec-writer with the error text so it repairs the block, then re-run.
- Quick track, flows bugfix and hotfix skip all of this (no spec.md).
- `dod` fails with `! DOD-GATE FAILED: decisions last status = OPEN; aborting before push.` as a backstop (`dod-gate.md`); do not rely on it.
