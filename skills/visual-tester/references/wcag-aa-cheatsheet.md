# WCAG AA Cheatsheet

The high-yield failure modes axe-core catches. Use this when triaging the JSON output.

## Perceivable

| Rule | Threshold |
|---|---|
| `color-contrast` | 4.5:1 for normal text, 3:1 for ≥ 18pt or ≥ 14pt bold |
| `image-alt` | Every `<img>` needs `alt`; decorative → `alt=""` |
| `svg-img-alt` | `<svg role="img">` needs `<title>` or `aria-label` |
| `video-caption` / `audio-caption` | Captions required for prerecorded media |

## Operable

| Rule | What to check |
|---|---|
| `focus-order` | Tab order matches visual order |
| `link-name` / `button-name` | Every interactive element has an accessible name |
| `bypass` | Page has a skip-link or landmark |
| `keyboard` | Custom widgets (modals, menus) are keyboard-driveable |

## Understandable

| Rule | What to check |
|---|---|
| `label` | Every input has an associated `<label>` or `aria-label` |
| `html-has-lang` | `<html lang="…">` set |
| `valid-lang` | Lang value is a valid BCP-47 tag |

## Robust

| Rule | What to check |
|---|---|
| `aria-valid-attr` / `aria-valid-attr-value` | No typos in ARIA |
| `aria-required-attr` | Roles have their required attrs (e.g. `role="checkbox"` needs `aria-checked`) |
| `duplicate-id-active` | No duplicate IDs among focusable elements |
| `region` | Content is inside a landmark region |

## Impact ranking

axe-core labels each violation `minor` / `moderate` / `serious` / `critical`. Treat `serious` + `critical` as blockers; surface `moderate` as warnings; ignore `minor` unless it's a duplicate of a serious finding.

## Not in scope here

- Manual a11y review (screen reader walkthroughs, cognitive load) — those belong in a separate audit pass.
- Live region announcements timing.
- Mobile gesture alternatives.
