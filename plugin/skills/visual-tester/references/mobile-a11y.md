# Mobile a11y (static checks)

Used when `feature.json.platform == "mobile"`. axe-core does not run against native views, so audit statically instead. No dev server is needed.

## Delegation

If `expo:*` skills are available, invoke `expo:expo-overview` first, then `expo:expo-native-ui`. Do not copy their content here.

Fallback when they are not installed: see https://docs.expo.dev/ (accessibility guidance in the React Native docs at https://reactnative.dev/docs/accessibility). Minimum commands: `npx eslint <touched paths>` and `npx tsc --noEmit`.

## Checks

1. **Lint plugin.** Run `eslint-plugin-react-native-a11y` only if it loads with the project's ESLint config (flat-config support is unverified). If it does not load, skip it and use step 2; do not change the project's ESLint setup.
2. **Manual checklist + RNTL role-query review.** Review touched components by hand. Confirm interactive elements are reachable with React Native Testing Library `getByRole(...)` and that each has an accessible name (label or text).
3. **Props.** Prefer `role` / `aria-*` props over `accessibility*` props (`accessibilityRole`, `accessibilityLabel`, ...). Accept either form; do not fail a task for using `accessibility*`.
4. **Touch targets.** At least 44pt (iOS) and 48dp (Android). `hitSlop` may be used to reach the minimum.
5. **Font scaling.** Text must respect Dynamic Type / font scaling. Flag `allowFontScaling={false}` without justification; check `maxFontSizeMultiplier` caps do not clip content.
6. **Reduce motion.** Animations must honour the reduce-motion setting: Reanimated (`useReducedMotion`), Rive and Skia (gate or skip playback when reduce motion is on).

## Status mapping

- PASSED: no failing item in checks 2-6, and the lint plugin (if it loaded) reports no errors.
- FAILED: any failing item. `failures_count` is the number of failing items.

## test-report.md section

```markdown
## Task <N> a11y (mobile static) — <ISO ts> — PASSED|FAILED
- [pass] touch targets
- [fail] touch targets — src/components/Close.tsx — 32pt (need 44pt iOS / 48dp Android)
- [fail] reduce motion — src/components/Hero.tsx — Reanimated loop ignores useReducedMotion
- [skip] eslint-plugin-react-native-a11y — did not load with project ESLint config
```
