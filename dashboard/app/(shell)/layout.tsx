'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { DashboardSnapshot, Feature, PinnedChangedEvent } from '@/lib/types';
import { TopBar } from '@/components/TopBar';
import { Sidebar } from '@/components/Sidebar';
import { CommandPalette } from '@/components/CommandPalette';
import { NewFeatureModal } from '@/components/NewFeatureModal';
import { ChatDrawer } from '@/components/ChatDrawer';
import { SnapshotProvider } from '@/lib/snapshot-context';
import { pinFeature, readPins, subscribePins, unpinFeature, writePins } from '@/lib/local-pins';

type PaletteMode = 'search' | 'pin' | null;

export default function ShellLayout({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [activeFeatureId, setActiveFeatureId] = useState<string | null>(null);
  const [paletteMode, setPaletteMode] = useState<PaletteMode>(null);
  const [newFeatureOpen, setNewFeatureOpen] = useState(false);
  const [pinnedSlugs, setPinnedSlugs] = useState<string[]>([]);
  // Chat drawer ambient state (Task 10 / spec R21–R22). Owned here so the
  // Sidebar's pinned-feature click handler — which lives in ShellLayout —
  // can open the drawer alongside the Board page's per-card `Chat` button.
  const [chatDrawerOpen, setChatDrawerOpen] = useState(false);
  const [chatFeatureId, setChatFeatureId] = useState<string | null>(null);
  // Timestamp of the last close. Board's task-card click handler reads this
  // via `useSnapshot().chatClosedAt` and ignores clicks within 200ms — the
  // close grace required by R22 so dismissing the drawer doesn't open the
  // task modal as a side-effect.
  const [chatClosedAt, setChatClosedAt] = useState(0);
  // Per-tab UUID for the self-echo guard on SSE pinned-changed events.
  // Minted inside a mount-only effect so `crypto` is never touched during SSR.
  const originRef = useRef<string>('');

  const paletteOpen = paletteMode !== null;

  // Mount-only: mint per-tab origin UUID, hydrate pinned slugs from
  // localStorage, and subscribe to native `storage` events so sibling tabs
  // in the same browser update without waiting for the SSE round-trip.
  useEffect(() => {
    if (!originRef.current) {
      originRef.current = crypto.randomUUID();
    }
    setPinnedSlugs(readPins());
    const unsubscribe = subscribePins((slugs) => setPinnedSlugs(slugs));
    return unsubscribe;
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/features', { cache: 'no-store' });
      if (!res.ok) return;
      const data = (await res.json()) as DashboardSnapshot;
      setSnapshot(data);
    } catch {
      // network blip — try again on next event
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Subscribe to SSE for filesystem changes + cross-client pin broadcasts.
  useEffect(() => {
    const es = new EventSource('/api/events');
    let pending: ReturnType<typeof setTimeout> | null = null;
    const debounced = () => {
      if (pending) clearTimeout(pending);
      pending = setTimeout(() => refresh(), 250);
    };
    const onPinnedChanged = (event: MessageEvent) => {
      let data: PinnedChangedEvent;
      try {
        data = JSON.parse(event.data) as PinnedChangedEvent;
      } catch {
        return;
      }
      // Self-echo guard (AC7 / R12): ignore events this tab caused.
      if (data.origin === originRef.current) return;
      writePins(data.slugs);
      setPinnedSlugs(data.slugs);
    };
    es.addEventListener('change', debounced);
    es.addEventListener('hello', () => {});
    es.addEventListener('pinned-changed', onPinnedChanged as EventListener);
    es.onerror = () => {
      // EventSource auto-reconnects; ignore.
    };
    return () => {
      es.removeEventListener('pinned-changed', onPinnedChanged as EventListener);
      es.close();
      if (pending) clearTimeout(pending);
    };
  }, [refresh]);

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteMode('search');
        return;
      }
      if (e.key === 'Escape') {
        setPaletteMode(null);
        return;
      }
      // `N` opens the New-feature modal when nothing else is in the way.
      if ((e.key === 'n' || e.key === 'N') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (paletteOpen || newFeatureOpen) return;
        const el = document.activeElement as HTMLElement | null;
        const tag = el?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable) return;
        e.preventDefault();
        setNewFeatureOpen(true);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [paletteOpen, newFeatureOpen]);

  const features = snapshot?.features ?? [];

  const postPinChange = useCallback(
    (action: 'pin' | 'unpin', slug: string, slugs: string[]) => {
      void fetch('/api/pins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, slug, origin: originRef.current, slugs }),
      }).catch((err) => {
        // Optimistic UI per spec §5 / R6: log on failure, do not roll back.
        // eslint-disable-next-line no-console
        console.error('POST /api/pins failed', err);
      });
    },
    [],
  );

  const handlePickFeatureToPin = useCallback(
    (feature: Feature) => {
      const next = pinFeature(feature.slug);
      setPinnedSlugs(next);
      postPinChange('pin', feature.slug, next);
      setPaletteMode(null);
    },
    [postPinChange],
  );

  const handleUnpin = useCallback(
    (slug: string) => {
      const next = unpinFeature(slug);
      setPinnedSlugs(next);
      postPinChange('unpin', slug, next);
    },
    [postPinChange],
  );

  const openChat = useCallback((featureId: string) => {
    setChatFeatureId(featureId);
    setChatDrawerOpen(true);
  }, []);

  const closeChat = useCallback(() => {
    setChatDrawerOpen(false);
    setChatClosedAt(Date.now());
  }, []);

  // Sidebar pinned-feature click (Task 10 step 4). Looking up the feature by
  // slug here keeps the Sidebar API stable — it still receives `onSelect(id)`
  // (used to scope the Board) and we layer the chat-open as a side-effect.
  const handleSelectFromSidebar = useCallback(
    (id: string) => {
      setActiveFeatureId((prev) => (prev === id ? null : id));
      openChat(id);
    },
    [openChat],
  );

  return (
    <SnapshotProvider
      value={{
        snapshot,
        setSnapshot,
        activeFeatureId,
        setActiveFeatureId,
        chatDrawerOpen,
        chatFeatureId,
        openChat,
        closeChat,
        chatClosedAt,
      }}
    >
      <TopBar onSearch={() => setPaletteMode('search')} onNew={() => setNewFeatureOpen(true)} />
      <div className="flex">
        <Sidebar
          features={features}
          activeId={activeFeatureId}
          onSelect={handleSelectFromSidebar}
          onSelectAll={() => setActiveFeatureId(null)}
          pinnedSlugs={pinnedSlugs}
          onOpenPinPicker={() => setPaletteMode('pin')}
          onUnpin={handleUnpin}
        />
        <main className="flex-1 min-w-0">{children}</main>
      </div>

      <ChatDrawer />

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteMode(null)}
        features={features}
        mode={paletteMode ?? 'search'}
        pinnedSlugs={pinnedSlugs}
        onPickFeatureToPin={handlePickFeatureToPin}
        onPickTask={() => {
          // Task drawer lives on the Board route; closing the palette is
          // sufficient here. Board-route palette-to-drawer wiring is preserved
          // by the Board page's own state (see (shell)/page.tsx).
          setPaletteMode(null);
        }}
        onPickNewFeature={() => {
          setPaletteMode(null);
          setNewFeatureOpen(true);
        }}
      />
      <NewFeatureModal open={newFeatureOpen} onClose={() => setNewFeatureOpen(false)} />
    </SnapshotProvider>
  );
}
