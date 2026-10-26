'use client';

/**
 * ChatDrawer — Task 10 skeleton + Task 11 chrome (resize handle, header
 * overflow menu, tab strip with persistence). Spec refs R21/R22/R23/R24/R25,
 * AC6 (Kill from overflow menu), AC12 (resize handle keyboard-focusable),
 * AC13 (header element order + status chip palette), AC14 (tab strip).
 *
 * Wireframe contract: `wireframes/chat-drawer-chat-tab.html`. Header element
 * order and tab strip border treatment match column-for-column.
 *
 * Task 11 adds:
 *   - Pointer-drag + keyboard-arrow resize of the left-edge handle, with the
 *     final width persisted to `localStorage['chat-drawer-width']`. Clamp
 *     range is `[360, min(900, 0.6 * window.innerWidth)]` (AC12).
 *   - `useSessionStatus(featureId)` — minimal status read off
 *     `POST /api/agent/<id>/start` collision (409 → running) and the SSE
 *     stream's first `status` frame. Full streaming wiring lands in Task 12.
 *   - Overflow `⋯` menu with two items (Kill session, Open events log).
 *     Positioning reuses the anchored-popover idiom from `FiltersPopover`
 *     (relative wrapper + absolute popover, mousedown-outside/Escape close).
 *   - Tab strip selection persisted to
 *     `sessionStorage['chat-drawer-tab:<featureId>']`. Stats/Files render
 *     "Coming soon" placeholders until T15/T16.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import type { Feature } from '@/lib/types';
import { useSnapshot } from '@/lib/snapshot-context';
import ChatTab from './chat/ChatTab';
import StatsTab from './chat/StatsTab';
import FilesTab from './chat/FilesTab';

// Default width per AC12 (R21 sets the min/max envelope).
const DEFAULT_WIDTH = 480;
const MIN_WIDTH = 360;
const MAX_WIDTH_ABS = 900;
const KEY_NUDGE_PX = 12;
const KEY_NUDGE_SHIFT_PX = 48;
const WIDTH_LS_KEY = 'chat-drawer-width';
const TAB_SS_KEY_PREFIX = 'chat-drawer-tab:';

// Anchored under the dashboard TopBar (`h-12` → 48px). Wireframes show 56px
// because the wireframe TopBar is taller; we mirror the live shell's height
// so the drawer doesn't peek into the topbar in production.
const TOP_OFFSET = 48;

// Selector for focusable children inside the drawer (focus trap — AC12 /
// a11y-auditor BLOCKER #2). Mirrors `TaskModal`'s pattern so behaviour is
// consistent across the two overlays.
const FOCUSABLE_SELECTOR =
  'a[href], area[href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), iframe, object, embed, [tabindex]:not([tabindex="-1"]), [contenteditable=true]';

// GitHub URL for the README anchor referenced by the AC16 API-key alert.
// The previous `../../README.md#anthropic-api-key` relative href didn't
// resolve from the `/` route (code-reviewer F5); pointing at the canonical
// GitHub copy avoids relying on Next.js statically serving a Markdown file.
const README_API_KEY_URL =
  'https://github.com/petruseugene/full-development-cycle/blob/main/dashboard/README.md#anthropic-api-key';

type SessionState =
  | { kind: 'no_session' }
  | { kind: 'starting' }
  | { kind: 'api_key_missing' }
  | { kind: 'errored'; message: string };

/** Session-status values shown in the header chip (AC13). */
type SessionStatus =
  | 'no_session'
  | 'running'
  | 'idle'
  | 'awaiting_approval'
  | 'errored';

type TabKey = 'chat' | 'stats' | 'files';

function findFeature(
  features: Feature[],
  featureId: string | null,
): Feature | null {
  if (!featureId) return null;
  return (
    features.find((f) => f.id === featureId) ??
    features.find((f) => f.slug === featureId) ??
    null
  );
}

/**
 * Compute the upper clamp for drawer width. Pulled out so the pointer +
 * keyboard handlers (and the on-mount validator) all use one formula.
 * Returns `MAX_WIDTH_ABS` when called in SSR / before mount; the effect
 * that reads `localStorage` re-runs once `window` is available.
 */
function getMaxWidth(): number {
  if (typeof window === 'undefined') return MAX_WIDTH_ABS;
  return Math.min(MAX_WIDTH_ABS, Math.round(window.innerWidth * 0.6));
}

