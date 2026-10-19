# React Native + Expo jest setup (mobile)

Use when `feature.json.platform == "mobile"` or `jest-expo` / `expo` is a dependency.

## Delegation

If `expo:*` skills are available, invoke `expo:expo-overview` first, then `expo:expo-animation` for Reanimated / Gesture Handler mocks. Do not copy their content here.

Fallback when `expo:*` skills are not installed: see https://docs.expo.dev/develop/unit-testing/ and run `npx expo install jest-expo jest @types/jest -- --dev`, then `npx jest`.

## Preset and library

- Preset: `"jest": { "preset": "jest-expo" }` in package.json.
- Use `@testing-library/react-native` (RNTL). Do not use `react-test-renderer`: it is deprecated and does not support React 19.

## pnpm transformIgnorePatterns

With pnpm, the pattern must include `.pnpm`. Keep ONE merged regex; do not declare the key twice.

```
node_modules/(?!(.pnpm|(jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@sentry/react-native|native-base|react-native-svg))
```

Add further untranspiled packages (e.g. `@shopify/react-native-skia`, `react-native-reanimated`, `react-native-gesture-handler`) as extra alternatives inside the same group.

## Mocks and setup per library

- **Reanimated 4 + worklets**: `resolver: 'react-native-reanimated/jest/resolver'`; in a `setupFilesAfterEnv` file call `require('react-native-reanimated').setUpTests()`. Also mock worklets: `jest.mock('react-native-worklets', () => require('react-native-worklets/src/mock'))` (a `react-native-worklets/jest/resolver` alternative exists from 0.8).
- **Gesture Handler**: `setupFiles: ['react-native-gesture-handler/jestSetup.js']`. Drive gestures with `fireGestureHandler`, `getByGestureTestId`, `createGestureController` from `react-native-gesture-handler/jest-utils`.
- **Skia**: `testEnvironment: "@shopify/react-native-skia/jestEnv.js"`, `setupFilesAfterEnv: ["@shopify/react-native-skia/jestSetup.js"]`, and add `@shopify/react-native-skia` to transformIgnorePatterns. The mock loads CanvasKit (web build).
- **MMKV v4**: API is `createMMKV()`; a mock is applied automatically under Jest, so no manual mock. Check the installed major first: v3 uses `new MMKV()` and differs.
- **expo-sqlite / Drizzle (unverified)**: no maintained official Jest mock exists; sources are community posts (medium confidence). Either inject the DB and run Drizzle over in-memory `better-sqlite3` (`drizzle-orm/better-sqlite3`) for query and migration tests, or mock at a repository seam.
- **expo-audio (unverified)**: no authoritative recipe fetched. Use `jest.mock('expo-audio')` at the module seam plus jest-expo's built-in Expo module mocks. Verify against the installed version.
- **RevenueCat `react-native-purchases` (unverified)**: no authoritative recipe fetched. Use `jest.mock('react-native-purchases')` at the module seam and stub the calls under test. Verify.
- **Sentry `@sentry/react-native` (unverified)**: no authoritative recipe fetched. Use `jest.mock('@sentry/react-native')` at the module seam; keep it in transformIgnorePatterns (above). Verify.
