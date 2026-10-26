# Axe Recipes

## Basic run

```bash
npx -y @axe-core/cli@4.13.0 http://localhost:3000 \
  --tags wcag2a,wcag2aa \
  --exit \
  --save axe-report.json
```

- `--tags wcag2a,wcag2aa` — restrict rules to A + AA only. AAA is informational.
- `--exit` — non-zero exit on violations (useful for shell-level pass/fail).
- `--save <file>` — JSON report; parse `violations[]` for the structured findings.

## Per-breakpoint

Run three times against the same URL with different viewport flags:

```bash
npx @axe-core/cli@4.13.0 <url> --tags wcag2a,wcag2aa --chromium-options "--window-size=375,667" --save axe-mobile.json
npx @axe-core/cli@4.13.0 <url> --tags wcag2a,wcag2aa --chromium-options "--window-size=768,1024" --save axe-tablet.json
npx @axe-core/cli@4.13.0 <url> --tags wcag2a,wcag2aa --chromium-options "--window-size=1440,900" --save axe-desktop.json
```

Merge violations across the three; deduplicate by `id` + `nodes[].target`.

## Parsing violations

Each entry in `violations[]`:

```json
{
  "id": "color-contrast",
  "impact": "serious",
  "tags": ["wcag2aa", "wcag143"],
  "nodes": [{ "target": ["#submit"], "failureSummary": "...", "html": "<button id=submit>..." }]
}
```

Map to a bullet:
- `[fail] <id> — <selector> — <impact> — <one-line failureSummary>`

## Authenticated pages

If the page requires login, prefer `feature.json.dev_auth_cookie` or a documented `--script` flag. If no auth strategy is configured, return `NEEDS_CONTEXT` rather than running against the login page.

## Skipping rules

Do not silence rules in this skill. Suppression belongs in the project's `axe-config.json` (committed). If a rule is genuinely inapplicable, document it there, not here.
