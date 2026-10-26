import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import type { Feature, FeatureJson } from '@/lib/types';

let snap: { features: Feature[] } | null = null;
vi.mock('next/navigation', () => ({ usePathname: () => '/bugfixes' }));
vi.mock('@/lib/snapshot-context', () => ({
  useSnapshot: () => ({ activeFeatureId: null, snapshot: snap, agentEnabled: true }),
}));

import { isBugfixRow, polishItemCount } from '@/lib/bugfixes';
import BugfixesPage from '@/app/(shell)/bugfixes/page';
import { Sidebar } from '@/components/Sidebar';

const meta = (o: Partial<FeatureJson>) => o as FeatureJson;
const task = (n: number) => ({ id: `T${n}`, index: n, title: `i${n}`, status: 'TODO' }) as Feature['tasks'][number];
const feat = (slug: string, m: Partial<FeatureJson>, n = 0): Feature =>
  ({
    id: slug, slug, title: slug, folderPath: '/x', meta: meta(m),
    tasks: Array.from({ length: n }, (_, i) => task(i + 1)),
    derived: { overallStatus: 'TODO', progress: { done: 0, total: n }, activeAgents: [] },
  }) as unknown as Feature;

describe('AC25 isBugfixRow / polishItemCount', () => {
  it('classifies rows', () => {
    expect(isBugfixRow({ flow: 'bugfix' })).toBe(true);
    expect(isBugfixRow({ flow: 'feature', track: 'polish' })).toBe(true);
    expect(isBugfixRow({ flow: 'feature', track: 'lite' })).toBe(false);
    expect(isBugfixRow({ flow: 'hotfix' })).toBe(false);
    expect(isBugfixRow(null)).toBe(false);
  });
  it('counts polish items only for polish', () => {
    expect(polishItemCount(feat('p', { flow: 'feature', track: 'polish' }, 3))).toBe(3);
    expect(polishItemCount(feat('l', { flow: 'feature', track: 'lite' }, 3))).toBeNull();
    expect(polishItemCount(feat('b', { flow: 'bugfix' }, 2))).toBeNull();
  });
});

describe('AC26 page and sidebar', () => {
  const features = [
    feat('fix', { flow: 'bugfix' }),
    feat('pol', { flow: 'feature', track: 'polish' }, 3),
    feat('lite', { flow: 'feature', track: 'lite' }, 2),
  ];
  it('page shows 2 rows and a 3 items chip', () => {
    snap = { features };
    const html = renderToStaticMarkup(React.createElement(BugfixesPage));
    expect(html).toMatch(/text-ink-500">2</);
    expect(html).toContain('3 items');
    expect(html).not.toContain('lite');
  });
  it('singular chip for one item', () => {
    snap = { features: [feat('one', { flow: 'feature', track: 'polish' }, 1)] };
    const html = renderToStaticMarkup(React.createElement(BugfixesPage));
    expect(html).toContain('1 item<');
    expect(html).not.toContain('1 items');
  });
  it('sidebar counter is 2', () => {
    snap = { features };
    const html = renderToStaticMarkup(
      React.createElement(Sidebar, { features, activeId: null, onSelect() {}, onSelectAll() {} }),
    );
    expect(html).toMatch(/Bugfixes <span class="nav-count">2</);
  });
});
