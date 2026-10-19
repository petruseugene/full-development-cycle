# HTML mockup conventions

All wireframes share **one visual style: paper / pencil sketch on beige paper.**
The canonical implementation lives in `references/component-library.html` — every wireframe must reuse its styles and markup so a feature reads as a single sketchbook, not a mix of styles.

## Workflow

1. Open `references/component-library.html` and read the `<style>` block + the components you'll need.
2. For each wireframe file:
   - Copy the entire `<style>` block from the component library, verbatim, into a `<style>` tag at the top of the file (inline only — no external CSS).
   - Compose the screen using the markup snippets from the library. Don't reinvent components.
   - Keep the agent-facing comments (`<!-- usage / a11y / data / interaction -->`) so frontend-dev can pick them up.
3. If a screen needs a pattern that isn't in the library yet and you'll use it again, add it to the library first, then use it.

## File rules

- One file per (screen × state).
- Inline CSS in `<style>` block at top of file. No `<script>`, no CDN links other than the Google Fonts `@import` already in the library.
- Use semantic elements: `<header>`, `<nav>`, `<main>`, `<form>`, `<button>`, `<label>`, `<input>`, `<dialog>`, `<details>`.
- Realistic placeholder content from the spec — no Lorem ipsum on labels, buttons, or headings.
- Annotate areas with `<!-- comment -->` explaining intent (e.g., `<!-- error state: shown when API returns 401 -->`).
- Each file < 250 lines (the shared `<style>` block doesn't count toward this — it's identical across files).

## Visual tokens (from the library)

Beige paper background. Dark pencil ink for text + strokes. Yellow highlighter reserved for the single primary signal per view (active nav, primary button, current step, current page). Green/amber/red used semantically only — never decoratively.

| Token            | Hex       | Use                                       |
|------------------|-----------|-------------------------------------------|
| `--paper`        | `#f4ecd8` | page background                           |
| `--paper-shade`  | `#ede2c4` | card / subtle bg                          |
| `--ink`          | `#2a2a2a` | primary text + strokes                    |
| `--ink-soft`     | `#4a4a4a` | secondary text                            |
| `--muted`        | `#6f6346` | tertiary text (still ≥ 4.5:1 on paper)    |
| `--line`         | `#8a7a55` | dashed separators                         |
| `--highlight`    | `#ffe680` | primary emphasis only                     |
| `--success`      | `#4a7a3a` | semantic                                  |
| `--warn`         | `#c08a2a` | semantic                                  |
| `--error`        | `#b8392b` | semantic                                  |

Fonts: `Caveat` for headings (display), `Kalam` for body — loaded via Google Fonts `@import` in the library style block. System fallbacks: `'Bradley Hand', 'Segoe Print', 'Comic Sans MS', cursive`.

## Accessibility baked in

The library handles these — keep them when copying:

- Visible **dashed focus rings** on every interactive element (sketchy outlines hide subtle defaults).
- `<label>` + control paired via `for`/`id` on every form field.
- Color is never the sole signal: alerts use icon + text + border weight; required fields say "(required)" in the label, never just a red asterisk.
- Hit targets ≥ 40px on buttons, toggles, pagination.
- Icon-only buttons require `aria-label`.
- `aria-current`, `aria-selected`, `aria-expanded`, `aria-live`, `aria-busy` used wherever the variant implies state.
- `prefers-reduced-motion` respected (skeleton animation pauses).

## File naming

```
wireframes/
├── index.html              ← landing page with links to all screens
├── login.html              ← default state
├── login-error.html        ← validation error
├── login-loading.html      ← submit in flight
└── dashboard-empty.html    ← post-login, no data yet
```
