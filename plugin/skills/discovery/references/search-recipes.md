# Search recipes

## Find symbol definition

```bash
rg -n --type-add 'web:*.{ts,tsx,js,jsx,vue,svelte}' --type web 'export (function|const|class) <Name>'
```

## Find all callers of a function

```bash
rg -n '<funcName>\s*\(' -g '!node_modules' -g '!dist'
```

## Map a request flow (HTTP route → handler → service → repo)

1. Find route registration: `rg -n '<METHOD>.*["\x27]/<path>'`
2. From handler, follow imports: `rg -n 'from .*<handler-module>'`
3. Repeat until you hit DB or external IO.

## Find the entry point

- Node/JS: read `package.json` `main` / `scripts.start`
- Python: read `pyproject.toml`/`setup.py`/`__main__.py`
- Go: `cmd/*/main.go`

## Find tests for a module

```bash
rg -l '<moduleName>' -g '*test*' -g '*spec*'
```
