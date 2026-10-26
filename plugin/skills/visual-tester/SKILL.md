---
name: visual-tester
description: Drives the running dev server with Playwright MCP (or Maestro on simulators/emulators when platform == mobile) through the `dev-cycle visual` CLI. Checks composition numerically against reference images, enforces per-screen time limits, tears down what it started, and leaves the verdict to the CLI. Skipped entirely when feature.json.visual_tests == false.
disable-model-invocation: true
---

# Visual Tester

## When to use

- After the per-task loop completes for a feature flow when `feature.json.visual_tests == true`, or in a11y-only mode when `a11y_audit && has_ui` with `visual_tests == false` (skip the visual pass).
- Optionally for bugfix flow when the bug is frontend.

## Required reading

1. Read `${CLAUDE_PLUGIN_ROOT}/skills/playbook/SKILL.md` (the playbook core) before anything else; it is the shared contract.
2. `references/visual-cli.md` (command reference, measure format, DOM rects, hierarchy capture)
3. `references/a11y-checklist.md`
4. `references/responsive-breakpoints.md`
5. `references/playwright-recipes.md`
6. `<feature folder>/spec.md` (Users & Scenarios, `## Screens`) — golden paths and screens to exercise
7. `references/maestro-recipes.md` (mobile only: `feature.json.platform == "mobile"`)
8. a11y mode only (see below): `references/axe-recipes.md`, `references/wcag-aa-cheatsheet.md`; `references/mobile-a11y.md` when `platform == "mobile"`

## The job

CLI: `node ${CLAUDE_PLUGIN_ROOT}/scripts/dev-cycle.mjs visual <sub>`. Screenshots and artefacts go to `verification/`.

1. `visual plan` — selects the screens this feature touches and prints the budget. Absent `platform` means web. Ask the user for the dev URL only if `feature.json.dev_url` is missing.
2. `visual build` — mobile only; builds once (cached) and starts the dev server.
3. For each selected screen:
   - flow screen: `visual run <screen-or-flow>` (the CLI enforces the time limit);
   - route screen (agent-driven): `visual mark <screen> start`, drive Playwright MCP, screenshot, `visual mark <screen> end`.
4. Capture element geometry: `maestro hierarchy` (mobile) or the DOM-rects snippet (web), saved to `verification/<screen>.hierarchy.json`.
5. `visual check <screen> --screenshot … --hierarchy …`. For an element with no id (for example a Skia canvas), read the screenshot against the reference and pass `--measure <check>:<subject>=<number> --source vision`. Record console errors and failed requests with `--fail "<reason>"`.
6. **Always** run `visual teardown`, also after an error or a timeout. Never skip it.
7. `visual verdict` — the CLI decides and writes the `## Visual tests` section.
8. `visual gallery` — writes `verification/index.html`.

Rules:

- Never write or edit the verdict or the `## Visual tests` section of `test-report.md`. Extra notes go in a separate `**Notes:**` block.
- Vision measurements are numbers (a ratio, a gap fraction, an overlap fraction), never adjectives. "Slightly short" is not a measurement.
- A CLI `fail` or `unmeasured` cannot be softened or called cosmetic.
- No catalog (`visual plan` prints `no catalog: ad-hoc mode`): register each spec scenario x breakpoint (375 / 768 / 1280) with `visual mark <id> start --adhoc` and `visual check <id> --adhoc`. Keep the keyboard-nav, console and network checks from `references/a11y-checklist.md`.
- Never target a physical device. Mobile needs an explicit simulator or emulator (`maestro --device {device} test …`; see `references/visual-cli.md` for the accepted device shapes); none available means `BLOCKED` with an ask to the user.

## a11y mode

Runs after the visual verdict when `feature.json.a11y_audit == true` and `feature.json.has_ui == true` (absent `a11y_audit` follows `visual_tests`). No-op otherwise.

- Web: resolve the dev URL as above, make sure the dev server answers, then run axe-core per `references/axe-recipes.md` (`npx -y @axe-core/cli@4.13.0 <url> --tags wcag2a,wcag2aa --exit`; optional per breakpoint). WCAG AA violations are failures; AAA are warnings.
- Mobile (`platform == "mobile"`): no axe-core; follow `references/mobile-a11y.md` (React Native static checks, its PASSED/FAILED mapping and report format).
- Append to `test-report.md` a `## Task <N> a11y — <ISO ts> — PASSED|FAILED` section with one bullet per rule: `- [pass] <rule>` or `- [fail] <rule> — <selector> — <detail>` (rule id, impact, selector, snippet). PASSED means zero AA violations.
- Record the result as history phase `a11y` (dod key `a11y`).

The returned `status` is the verdict's exit status: exit 1 means `FAILED`, exit 0 means `PASSED`.

## Output contract

End with the YAML block plus at most 5 lines of prose; never paste full test or tool output.

```yaml
---
status: PASSED | FAILED
output_file: docs/features/<folder>/test-report.md
failures_count: <N>
tokens_used: ~<N>k
duration: <Xm Ys>
---
```
