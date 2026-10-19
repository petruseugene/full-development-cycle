'use client';

/**
 * ChatTabFeatureContext — propagates the active `featureId` from `ChatTab`
 * to its descendant event renderers without prop drilling.
 *
 * Spec / AC refs:
 *   - R27 error — the `Retry` button on `ErrorCard` calls
 *                 `POST /api/agent/[featureId]/resume`, so it needs the
 *                 currently-active featureId
 *
 * Why a separate module: `ChatTab.tsx` uses a module-level renderer registry
 * (`registerEventRenderer`) so downstream renderers can attach without
 * changing ChatTab's prop surface. The registry's renderer signature is
 * `ComponentType<{ event: E }>` — there's no slot for additional props like
 * `featureId`. Renderers that need it (today: `ErrorCard`'s `Retry` POST)
 * read it from this context.
 *
 * The provider is mounted at the top of `ChatTab` and feeds the current
 * `featureId` prop verbatim; renderers that don't need it (most) simply
 * ignore the context.
 */

import { createContext } from 'react';

/**
 * Active featureId for the rendered Chat tab. `null` when no feature is
 * selected (drawer closed, or empty state). Renderers that POST against the
 * `/api/agent/[featureId]/…` routes must early-return / disable controls
 * when this is `null`.
 */
export const ChatTabFeatureContext = createContext<string | null>(null);