function clampWidth(w: number): number {
  return Math.max(MIN_WIDTH, Math.min(getMaxWidth(), w));
}

/**
 * Minimal session-status hook for Task 11 — enough to drive the header chip
 * palette without the full SSE wiring (which lands in Task 12). On open we
 * issue a HEAD-ish `POST /start` that the server replies to with 409
 * `session_already_exists` when one is live (R1). Treat the 409 as
 * "running" for header purposes; everything else stays `no_session` until
 * Task 12 attaches the SSE stream.
 *
 * The hook exposes `setStatus` so the parent can flip the chip optimistically
 * when the overflow menu's `Kill` button succeeds (`no_session`) or when the
 * empty-state Start button reports `running`.
 */
function useSessionStatus(featureId: string | null): {
  status: SessionStatus;
  setStatus: (s: SessionStatus) => void;
} {
  const [status, setStatus] = useState<SessionStatus>('no_session');

  useEffect(() => {
    if (!featureId) {
      setStatus('no_session');
      return;
    }
    let cancelled = false;
    // Probe via a non-mutating GET on the SSE endpoint isn't possible
    // without subscribing (R8 streams), so we subscribe with a one-shot
    // EventSource that closes after the first `status` frame.
    const url = `/api/agent/${encodeURIComponent(featureId)}/stream`;
    let es: EventSource | null = null;
    try {
      es = new EventSource(url);
    } catch {
      // Browsers without EventSource — fine, the chip will read `no_session`.
      return;
    }
    const onStatus = (ev: MessageEvent): void => {
      if (cancelled || !es) return;
      try {
        const payload = JSON.parse(ev.data) as { status?: string };
        const next = payload.status;
        if (
          next === 'running' ||
          next === 'idle' ||
          next === 'awaiting_approval' ||
          next === 'errored' ||
          next === 'no_session'
        ) {
          setStatus(next);
        }
      } catch {
        // Ignore malformed frame — Task 12 will replace this with a typed parser.
      }
      // Task 11 only needs the first frame for the chip palette; close to
      // avoid leaking a connection. Task 12 will replace this hook with the
      // long-lived stream that drives the chat log too.
      es.close();
      es = null;
    };
    es.addEventListener('status', onStatus as EventListener);
    es.onerror = (): void => {
      // The server closes the stream after the `no_session` frame; ignore
      // the resulting `error` event so it doesn't spam the console.
      if (es) {
        es.close();
        es = null;
      }
    };
    return () => {
      cancelled = true;
      if (es) es.close();
    };
  }, [featureId]);

  return { status, setStatus };
}

/** Header status chip class + label per AC13. */
function statusChipFor(
  status: SessionStatus,
  apiKeyMissing: boolean,
): { className: string; label: string; style?: CSSProperties } {
  if (apiKeyMissing) {
    return { className: 'chip st-errored', label: 'Config needed' };
  }
  switch (status) {
    case 'running':
      return { className: 'chip st-running', label: 'Running' };
    case 'awaiting_approval':
      return { className: 'chip st-awaiting', label: 'Awaiting approval' };
    case 'idle':
      // AC13 maps idle → st-running (warn-bg) with a paler text colour to
      // keep the warm-yellow chip but hint the session isn't actively
      // streaming. Inline opacity is the lightest-touch way to pale it
      // without minting a new CSS class (spec §5 forbids new globals).
      return {
        className: 'chip st-running',
        label: 'Idle',
        style: { opacity: 0.7 },
      };
    case 'errored':
      return { className: 'chip st-errored', label: 'Errored' };
    case 'no_session':
    default:
      return { className: 'chip st-none', label: 'No session' };
  }
}

