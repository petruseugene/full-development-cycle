'use client';

import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Feature, Task } from '@/lib/types';
import { KPIStrip } from '@/components/KPIStrip';
import { Toolbar, type OpenPopover } from '@/components/Toolbar';
import { ModelSpendPanel } from '@/components/ModelSpendPanel';
import { BriefStatusPanel } from '@/components/BriefStatusPanel';
import { Board } from '@/components/Board';
import { LiveTicker } from '@/components/LiveTicker';
import { TaskModal } from '@/components/TaskModal';
import { QuickAddTaskModal } from '@/components/QuickAddTaskModal';
import {
  applyFilters,
  EMPTY_FILTERS,
  type Filters,
  type GroupKey,
  type SortKey,
} from '@/lib/board-filters';
import { useSnapshot } from '@/lib/snapshot-context';
import { buildKPIs } from '@/lib/kpis';
import { featuresInScope } from '@/lib/board-filters';

// Close-grace window (ms) — R22. Card clicks landing inside this window
// after the chat drawer closes are treated as "click-outside to dismiss"
// and don't open the TaskModal.
const CLOSE_GRACE_MS = 200;

export default function BoardPage() {
  const { snapshot, activeFeatureId, openChat, chatClosedAt, agentEnabled } = useSnapshot();

  // `activeFeatureId` is owned by the shell layout via SnapshotContext so the
  // Sidebar's pinned-feature clicks can drive the Board's scope.
  const activeId = activeFeatureId;
  const [taskModalTask, setTaskModalTask] = useState<{ task: Task; feature: Feature } | null>(
    null,
  );
  const [taskModalOpen, setTaskModalOpen] = useState(false);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [groupKey, setGroupKey] = useState<GroupKey>('status');
  const [sortKey, setSortKey] = useState<SortKey>('recent');
  const [openPopover, setOpenPopover] = useState<OpenPopover>(null);

  const features = snapshot?.features ?? [];
  const baseBoardFeatures = useMemo(() => {
    const scoped = activeId ? features.filter((f) => f.id === activeId) : features;
    return scoped.length ? scoped : features;
  }, [features, activeId]);

  const boardFeatures = useMemo(
    () => applyFilters(baseBoardFeatures, filters),
    [baseBoardFeatures, filters],
  );

  // KPIs follow the board: same feature set the active filters leave visible.
  // Server-side budget / rate (env-configured) ride along in the snapshot.
  const scopedKpis = useMemo(() => {
    if (!snapshot) return null;
    return buildKPIs(featuresInScope(boardFeatures, filters), {
      budget: snapshot.kpis?.agentSpend?.budget,
      costPerKtok: snapshot.kpis?.agentSpend?.costPerKtok,
    });
  }, [snapshot, boardFeatures, filters]);

  const openTask = (task: Task, feature: Feature) => {
    // R22 close grace: when the chat drawer was just dismissed by a click
    // landing on a task card, suppress the modal-open so the drawer-close
    // and the modal-open don't visually collide. The ChatDrawer sets
    // `chatClosedAt` inside its onMouseDown outside-click listener — so by
    // the time the click handler fires here, the timestamp is already
    // updated and reflects "just now".
    if (chatClosedAt && Date.now() - chatClosedAt < CLOSE_GRACE_MS) return;
    setTaskModalTask({ task, feature });
    setTaskModalOpen(true);
  };

  // Deep-link: ?feature=<id-or-slug>&chat=1 opens the drawer on mount per
  // R22(c). Runs once after the snapshot hydrates so the slug→id lookup
  // can resolve. Subsequent URL changes are not re-applied — the user can
  // navigate normally without the drawer reopening every render.
  const deepLinkApplied = useRef(false);
  useEffect(() => {
    if (deepLinkApplied.current) return;
    if (!agentEnabled) {
      deepLinkApplied.current = true;
      return;
    }
    if (typeof window === 'undefined') return;
    if (!snapshot) return;
    const params = new URLSearchParams(window.location.search);
    const featureParam = params.get('feature');
    const chatParam = params.get('chat');
    if (!featureParam || chatParam !== '1') {
      deepLinkApplied.current = true;
      return;
    }
    const target =
      features.find((f) => f.id === featureParam) ??
      features.find((f) => f.slug === featureParam) ??
      null;
    if (target) openChat(target.id);
    deepLinkApplied.current = true;
  }, [snapshot, features, openChat, agentEnabled]);

  // Quick-add task modal (Feature D) lifted to page level so both the
  // Toolbar primary button and Board column-header trigger share one modal.
  const [modalOpen, setModalOpen] = useState(false);
  const [modalFeatureId, setModalFeatureId] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const selectedFeatureId =
    activeId ?? (filters.featureIds.length === 1 ? filters.featureIds[0] : null);
  const selectedFeature = selectedFeatureId
    ? features.find((f) => f.id === selectedFeatureId) ?? null
    : null;
  const modalFeature =
    modalFeatureId != null ? features.find((f) => f.id === modalFeatureId) ?? null : null;

  const openAddTaskModal = (featureId: string, trigger: HTMLButtonElement | null) => {
    triggerRef.current = trigger;
    setModalFeatureId(featureId);
    setModalOpen(true);
  };
  const closeAddTaskModal = () => {
    setModalOpen(false);
    setModalFeatureId(null);
    const trigger = triggerRef.current;
    if (trigger) setTimeout(() => trigger.focus(), 0);
  };

  return (
    <>
      {scopedKpis && <KPIStrip kpis={scopedKpis} />}
      <Toolbar
        syncedAt={snapshot?.generatedAt ?? null}
        filters={filters}
        onFiltersChange={setFilters}
        features={baseBoardFeatures}
        groupKey={groupKey}
        onGroupKeyChange={setGroupKey}
        sortKey={sortKey}
        onSortKeyChange={setSortKey}
        openPopover={openPopover}
        onOpenPopoverChange={setOpenPopover}
        selectedFeature={
          selectedFeature ? { id: selectedFeature.id, title: selectedFeature.title } : null
        }
        onAddTaskClick={
          selectedFeature
            ? (e?: React.MouseEvent<HTMLButtonElement>) =>
                openAddTaskModal(
                  selectedFeature.id,
                  (e?.currentTarget ?? null) as HTMLButtonElement | null,
                )
            : undefined
        }
      />
      {selectedFeature ? <ModelSpendPanel feature={selectedFeature} /> : null}
      {selectedFeature && selectedFeature.hasPlan === false ? (
        <BriefStatusPanel feature={selectedFeature} />
      ) : null}
      <Board
        features={boardFeatures}
        groupKey={groupKey}
        sortKey={sortKey}
        onOpenTask={openTask}
        onAddTask={openAddTaskModal}
      />
      <LiveTicker events={snapshot?.ticker ?? []} />

      <TaskModal
        open={taskModalOpen}
        task={taskModalTask?.task ?? null}
        feature={taskModalTask?.feature ?? null}
        onClose={() => setTaskModalOpen(false)}
      />

      {modalFeature ? (
        <QuickAddTaskModal
          open={modalOpen}
          onClose={closeAddTaskModal}
          featureId={modalFeature.id}
          featureSlug={modalFeature.slug}
          featureTitle={modalFeature.title}
          currentPhase={modalFeature.meta?.current_phase ?? null}
        />
      ) : null}
    </>
  );
}
