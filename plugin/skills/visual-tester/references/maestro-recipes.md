# Maestro recipes (mobile, `feature.json.platform == "mobile"`)

If `expo:*` skills are available, invoke `expo:expo-overview` first, then `expo:expo-dev-client` (dev builds) as needed. If they are not installed, see https://docs.expo.dev and use the minimum commands below (`npx expo start`, then open the app in Expo Go or a dev build).

This replaces the Playwright and breakpoint steps. The dev server URL still comes from `feature.json.dev_url` (shared key; ask the user once if missing).

## Device discovery

- iOS: `xcrun simctl list devices booted`
- Android: `adb devices`
- Use `expo:eas-simulator` (paid cloud simulator) **only on explicit user opt-in**. Never pick it automatically.

## No simulator or emulator available

Report `BLOCKED` with an explicit ask to the user (boot a simulator/emulator, or opt in to `expo:eas-simulator`). No silent skip. No automatic EAS fallback.

## Running flows

```
maestro --device {device} test -e OUT={out} <flow.yaml|dir>
```

Accepted device shapes only (`{device}` is the selector; the selector comes BEFORE the subcommand): `maestro --device {device} test -e OUT={out} <flow>` (also `--udid`, `--device=`; `maestro test --device …` is refused), `adb -s {device} <sub> …` (`-d`/`-e`/`-t` refused), `xcrun simctl <sub> {device} …`, `npx expo run:ios|run:android --device {device}`, `react-native run-ios --udid {device}`, `flutter run -d {device}`, cap/cordova `--target {device}`, detox `--device-name {device}`, gradle/gradlew only with an `emulator-NNNN` device (pinned via `ANDROID_SERIAL`). Refused outright: `xcrun devicectl`, `ios-deploy`, `idevice*` tools. `xcodebuild` is effectively unsupported (the grammar cannot express `-destination id={device}`). Every visual command verifies that `visual.device` is a listed simulator or attached emulator before spawning; emulator commands get `ANDROID_SERIAL`. `{out}` is the absolute `verification/` path of the feature.

- Expo Go: open the dev URL with `- openLink: <dev_url>`. Do not use `launchApp` with a custom appId.
- Dev build or EAS build: set `appId:` in the flow header and use `- launchApp`.
- React Native `testID="x"` maps to `id: x` in selectors.
- Prefer `visual run <flow>`; the CLI substitutes `{device}` from `visual.device` (simulator/emulator only) and uses the feature's absolute `verification/` path as `{out}`.
- Screenshots, one per device per golden path (path has no `.png`; always write to `${OUT}`, never a relative path, or the screenshot lands outside the feature's `verification/` and `visual check` refuses it):

```yaml
appId: com.example.app
---
- launchApp
- tapOn:
    id: login-button
- takeScreenshot: ${OUT}/LoginiPhone16
```

- `--format junit` and `--debug-output`: unverified, check `maestro test --help` before use.

## Hierarchy capture

After each screen, save element bounds for `visual check --hierarchy`:

```
maestro --device {device} hierarchy > {out}/<screen>.hierarchy.json
```

## Device labels in test-report.md

Device labels **must not contain hyphens**: the dashboard case parser treats any hyphen in the case name as the start of the detail text. Use `iPhone16` and `Pixel8_API35` (underscores are fine).

Each scenario x device is one bullet:

```markdown
- [pass] Login golden path @ iPhone16
- [fail] Login golden path @ Pixel8_API35 — submit button not visible
```

Keep the `visual-diff: <pass>/<total>` line and the frontmatter (`status`, `failures_count`) exactly as in the web flow. Spot-check also: no red-box errors or crash dialogs in the screenshots.
