# `dev-cycle visual` reference

Run as `node ${CLAUDE_PLUGIN_ROOT}/scripts/dev-cycle.mjs visual <sub> …`. Commands never use a shell. State lives in `verification/manifest.json`. `{out}` is the absolute feature `verification/` path; paths passed to `check` must be inside it.

## Commands

| Command | What it does |
|---|---|
| `visual plan [--all]` | Selects screens from `profile.visual.screens` plus the spec `## Screens` table, writes the plan, prints ids with `timeout_s` and the budget. No catalog prints `no catalog: ad-hoc mode`, exit 0. |
| `visual build [--force]` | Builds only when `build.inputs` hash changed; starts `build.serve`; boots the simulator or emulator if needed and records what it started. Exit 2 without an explicit simulator/emulator. |
| `visual run <screen-or-flow>` | Runs a flow screen with its time limit (default 180 s); the process group is killed on timeout. Refuses `route` screens (exit 2). |
| `visual mark <screen> start\|end [--adhoc]` | Times an agent-driven screen. `mark <id> start` and `run` begin a fresh attempt: prior results and fail reasons for that screen are cleared. Over the limit is `overrun`; over twice the limit is `timeout`. `--adhoc` registers an id outside the catalog. |
| `visual check <screen> --screenshot <png> [--hierarchy <file>] [--measure …]… [--source vision] [--fail "<reason>"]… [--adhoc]` | Computes support, scale, overlap, tap and colors checks and stores each as pass, fail or unmeasured. |
| `visual teardown` | Stops only what `build`/`run` started (recorded devices, process groups, `visual.teardown` commands). Writes `verification/teardown.json`. Exit 0 even if a step failed. |
| `visual verdict` | Decides PASSED or FAILED, writes `## Visual tests` and `## AC coverage — visual`. Exit 1 on FAILED. Fails without a fresh teardown. |
| `visual gallery` | Writes `verification/index.html`: screenshot, reference, checklist, durations. |

A failed or `unmeasured` check, a `--fail`, a timeout, a missing screen or reference, a build failure, an over-budget run and a missing teardown all make the verdict FAILED.

## Vision measure format

For elements with no id in the hierarchy, supply numbers read off the screenshot and reference:

```
--measure <check>:<subject>=<number> --source vision
```

- `scale:friend/hero=0.88` is the height ratio A/B.
- `support:friend=0.02` is the gap as a fraction of the element's height.
- `overlap:a/b=0` is the overlap fraction of the smaller box.
- `colors:#ff0000=1.5` is the percentage of pixels near that colour.

Values must be finite numbers. The CLI applies the same tolerance as for measured values, with no leniency.

## DOM rects (web) — `browser_evaluate`

Replace the ids with the `elements` ids of the screen (the values of `screens[].elements`, not the element names or check subjects; `visual check` looks boxes up by id), run, and save the result to `verification/<screen>.hierarchy.json`:

```js
() => {
  const ids = ["hero", "friend"];
  const elements = {};
  for (const id of ids) {
    const el = document.querySelector(`[data-testid="${id}"], #${id}`);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    elements[id] = { x: r.x, y: r.y, width: r.width, height: r.height };
  }
  return { elements };
}
```

## Maestro hierarchy capture (mobile)

```
maestro --device {device} hierarchy > {out}/<screen>.hierarchy.json
```

Use the device id from `visual.device`. Accepted device shapes only (`{device}` is the selector; the selector comes BEFORE the subcommand): `maestro --device {device} test -e OUT={out} <flow>` (also `--udid`, `--device=`; `maestro test --device …` is refused), `adb -s {device} <sub> …` (`-d`/`-e`/`-t` refused), `xcrun simctl <sub> {device} …`, `npx expo run:ios|run:android --device {device}`, `react-native run-ios --udid {device}`, `flutter run -d {device}`, cap/cordova `--target {device}`, detox `--device-name {device}`, gradle/gradlew only with an `emulator-NNNN` device (pinned via `ANDROID_SERIAL`). Refused outright: `xcrun devicectl`, `ios-deploy`, `idevice*` tools. `xcodebuild` is effectively unsupported (the grammar cannot express `-destination id={device}`). Every visual command verifies that `visual.device` is a listed simulator or attached emulator before spawning; emulator commands get `ANDROID_SERIAL`. Element ids come from `resource-id`, `accessibilityText` or `id` (React Native `testID`).
