# Recipes (profile `recipes`)

Home of the recipe grammar. Recipes are `[{name, cmd, params?, guards?, timeout_s?}]` in `.dev-cycle/project.json`, copied into the `feature init` snapshot (`feature.json.profile.recipes`). A content task's `**Recipe:**` must name one; its brief gains a `## Recipe` section. Run them only via `recipe run <name> [--param k=v]… [--task <n>] [--timeout <s>]`; never run a recipe command by hand. `recipe list [--json]` lists them. Artefact paths in a recipe are anchored (an absolute feature-folder path or a CLI placeholder such as `{out}`), never bare relative paths, because the spawning tool decides the cwd.

`recipe run` reads the snapshot `profile.recipes`, else `.dev-cycle/project.json`; validates params (exit 2, nothing run, on a bad call); spawns the argv without a shell; writes output also to `<feature>/content/<name>[-task-<n>].log`; exit 1 prints `recipe <name>: FAILED <reason>`.

## Execution model

Recipes run without a shell: `cmd` is split on spaces/tabs into argv words and each param value becomes one argv element, verbatim (no quoting, expansion, pipes or redirection). Trust model: the `cmd` is trusted, owner-authored code; the CLI guarantees only that param values are validated and never parsed by the CLI or a shell it starts.

## Grammar

Checked by `profile validate` and `recipe run`; a best-effort lint, not a sandbox.

- Printable ASCII only. No `` ; | & $ ` < > ( ) { } ' " \ * ? [ ] ~ # `` and no newline, except `{param}` placeholders.
- A placeholder is a whole word `{p}` or the value of `--flag={p}`.
- The first word is a literal program, not a shell (also `rbash`, `bash5`, …), command runner or builtin name (`env`, `command`, `exec`, `xargs`, `sudo`, `time`, `timeout`, `find`, `read`, …).
- With placeholders, the later words of a plain program are checked for shells/runners too (wrappers like `caffeinate`, `xcrun`; `.`/`source`/`exec`/`eval` count only as the program, so `git add . {p}` is fine).
- Between an interpreter (`node`, `python3`, `perl`, `npx`, `uv`, `sed`, `expect`, …) and its script word there is no code flag (`-e`, `-c`, `-p`, `-r`, `--eval`, …) and no placeholder; the script word is not an `exec`/`install`/`tool`/`task`-style subcommand; for `uv`/`pipx`/`bun`/`deno`, `run` needs a literal script path (`uv run scripts/gen.py {p}`). Words after the script are its own args (`python3 tools/gen.py -p {k}` is fine).
- `npm`/`pnpm`/`yarn` take no placeholders (script args go through a shell).
- Programs that treat their own arguments as code, a program path or a package (`git -c {p}`, `make --eval={p}`, `npx tsx {p}`) are the recipe author's responsibility.
- A param may set `allow_dash: true` (values starting with `-` are otherwise rejected); values are at most 1024 chars; a `pattern` is a string of at most 256 chars without nested quantifiers.

Example: `node scripts/tts.mjs --only {keys} --max-requests {n}`.

`content/` logs are committed with the feature folder: recipes must not print secrets; warn the user if one looks like it would.
