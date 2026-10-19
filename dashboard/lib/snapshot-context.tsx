'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { DashboardSnapshot } from '@/lib/types';

export interface SnapshotContextValue {
  snapshot: DashboardSnapshot | null;
  setSnapshot: (snapshot: DashboardSnapshot | null) => void;
  activeFeatureId: string | null;
  setActiveFeatureId: (id: string | null | ((prev: string | null) => string | null)) => void;
  // Chat drawer (Task 10, spec R21 / R22). The drawer lives in `ShellLayout`
  // so the Sidebar (also in ShellLayout) and the Board page (rendered as
  // children) can both trigger / observe it via a single ambient store.
  // `chatClosedAt` is the timestamp of the most recent close — Board task
  // cards consult it to enforce the 200ms close-grace described in R22.
  chatDrawerOpen: boolean;
  chatFeatureId: string | null;
  openChat: (featureId: string) => void;
  closeChat: () => void;
  chatClosedAt: number;
  // False when the server resolved the agent as disabled (DASHBOARD_AGENT).
  agentEnabled: boolean;
}

const SnapshotContext = createContext<SnapshotContextValue | null>(null);

export function SnapshotProvider({
  value,
  children,
}: {
  value: SnapshotContextValue;
  children: ReactNode;
}) {
  return <SnapshotContext.Provider value={value}>{children}</SnapshotContext.Provider>;
}

export function useSnapshot(): SnapshotContextValue {
  const ctx = useContext(SnapshotContext);
  if (ctx === null) {
    throw new Error('useSnapshot must be used within a SnapshotProvider');
  }
  return ctx;
}
