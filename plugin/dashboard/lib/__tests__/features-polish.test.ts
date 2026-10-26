import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadFeatures } from '../features';

let dir: string;
const prev = process.env.DASHBOARD_FEATURES_DIR;
const POLISH = '---\nstatus: [TODO]\n---\n# Polish\n\n- [TODO] **Task 1** (frontend): Home title\n- [DONE] **Task 2** (frontend): Settings colour\n';
const PLAN = '---\nstatus: [TODO]\n---\n# Plan\n\n- [TODO] **Task 1** (backend): From plan\n';

function mk(slug: string, files: Record<string, string>) {
  const d = path.join(dir, slug);
  mkdirSync(d);
  writeFileSync(path.join(d, 'feature.json'), JSON.stringify({ feature_slug: slug, flow: 'feature', track: 'polish' }));
  for (const [n, c] of Object.entries(files)) writeFileSync(path.join(d, n), c);
}

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'feat-polish-'));
  mk('2026-01-01-00h-00m-pol', { 'polish.md': POLISH });
  mk('2026-01-02-00h-00m-both', { 'polish.md': POLISH, 'plan.md': PLAN });
  process.env.DASHBOARD_FEATURES_DIR = dir;
});
afterAll(() => {
  if (prev === undefined) delete process.env.DASHBOARD_FEATURES_DIR;
  else process.env.DASHBOARD_FEATURES_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});

describe('AC27 polish.md task source', () => {
  it('reads polish.md when it is the only source', async () => {
    const f = (await loadFeatures()).find((x) => x.slug.endsWith('-pol'))!;
    expect(f.hasPlan).toBe(true);
    expect(f.tasks.map((t) => t.id)).toEqual(['T1', 'T2']);
  });
  it('plan.md still wins', async () => {
    const f = (await loadFeatures()).find((x) => x.slug.endsWith('-both'))!;
    expect(f.tasks.map((t) => t.title)).toEqual(['From plan']);
  });
});
