# Playwright MCP recipes

## Open a URL and snapshot
```
mcp__plugin_playwright_playwright__browser_navigate({ url })
mcp__plugin_playwright_playwright__browser_snapshot()
```

## Resize for breakpoints
```
mcp__plugin_playwright_playwright__browser_resize({ width: 375, height: 812 })
```

## Tab through interactive elements
```
mcp__plugin_playwright_playwright__browser_press_key({ key: "Tab" })
mcp__plugin_playwright_playwright__browser_snapshot()
```

## Capture console + network
```
mcp__plugin_playwright_playwright__browser_console_messages()
mcp__plugin_playwright_playwright__browser_network_requests()
```

## Take screenshot to a path
```
mcp__plugin_playwright_playwright__browser_take_screenshot({ filename: "<path>" })
```

## Save screenshots into verification/

Playwright MCP resolves a relative filename against its own output dir, so always pass the ABSOLUTE path of the feature's `verification/` folder (`<feature folder>/verification/`); the CLI refuses screenshots outside it:
```
<feature folder>/verification/<screen>-<width>.png
```
e.g., `<feature folder>/verification/login-empty-375.png`. Pass the same path to `visual check --screenshot`.

## Element geometry

Run the DOM-rects `browser_evaluate` snippet from `references/visual-cli.md` and save it to `<feature folder>/verification/<screen>.hierarchy.json` (absolute) for `visual check --hierarchy`.

## After each scenario, close
```
mcp__plugin_playwright_playwright__browser_close()
```
