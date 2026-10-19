---
name: wireframer
description: Generates standalone HTML/CSS mockups for browser preview, one file per screen/state. Skipped automatically when feature.json.design_source is set.
disable-model-invocation: true
---

# Wireframer

## When to use

- Feature flow step 4b, only when `feature.json.design_source == null` and `has_ui == true`.

## Required reading

1. Read `${CLAUDE_PLUGIN_ROOT}/skills/playbook/SKILL.md` (the playbook core) before anything else; `${CLAUDE_PLUGIN_ROOT}` is the plugin root stated in your dispatch prompt.
2. `references/html-conventions.md`
3. `references/component-library.html` — canonical paper-sketch components. Copy its `<style>` block verbatim into every wireframe; reuse its markup. Do not invent new patterns.
4. `references/handoff-hints.md`

## The job

1. Read `spec.md` (sections: Users & Scenarios, Requirements).
2. List the screens/states needed (e.g., login form / login form with error / login success). Always include empty + loading + error states for any screen that loads or submits data.
3. For each, write a standalone HTML file at `<feature folder>/wireframes/<screen-state>.html`:
   - Inline CSS only — copy the main `<style>` block (the one without an `id`) from `references/component-library.html` into a `<style>` tag at the top of the file.
   - If `feature.json.platform == "mobile"`: also copy the `<style id="mobile">` block (only then; web wireframes copy the main block only) and render each screen state as one `.phone` frame, using the `#mobile` section's markup.
   - The Google Fonts `@import` at the top of that block is the only allowed external resource.
   - Compose the screen using markup snippets from the library (buttons, fields, alerts, nav, etc.). Match the paper / pencil-sketch style across every wireframe.
   - Use semantic HTML and realistic placeholder copy from the spec — never Lorem ipsum on labels, buttons, or headings.
   - Keep the agent-facing comments (`<!-- usage / a11y / data / interaction -->`) so frontend-dev picks them up.
4. Add an `<feature folder>/wireframes/index.html` listing all screens with links.
5. **Append wireframe ACs to `spec.md`.** This is non-negotiable: the wireframe must produce binding acceptance criteria, not a passive sketch.
   - Open `spec.md` in the feature folder.
   - Append a new section heading `## Wireframe acceptance criteria` at the end of the file (after any existing sections).
   - Number ACs **continuously from the spec-writer's last AC** (e.g. if spec.md ends at AC21, the first wireframe AC is AC22).
   - Emit **one AC per visible column / element / state per screen.** Granular is good — under-spec is the failure mode you're guarding against.
   - Each AC must be **observable from rendered output**: name the screen, name the element, name the data it binds to, and (where the wireframe shows it) the CSS class or token it uses. Examples:
     - `AC22: On /activity, each event row renders 7 columns in this order: timestamp (mono), status dot, message ("${subagent} → ${status} on ${feature_title}"), feature slug pill, phase chip, status chip, duration.`
     - `AC23: On /activity, the phase chip uses class .chip.phase-<phase>; implement / static-check render blue, review renders purple, auto-test / visual-test render orange, commit / git render green.`
     - `AC24: On /activity, the status chip uses class .chip.st-<status-lower>; DONE / APPROVED / PASSED render green; FAILED / CHANGES_REQUIRED / BLOCKED render red.`
     - `AC25: On /activity, the duration column renders HistoryEvent.duration_s as "Xs" / "Xm" / "Xm Ys".`
     - `AC26: The /activity empty state renders "No activity yet" in text-ink-500.`
   - Anchor each AC to the file path of the wireframe it derives from (e.g. `(wireframes/activity.html row template, lines 351–359)`).
   - If a wireframe contains a state your screen list missed during step 2 (e.g. you only listed "list", but the wireframe shows "list + empty + loading + error"), emit an AC for each state.
   - **Do not weaken or duplicate existing spec ACs.** If spec-writer already covered an aspect, skip it. Wireframe ACs add visual fidelity on top of data semantics.
6. Output one print-style line in the report telling the user how to open the index in their browser.

## Extending the library

If a screen needs a pattern that isn't in `references/component-library.html` and you'll use it in 2+ wireframes, add it to the library first (with `<!-- usage -->` and `<!-- a11y -->` comments), then use it. This keeps the visual language consistent across features.

## Output contract

```yaml
---
status: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
output_file: docs/features/<folder>/wireframes/index.html
summary: <N screens generated; open <path> in browser>
tokens_used: ~<N>k
duration: <Xm Ys>
---
```

Final message: the YAML block above plus at most 5 lines of prose (playbook core §6).
