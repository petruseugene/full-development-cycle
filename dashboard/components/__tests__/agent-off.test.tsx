import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { ReactNode } from 'react';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: Array<() => void> = [];
function render(ui: ReactNode) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => root.render(ui));
  mounted.push(() => {
    act(() => root.unmount());
    el.remove();
  });
}
async function renderAsync(ui: ReactNode) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => root.render(ui));
  mounted.push(() => { act(() => root.unmount()); el.remove(); });
}
const buttons = () => Array.from(document.querySelectorAll('button'));
const byName = (re: RegExp | string) =>
  buttons().filter((b) => {
    const n = (b.getAttribute('aria-label') ?? b.textContent ?? '').trim();
    return typeof re === 'string' ? n === re : re.test(n);
  });
const click = (el: Element) => act(() => { (el as HTMLElement).click(); });
import type { Feature, Task } from '@/lib/types';

vi.mock('next/navigation', () => ({ usePathname: () => '/' }));
vi.mock('@/components/ChatDrawer', () => ({
  ChatDrawer: () => <div role="dialog" aria-label="Chat drawer" />,
}));
vi.mock('@/components/PendingApprovalsPill', () => ({
  default: () => <div data-testid="approvals-pill" />,
}));
vi.mock('@/components/OrchestratorPill', () => ({ default: () => null }));
vi.mock('@/components/CommandPalette', () => ({ CommandPalette: () => null }));
vi.mock('@/components/NewFeatureModal', () => ({ NewFeatureModal: () => null }));
vi.mock('@/components/KPIStrip', () => ({ KPIStrip: () => null }));
vi.mock('@/components/Toolbar', () => ({ Toolbar: () => null }));
vi.mock('@/components/LiveTicker', () => ({ LiveTicker: () => null }));
vi.mock('@/components/QuickAddTaskModal', () => ({ QuickAddTaskModal: () => null }));
vi.mock('@/components/TaskCard', () => ({ TaskCard: () => null }));
vi.mock('@/lib/local-pins', () => ({
  pinFeature: vi.fn(() => []),
  unpinFeature: vi.fn(() => []),
  readPins: () => ['feat-a'],
  writePins: vi.fn(),
  subscribePins: () => () => {},
}));
// Sidebar stub: exposes a pin button that fires onSelect.
vi.mock('@/components/Sidebar', () => ({
  Sidebar: ({ onSelect }: { onSelect: (id: string) => void }) => (
    <button data-testid="pin" onClick={() => onSelect('feat-a')}>
      pin
    </button>
  ),
}));

import { ShellClient } from '@/components/ShellClient';
import { TopBar } from '@/components/TopBar';
import { Board } from '@/components/Board';
import { TaskModal } from '@/components/TaskModal';
import { SnapshotProvider, useSnapshot, type SnapshotContextValue } from '@/lib/snapshot-context';
import BoardPage from '@/app/(shell)/page';

const task = {
  id: 't1', index: 1, title: 'T', tag: 'mixed', owner: false, content: false, status: 'TODO',
} as unknown as Task;
const feature = {
  id: 'feat-a', slug: 'feat-a', title: 'Feat A', folderPath: '/x', meta: null,
  tasks: [task], reviews: [], testReport: null, hasPlan: true, hasSpec: true,
  derived: { overallStatus: 'TODO', progress: { done: 0, total: 1 }, activeAgents: [] },
} as unknown as Feature;

const ctx = (agentEnabled: boolean): SnapshotContextValue => ({
  snapshot: null, setSnapshot: () => {}, activeFeatureId: null, setActiveFeatureId: () => {},
  chatDrawerOpen: false, chatFeatureId: null, openChat: () => {}, closeChat: () => {},
  chatClosedAt: 0, agentEnabled,
});
const wrap = (enabled: boolean, ui: ReactNode) => (
  <SnapshotProvider value={ctx(enabled)}>{ui}</SnapshotProvider>
);

const urls: string[] = [];
let ctxProbe: SnapshotContextValue | null = null;
function Probe() {
  ctxProbe = useSnapshot();
  return null;
}

beforeEach(() => {
  urls.length = 0;
  ctxProbe = null;
  vi.stubGlobal('fetch', vi.fn(async (u: unknown) => {
    urls.push(String(u));
    return new Response(JSON.stringify({ features: [feature], kpis: {}, ticker: [] }), { status: 200 });
  }));
  class ES {
    constructor(u: string) { urls.push(String(u)); }
    addEventListener() {}
    removeEventListener() {}
    close() {}
    onerror: unknown = null;
  }
  vi.stubGlobal('EventSource', ES);
});
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  vi.unstubAllGlobals();
  window.history.pushState({}, '', '/');
});

const agentUrls = () => urls.filter((u) => u.includes('/api/agent'));

describe('agent disabled (AC8)', () => {
  it('shell: no chat drawer, pill or Chat buttons; openChat/pin/deep-link are no-ops', async () => {
    window.history.pushState({}, '', '/?feature=feat-a&chat=1');
    await renderAsync(
      <ShellClient agent={{ enabled: false, mode: 'off', reason: 'off-by-config' }}>
        <Probe />
        <BoardPage />
      </ShellClient>,
    );
    expect(document.querySelector('[role=dialog]')).toBeNull();
    expect(document.querySelector('[data-testid=approvals-pill]')).toBeNull();
    expect(byName(/chat/i)).toHaveLength(0);
    expect(ctxProbe!.agentEnabled).toBe(false);
    act(() => ctxProbe!.openChat('x'));
    click(document.querySelector('[data-testid=pin]')!);
    expect(ctxProbe!.chatDrawerOpen).toBe(false);
    expect(document.querySelector('[role=dialog]')).toBeNull();
    expect(agentUrls()).toEqual([]);
  });

  it('TopBar, Board header and TaskModal footer hide chat UI', () => {
    render(
      wrap(
        false,
        <>
          <TopBar onSearch={() => {}} onNew={() => {}} />
          <Board features={[feature]} groupKey="feature" sortKey="recent" onOpenTask={() => {}} />
          <TaskModal open task={task} feature={feature} onClose={() => {}} />
        </>,
      ),
    );
    expect(document.querySelector('[data-testid=approvals-pill]')).toBeNull();
    expect(byName(/chat/i)).toHaveLength(0);
    expect(byName('Open chat')).toHaveLength(0);
    expect(agentUrls()).toEqual([]);
  });
});

describe('agent enabled (AC9)', () => {
  it('renders pill, Chat button and Open chat', () => {
    render(
      wrap(
        true,
        <>
          <TopBar onSearch={() => {}} onNew={() => {}} />
          <Board features={[feature]} groupKey="feature" sortKey="recent" onOpenTask={() => {}} />
          <TaskModal open task={task} feature={feature} onClose={() => {}} />
        </>,
      ),
    );
    expect(document.querySelector('[data-testid=approvals-pill]')).not.toBeNull();
    expect(byName(/^Open chat for Feat A$/)).toHaveLength(1);
    expect(byName('Open chat')).toHaveLength(1);
  });

  it('shell mounts the ChatDrawer', async () => {
    await renderAsync(
      <ShellClient agent={{ enabled: true, mode: 'on', reason: 'forced-on' }}>
        <div />
      </ShellClient>,
    );
    expect(document.querySelector('[role=dialog]')).not.toBeNull();
  });
});
