# Frontend pitfalls (don't do these)

## State
- Storing derived data in state. Compute it in render.
- Calling setState inside render.
- Mutating state directly (`state.items.push(x)`).

## Effects
- Empty deps array `[]` to "run once" when the effect actually depends on something — causes stale closures.
- Putting non-stable objects/functions in deps without memoization.
- Network calls in `useEffect` instead of a query lib.

## Styling
- Inline `style={{}}` for layout. Use the project's CSS approach.
- `!important` to override. Fix the cascade.
- Hardcoded breakpoints. Use the project's scale.

## A11y
- `<div onClick>` for buttons.
- `placeholder` as the only label.
- Removing focus outlines without replacing them.
- Color as the only signal (red text on white "error" — needs an icon or text too).

## Performance
- Rendering huge lists without virtualization.
- Memoizing everything reflexively. Only memoize when profiling shows a problem.
- Re-fetching on every render due to unstable query keys.

## i18n / strings
- Hardcoded user-facing strings in components when an i18n system exists.

## Tests
- Snapshot tests for components with frequent design churn — they become noise.
- Testing with `getByTestId` when a role/label query works.

## React Native
- Rendering raw strings or numbers outside `<Text>` (crashes on native).
- Missing or index-based `key` / `keyExtractor` in FlatList / FlashList; using `ScrollView` + `map` for long lists.
- Driving animation from the JS thread with `setState` or `Animated` JS drivers; use Reanimated worklets (`expo:expo-animation`).
- Ignoring safe areas (notch, home indicator); use `react-native-safe-area-context`.
- No keyboard avoidance on forms; inputs hidden behind the keyboard.
- Scattered `Platform.OS` branches in components; prefer `Platform.select` or `.ios.tsx` / `.android.tsx` files.
