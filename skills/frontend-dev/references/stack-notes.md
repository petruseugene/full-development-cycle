# Stack-specific notes

Detect from `package.json`. If the project uses something not listed here, follow general best-practices and learn from existing components.

## React (any version)
- Function components + hooks. No class components.
- Keys on lists must be stable; `index` is OK only for static lists.
- `useCallback` / `useMemo` only when the consumer's identity matters (memoized child, deps array of another hook).

## React + TypeScript
- Use `type` for props and component types: `type Props = { ... }`.
- Avoid `React.FC` (deprecated pattern).
- Discriminated unions for variants: `type Variant = { kind: 'a' } | { kind: 'b'; payload: X }`.

## Next.js (App Router)
- Server components by default. Add `'use client'` only when you need interactivity.
- Don't fetch on the client when a server component can do it.
- `<Link>` for internal navigation, not `<a href>`.

## Vue 3 (Composition API)
- `<script setup>` syntax. Reactive state via `ref` / `reactive`.
- Computed for derived state. Watchers for side effects only.

## Svelte / SvelteKit
- Stores for cross-component state, $-syntax for derived.
- `+page.server.ts` / `+page.ts` per SvelteKit conventions for data loading.

## Vanilla JS / no framework
- One module per concern. Export functions, not classes (unless the API benefits).
- Document what's a side effect vs pure helper.

## Styling — known stacks
- **Tailwind**: utilities only; no `@apply` outside of design-token components.
- **CSS Modules**: one file per component, `.module.css`.
- **CSS-in-JS (styled-components / emotion)**: prefer object syntax over template literals for type safety.
- **Plain CSS**: BEM or scoped via build tool; never global selectors mid-tree.

## React Native + Expo (Expo Router)
Detected when `expo` is a dependency. If `expo:*` skills are available, invoke `expo:expo-overview` first, then the specific skill:
- Routing and navigation: `expo:expo-router`.
- Animation, gestures, haptics (Reanimated, Gesture Handler): `expo:expo-animation`.
- Native controls (sheets, pickers, toggles): `expo:expo-ui`; platform styling: `expo:expo-native-ui`.
- Theme tokens and shared components: `expo:expo-design-system`.
- Network requests and caching: `expo:expo-data-fetching`.

Fallback when `expo:*` skills are not installed: read https://docs.expo.dev and use the minimum commands `npx expo install <pkg>`, `npx expo start`, `npx expo-doctor`.

Library notes (one line each):
- Skia (`@shopify/react-native-skia`): GPU canvas drawing; needs its Jest env/setup files in tests.
- Rive (`rive-react-native`): state-machine vector animation; needs a dev build, not Expo Go.
- MMKV (`react-native-mmkv`): fast key-value storage; v4 uses `createMMKV()`, v3 uses `new MMKV()`; check the installed major.
- expo-sqlite + Drizzle: local SQL; migrations are forward-only and bundled via `drizzle-kit generate`.
- expo-audio: audio playback and recording; mock at the module seam in tests (mock recipe unverified).
- i18next (`react-i18next`): keep all user-facing strings in translation files.