export function ChatDrawer() {
  const { snapshot, chatDrawerOpen, chatFeatureId, closeChat } = useSnapshot();
  const drawerRef = useRef<HTMLElement | null>(null);

  // ── Resize state (AC12) ────────────────────────────────────────────────
  // `width` is the live value driving the inline `style.width`. Pointer
  // drags update it on every `pointermove`; the `pointerup` handler
  // persists the final value. Keyboard-arrow nudges go through the same
  // setter so the persistence path is identical.
  const [width, setWidth] = useState<number>(DEFAULT_WIDTH);
  const draggingRef = useRef<{ startX: number; startWidth: number } | null>(
    null,
  );

  // Read persisted width once after mount. `localStorage` is unavailable
  // server-side so we keep the SSR-safe default (480) and reconcile here.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(WIDTH_LS_KEY);
      if (!raw) return;
      const parsed = Number.parseInt(raw, 10);
      if (Number.isFinite(parsed)) setWidth(clampWidth(parsed));
    } catch {
      // SecurityError in some embedded contexts — fall through to default.
    }
  }, []);

  const persistWidth = useCallback((w: number) => {
    try {
      window.localStorage.setItem(WIDTH_LS_KEY, String(w));
    } catch {
      // Ignore quota / SecurityError — width still applies for this session.
    }
  }, []);

  const onResizePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Left-button only; ignore touch-emulated right-clicks.
      if (e.button !== 0) return;
      e.preventDefault();
      draggingRef.current = { startX: e.clientX, startWidth: width };
      // Capture so we keep getting moves even when the pointer leaves the
      // 6px handle hit area.
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [width],
  );

  const onResizePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = draggingRef.current;
      if (!drag) return;
      // Drawer is right-anchored — dragging the LEFT edge LEFTWARD grows
      // the drawer, so the delta is inverted.
      const delta = drag.startX - e.clientX;
      const next = clampWidth(drag.startWidth + delta);
      setWidth(next);
    },
    [],
  );

  const onResizePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      draggingRef.current = null;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // Capture already released — happens when the pointer leaves the
        // viewport mid-drag in some browsers. Safe to ignore.
      }
      persistWidth(width);
    },
    [persistWidth, width],
  );

  const onResizeKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const step = e.shiftKey ? KEY_NUDGE_SHIFT_PX : KEY_NUDGE_PX;
      // ArrowLeft grows the drawer (left edge moves left); ArrowRight shrinks.
      const delta = e.key === 'ArrowLeft' ? step : -step;
      setWidth((w) => {
        const next = clampWidth(w + delta);
        persistWidth(next);
        return next;
      });
    },
    [persistWidth],
  );

  // Empty state controller. Initialized fresh on every (re)open so that a
  // dismissed API-key alert returns to the "Start orchestrator" CTA the next
  // time the user opens the drawer.
  const [sessionState, setSessionState] = useState<SessionState>({
    kind: 'no_session',
  });

  useEffect(() => {
    if (chatDrawerOpen) setSessionState({ kind: 'no_session' });
  }, [chatDrawerOpen, chatFeatureId]);

  // ── Session-status chip ────────────────────────────────────────────────
  const { status: sessionStatus, setStatus: setSessionStatus } =
    useSessionStatus(chatDrawerOpen ? chatFeatureId : null);

  // ── Focus management (a11y BLOCKER #2 / AC12) ──────────────────────────
  // Save the previously-focused element when the drawer opens; restore on
  // close. Mirrors the TaskModal pattern so the drawer behaves like a
  // genuine modal even though the underlying `<aside>` doesn't have an
  // implicit focus contract.
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  // Used to detect open transitions (closed → open) without firing the
  // open-time logic on every `chatFeatureId` switch within an open drawer.
  const wasOpenRef = useRef<boolean>(false);

  useEffect(() => {
    if (!chatDrawerOpen) {
      const prev = previouslyFocusedRef.current;
      if (
        wasOpenRef.current &&
        prev &&
        typeof prev.focus === 'function' &&
        document.contains(prev)
      ) {
        prev.focus();
      }
      previouslyFocusedRef.current = null;
      wasOpenRef.current = false;
      return;
    }
    if (!wasOpenRef.current) {
      previouslyFocusedRef.current =
        (document.activeElement as HTMLElement) ?? null;
      // Move focus into the drawer on the next frame. The close `✕` button
      // is the standard initial focus target for a dialog opened
      // programmatically — same convention as TaskModal's autofocus Close.
      const id = window.setTimeout(() => {
        const root = drawerRef.current;
        if (!root) return;
        const closeBtn = root.querySelector<HTMLButtonElement>(
          'button[aria-label="Close chat drawer"]',
        );
        closeBtn?.focus();
      }, 0);
      wasOpenRef.current = true;
      return () => window.clearTimeout(id);
    }
  }, [chatDrawerOpen]);

  // Tab key cycles within the drawer (AC12). Shift+Tab on the first
  // focusable element wraps to the last, and vice-versa.
  useEffect(() => {
    if (!chatDrawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const root = drawerRef.current;
      if (!root) return;
      const focusables = Array.from(
        root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((el) => !el.hasAttribute('disabled') && el.tabIndex !== -1);
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (active === first || !root.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (active === last || !root.contains(active)) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [chatDrawerOpen]);

  // ── Auto-resume on drawer open (R42 / AC8 — code-reviewer F6) ──────────
  // When the drawer opens for a feature with a persisted session, ask the
  // server to re-attach. The endpoint returns 404 `no_session_to_resume`
  // when there's nothing to resume — that's the natural signal to keep
  // the no-session empty state. Gated on a closed→open transition so the
  // call doesn't refire when only `chatFeatureId` changes mid-open.
  const lastResumedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!chatDrawerOpen || !chatFeatureId) return;
    // De-dupe — if we already resumed for this (open, featureId) pair,
    // don't fire again. The key flips back to null on close so a fresh
    // open of the same feature retries (e.g. after a Kill).
    const key = chatFeatureId;
    if (lastResumedKeyRef.current === key) return;
    lastResumedKeyRef.current = key;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/agent/${encodeURIComponent(key)}/resume`,
          { method: 'POST' },
        );
        if (cancelled) return;
        if (res.ok) {
          let body: { status?: string } | null = null;
          try {
            body = (await res.json()) as { status?: string };
          } catch {
            body = null;
          }
          const next = body?.status;
          if (
            next === 'running' ||
            next === 'idle' ||
            next === 'awaiting_approval' ||
            next === 'errored'
          ) {
            setSessionStatus(next);
          } else {
            // Server replied OK but no recognised status — assume running.
            setSessionStatus('running');
          }
          return;
        }
        // 404 → no_session_to_resume. Keep the empty state untouched.
        // Other errors are swallowed; the user can still click
        // "Start orchestrator" from the empty state.
      } catch {
        // Network failure — leave empty state in place.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chatDrawerOpen, chatFeatureId, setSessionStatus]);

  // Reset the resume dedupe key when the drawer closes so re-opening the
  // same feature later re-issues the resume probe.
  useEffect(() => {
    if (!chatDrawerOpen) lastResumedKeyRef.current = null;
  }, [chatDrawerOpen]);

  // ── Tabs (AC14) ────────────────────────────────────────────────────────
  // Default to Chat; per-feature persistence in sessionStorage so reopening
  // the same feature returns to the last-viewed tab in the same browser tab.
  const [activeTab, setActiveTab] = useState<TabKey>('chat');
  useEffect(() => {
    if (!chatDrawerOpen || !chatFeatureId) {
      setActiveTab('chat');
      return;
    }
    try {
      const raw = window.sessionStorage.getItem(
        `${TAB_SS_KEY_PREFIX}${chatFeatureId}`,
      );
      if (raw === 'chat' || raw === 'stats' || raw === 'files') {
        setActiveTab(raw);
        return;
      }
    } catch {
      // sessionStorage unavailable — keep default.
    }
    setActiveTab('chat');
  }, [chatDrawerOpen, chatFeatureId]);

  const selectTab = useCallback(
    (tab: TabKey) => {
      setActiveTab(tab);
      if (!chatFeatureId) return;
      try {
        window.sessionStorage.setItem(
          `${TAB_SS_KEY_PREFIX}${chatFeatureId}`,
          tab,
        );
      } catch {
        // Ignore — chip selection still works for the current open.
      }
    },
    [chatFeatureId],
  );

  // ── Overflow menu (AC6) ────────────────────────────────────────────────
  // Anchored popover positioned by a `position:relative` wrapper around the
  // `⋯` button. Mirrors the FiltersPopover idiom — `mousedown-outside`
  // closes, Escape closes, focus returns to the trigger on close.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuWrapperRef = useRef<HTMLDivElement | null>(null);
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      if (!menuWrapperRef.current) return;
      if (!menuWrapperRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Don't bubble — otherwise the drawer's own Escape handler closes
        // the whole drawer instead of just the menu.
        e.stopPropagation();
        setMenuOpen(false);
        menuTriggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const onKillSession = useCallback(async () => {
    if (!chatFeatureId) return;
    setMenuOpen(false);
    try {
      const res = await fetch(
        `/api/agent/${encodeURIComponent(chatFeatureId)}/kill`,
        { method: 'POST' },
      );
      if (res.ok) {
        // AC6 — return to the no-session empty state. The header chip
        // flips optimistically; Task 12's SSE wiring will replace this
        // with the server-emitted `phase: 'killed'` frame.
        setSessionStatus('no_session');
        setSessionState({ kind: 'no_session' });
      }
    } catch {
      // Network failure — leave the chip alone; the user can retry.
    }
  }, [chatFeatureId, setSessionStatus]);

  const onOpenEventsLog = useCallback(() => {
    if (!chatFeatureId) return;
    setMenuOpen(false);
    // Events log lives at `<projectRoot>/dashboard/.runtime/sessions/<id>.events.jsonl`.
    // The browser cannot compute the absolute filesystem path without help
    // from the server. Two reasonable strategies:
    //   (1) Add `<meta name="runtime-sessions-dir" content="<abs>">` from
    //       `app/layout.tsx` (out of scope for Task 11's Touches).
    //   (2) Open `vscode://file/<relpath>`; VS Code resolves it against the
    //       open workspace — which the dashboard developer typically has.
    // We pick (2) for Task 11 with a (1) fallback if the meta tag is later
    // injected; both go through `window.open` so the user sees a single
    // editor-handoff path regardless of strategy.
    const filename = `${chatFeatureId}.events.jsonl`;
    let url = `vscode://file/dashboard/.runtime/sessions/${filename}`;
    if (typeof document !== 'undefined') {
      const meta = document.querySelector<HTMLMetaElement>(
        'meta[name="runtime-sessions-dir"]',
      );
      const abs = meta?.content;
      if (abs) {
        const sep = abs.endsWith('/') ? '' : '/';
        url = `vscode://file/${abs}${sep}${filename}`;
      }
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  }, [chatFeatureId]);

  // Escape closes the drawer (R22). Registered only while open so other
  // Escape-listeners (TaskModal, CommandPalette) keep working when the
  // chat drawer is dismissed.
  useEffect(() => {
    if (!chatDrawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      // If another overlay (e.g. the TaskModal) already handled this
      // Escape — it calls `preventDefault()` — let it take precedence so a
      // single Escape press doesn't dismiss both the modal and the drawer.
      if (e.defaultPrevented) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        closeChat();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [chatDrawerOpen, closeChat]);

  // Outside-click closes (R22 — no scrim; clicks on the Board behind the
  // drawer dismiss it but the Board's task-card handler reads
  // `chatClosedAt` from SnapshotContext to suppress the click for 200ms).
  // We use `mousedown` rather than `click` so the close fires before the
  // underlying card receives its `click`; the close-grace timestamp set by
  // `closeChat()` is then visible to the card handler.
  useEffect(() => {
    if (!chatDrawerOpen) return;
    const onDocMouseDown = (e: MouseEvent) => {
      const root = drawerRef.current;
      if (!root) return;
      const target = e.target as Node | null;
      if (target && root.contains(target)) return;
      // If the TaskModal is open on top (it sets `role="dialog"` +
      // `aria-modal="true"` on its container, and the click landed inside
      // the modal scrim/container), defer to the modal — closing the chat
      // here would be a surprising side-effect of clicking the modal scrim.
      if (target instanceof Element) {
        const modalRoot = (target as Element).closest(
          '[role="dialog"][aria-modal="true"]',
        );
        if (modalRoot) return;
        const scrim = (target as Element).closest('[role="presentation"]');
        if (scrim) return;
      }
      closeChat();
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [chatDrawerOpen, closeChat]);

  const feature = useMemo(
    () => findFeature(snapshot?.features ?? [], chatFeatureId),
    [snapshot, chatFeatureId],
  );

  const slug = feature?.slug ?? chatFeatureId ?? '';
  const phase = feature?.meta?.current_phase ?? null;

  const onStart = useCallback(async () => {
    if (!chatFeatureId) return;
    setSessionState({ kind: 'starting' });
    try {
      const res = await fetch(
        `/api/agent/${encodeURIComponent(chatFeatureId)}/start`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        },
      );
      if (res.ok) {
        // Live event handling (R8 SSE attach) lands in Task 12. For the
        // skeleton, success simply clears the empty-state CTA — the next
        // task will replace this branch with the streaming chat log. We
        // flip the header chip optimistically so AC13's "running" palette
        // shows immediately.
        setSessionState({ kind: 'no_session' });
        setSessionStatus('running');
        return;
      }
      // Try to parse the SDK error body. R18 / AC8 / AC16 hinge on the
      // exact body shape `{ error: 'ANTHROPIC_API_KEY not set' }`.
      let body: { error?: string; message?: string } | null = null;
      try {
        body = (await res.json()) as { error?: string; message?: string };
      } catch {
        body = null;
      }
      if (res.status === 500 && body?.error === 'ANTHROPIC_API_KEY not set') {
        setSessionState({ kind: 'api_key_missing' });
        return;
      }
      setSessionState({
        kind: 'errored',
        message: body?.message ?? body?.error ?? `Start failed (${res.status})`,
      });
    } catch (err) {
      setSessionState({
        kind: 'errored',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [chatFeatureId, setSessionStatus]);

  if (!chatDrawerOpen) return null;

  const isApiKeyMissing = sessionState.kind === 'api_key_missing';
  const statusChip = statusChipFor(sessionStatus, isApiKeyMissing);

  return (
    <aside
      ref={drawerRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Chat: ${slug || 'feature'}`}
      className="bg-white border-l border-line flex flex-col z-40"
      style={{
        position: 'fixed',
        top: TOP_OFFSET,
        right: 0,
        bottom: 0,
        width,
        boxShadow: '-2px 0 12px rgba(15, 23, 42, 0.06)',
      }}
    >
      {/* Resize handle (AC12) — 6px hit area, dashed visual cue inherited
          from the wireframe's `.resize-handle::before`. Pointer drag updates
          width and persists on `pointerup`. Keyboard nudges via Left/Right
          (12px) and Shift+Left/Right (48px). */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize chat drawer"
        aria-valuenow={width}
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={MAX_WIDTH_ABS}
        tabIndex={0}
        className="resize-handle"
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={onResizePointerUp}
        onPointerCancel={onResizePointerUp}
        onKeyDown={onResizeKeyDown}
        style={{
          position: 'absolute',
          left: -3,
          top: 0,
          bottom: 0,
          width: 6,
          cursor: 'ew-resize',
          touchAction: 'none',
        }}
      />

      {/* Header chrome — AC13. Element order:
            (1) slug-pill, (2) phase chip, (3) status chip,
            (4) ⋯ overflow trigger, (5) ✕ close. */}
      <header className="flex items-center gap-2 px-3 py-2 border-b border-line bg-canvas">
        <div className="flex-1 flex items-center gap-2 flex-wrap min-w-0">
          {slug ? <span className="slug-pill mono">{slug}</span> : null}
          {phase ? (
            <span className={`chip phase-${phase}`}>{phase}</span>
          ) : null}
          <span className={statusChip.className} style={statusChip.style}>
            {statusChip.label}
          </span>
        </div>

        {/* Overflow menu wrapper (relative anchor for the popover). */}
        <div ref={menuWrapperRef} className="relative">
          <button
            ref={menuTriggerRef}
            type="button"
            aria-label="Session menu"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((o) => !o)}
            className="selpill"
            style={{ height: 26, minWidth: 26, padding: '0 6px' }}
          >
            ⋯
          </button>
          {menuOpen && (
            <div
              role="menu"
              aria-label="Session actions"
              // Mirrors `FiltersPopover` positioning utility classes —
              // `absolute top-full mt-1 right-0 z-20` + sketch border /
              // shadow / paper background. Anchored under the ⋯ button so
              // it pops down and to the left.
              className="absolute top-full mt-1 right-0 z-20 w-44 rounded-md border border-line bg-white shadow-lg p-1 text-[12.5px] text-ink-800"
            >
              <button
                type="button"
                role="menuitem"
                onClick={onKillSession}
                disabled={sessionStatus === 'no_session'}
                className="w-full text-left px-2 py-1.5 rounded-sm hover:bg-canvas disabled:opacity-50 disabled:hover:bg-transparent disabled:cursor-not-allowed"
              >
                Kill session
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={onOpenEventsLog}
                className="w-full text-left px-2 py-1.5 rounded-sm hover:bg-canvas"
              >
                Open events log
              </button>
            </div>
          )}
        </div>

        <button
          type="button"
          aria-label="Close chat drawer"
          onClick={closeChat}
          className="selpill"
          style={{ height: 26, minWidth: 26, padding: '0 6px' }}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            aria-hidden="true"
          >
            <path d="m6 6 12 12M18 6 6 18" />
          </svg>
        </button>
      </header>

      {/* Tab strip — AC14. Three tabs in fixed order; selected tab gets
          paper-color background with ink border + `border-bottom-color:
          var(--paper)` so it visually connects to the pane below (the
          "connected pane" look from the wireframe). The unselected tabs
          have transparent borders so only the selected tab outlines. */}
      <div
        role="tablist"
        aria-label="Drawer view"
        className="flex items-end gap-1 px-3 pt-1.5 border-b border-line bg-canvas"
        style={{ marginBottom: 0 }}
      >
        <TabButton
          label="Chat"
          tabKey="chat"
          active={activeTab === 'chat'}
          onSelect={selectTab}
        />
        <TabButton
          label="Stats"
          tabKey="stats"
          active={activeTab === 'stats'}
          onSelect={selectTab}
        />
        <TabButton
          label="Files"
          tabKey="files"
          active={activeTab === 'files'}
          onSelect={selectTab}
        />
      </div>

      {/* Tab panels. Only the active panel is rendered (AC14 requires the
          active tab to drive the visible pane; the inactive tabpanels do
          not need to be in the DOM). */}
      {activeTab === 'chat' && (
        <div
          id="chat-drawer-panel-chat"
          role="tabpanel"
          aria-labelledby="chat-drawer-tab-chat"
          aria-label={
            isApiKeyMissing ? 'Chat — API key missing' : undefined
          }
          className="flex-1 overflow-auto"
        >
          {isApiKeyMissing ? (
            <ApiKeyMissingAlert />
          ) : sessionStatus === 'no_session' ? (
            <EmptyState
              slug={slug}
              starting={sessionState.kind === 'starting'}
              errorMessage={
                sessionState.kind === 'errored' ? sessionState.message : null
              }
              onStart={onStart}
            />
          ) : chatFeatureId ? (
            <ChatTab featureId={chatFeatureId} />
          ) : null}
        </div>
      )}
      {activeTab === 'stats' && (
        <div
          id="chat-drawer-panel-stats"
          role="tabpanel"
          aria-labelledby="chat-drawer-tab-stats"
          className="flex-1 overflow-auto"
        >
          {chatFeatureId ? (
            <StatsTab
              featureId={chatFeatureId}
              sessionStatus={sessionStatus}
            />
          ) : null}
        </div>
      )}
      {activeTab === 'files' && (
        <div
          id="chat-drawer-panel-files"
          role="tabpanel"
          aria-labelledby="chat-drawer-tab-files"
          className="flex-1 overflow-auto"
        >
          {chatFeatureId ? (
            <FilesTab
              featureId={chatFeatureId}
              sessionStatus={sessionStatus}
            />
          ) : null}
        </div>
      )}
    </aside>
  );
}

export default ChatDrawer;

function TabButton({
  label,
  tabKey,
  active,
  onSelect,
}: {
  label: string;
  tabKey: TabKey;
  active: boolean;
  onSelect: (tab: TabKey) => void;
}) {
  // AC14: selected tab has paper-color background with ink border and
  // `border-bottom-color: var(--paper)` so it visually merges with the
  // panel below. Unselected tabs use transparent borders. Inline styles
  // are used here for the exact CSS-variable bindings the wireframe
  // demands (paper / ink / canvas / line) — Tailwind tokens map only to
  // hex slate values, not the paper/ink palette. `mb-[-1px]` rides over
  // the parent's `border-b` so the connect-effect lands at the seam.
  return (
    <button
      type="button"
      role="tab"
      id={`chat-drawer-tab-${tabKey}`}
      aria-selected={active}
      aria-controls={`chat-drawer-panel-${tabKey}`}
      onClick={() => onSelect(tabKey)}
      className="h-7 px-3 text-[12.5px] font-medium"
      style={{
        background: active ? 'var(--paper, #ffffff)' : 'transparent',
        color: active ? 'var(--ink, #0F172A)' : 'var(--ink-soft, #475569)',
        border: '1px solid',
        borderColor: active ? 'var(--ink, #0F172A)' : 'transparent',
        borderBottomColor: active ? 'var(--paper, #ffffff)' : 'transparent',
        borderTopLeftRadius: 6,
        borderTopRightRadius: 6,
        marginBottom: -1,
      }}
    >
      {label}
    </button>
  );
}

function EmptyState({
  slug,
  starting,
  errorMessage,
  onStart,
}: {
  slug: string;
  starting: boolean;
  errorMessage: string | null;
  onStart: () => void;
}) {
  // AC15: centered `.empty` block with pencil glyph (aria-hidden), headline
  // `No session yet for <slug>.`, muted explanatory line, single primary
  // button **Start orchestrator** (`.btn.btn--primary`).
  return (
    <div className="h-full flex items-center justify-center p-6">
      <div
        className="empty text-center max-w-sm w-full"
        style={{
          border: '1px dashed #CBD5E1',
          borderRadius: 10,
          padding: '28px 20px',
          background: '#F9FAFB',
        }}
      >
        <div
          className="glyph serif"
          aria-hidden="true"
          style={{
            fontSize: 44,
            lineHeight: 1,
            color: '#94A3B8',
            marginBottom: 6,
          }}
        >
          ✎
        </div>
        <h3 className="text-[15px] font-semibold text-ink-900 mb-1">
          No session yet for{' '}
          <code className="mono text-[13px] text-ink-700">{slug}</code>.
        </h3>
        <p className="text-[12.5px] text-ink-500 leading-relaxed">
          Starting will send <code className="mono">/orchestrator</code> as
          the first prompt and stream the intake questions here.
        </p>
        <button
          type="button"
          onClick={onStart}
          disabled={starting}
          className="btn btn--primary mt-3 inline-flex items-center justify-center h-9 px-4 rounded-md bg-primary text-white text-[13px] font-medium disabled:opacity-60"
        >
          {starting ? 'Starting…' : 'Start orchestrator'}
        </button>
        <p className="text-[11.5px] text-ink-500 mt-3 mono">
          ⌘+Enter to send replies once the session begins.
        </p>
        {errorMessage ? (
          <p
            className="text-[12px] mt-3"
            style={{ color: '#B91C1C' }}
            role="status"
          >
            {errorMessage}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function ApiKeyMissingAlert() {
  // AC16: `.alert` with `role="alert"` (error-bg), title
  // `Set ANTHROPIC_API_KEY to start a chat`, three-command code block,
  // link to the canonical README anchor on GitHub (code-reviewer F5: the
  // prior `../../README.md#anthropic-api-key` relative href failed to
  // resolve from the `/` route since Next.js doesn't statically serve the
  // repo README). The Start button is intentionally absent per AC8.
  return (
    <div className="p-6">
      <div
        className="alert flex items-start gap-3 p-4"
        role="alert"
        style={{
          background: '#FEF2F2',
          border: '1px solid #FECACA',
          borderRadius: 8,
          color: '#7F1D1D',
        }}
      >
        <span
          aria-hidden="true"
          className="serif"
          style={{
            fontSize: 22,
            lineHeight: 1,
            color: '#B91C1C',
            fontWeight: 700,
          }}
        >
          !
        </span>
        <div className="flex-1 min-w-0">
          <h4 className="text-[14px] font-semibold mb-1">
            Set <code className="mono">ANTHROPIC_API_KEY</code> to start a chat
          </h4>
          <p className="text-[12.5px] leading-relaxed">
            The dashboard reads the key from your shell environment when
            launching an Agent SDK session.
          </p>
          <p className="text-[11.5px] mt-2" style={{ color: '#7F1D1D' }}>
            In your terminal:
          </p>
          <pre
            className="mono text-[12px] mt-1 p-2 overflow-auto"
            style={{
              background: '#fff',
              border: '1px solid #FECACA',
              borderRadius: 6,
              color: '#0F172A',
              whiteSpace: 'pre',
            }}
          >
{`export ANTHROPIC_API_KEY=sk-ant-…
cd dashboard
npm run dev`}
          </pre>
          <p className="text-[12.5px] mt-3">
            <a
              href={README_API_KEY_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
              style={{ color: '#B91C1C', textDecorationStyle: 'wavy' }}
            >
              Read the dashboard README → Setup section
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}
