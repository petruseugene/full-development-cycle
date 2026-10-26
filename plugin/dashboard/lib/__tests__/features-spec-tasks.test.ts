import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadFeatures } from '../features';
import { POST } from '../../app/api/features/[id]/tasks/route';

let dir: string;
const prev = process.env.DASHBOARD_FEATURES_DIR;
const SPEC = '---\nstatus: [TODO]\n---\n# Spec\n\n## Tasks\n\n- [TODO] **Task 1** (backend): First\n- [DONE] **Task 2** (frontend): Second\n';

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'feat-'));
  const a = path.join(dir, '2026-01-01-00h-00m-specy');
  mkdirSync(a);
  writeFileSync(path.join(a, 'feature.json'), JSON.stringify({ feature_slug: 'specy', flow: 'feature' }));
  writeFileSync(path.join(a, 'spec.md'), SPEC);
  const b = path.join(dir, '2026-01-02-00h-00m-neither');
  mkdirSync(b);
  writeFileSync(path.join(b, 'feature.json'), JSON.stringify({ feature_slug: 'neither', flow: 'feature' }));
  process.env.DASHBOARD_FEATURES_DIR = dir;
});

afterAll(() => {
  if (prev === undefined) delete process.env.DASHBOARD_FEATURES_DIR;
  else process.env.DASHBOARD_FEATURES_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});

const post = (id: string) =>
  POST(
    new Request('http://x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Added', tag: 'frontend' }) }),
    { params: { id } },
  );

describe('AC39 spec.md ## Tasks fallback', () => {
  it('shows spec tasks with hasPlan true', async () => {
    const f = (await loadFeatures()).find((x) => x.slug.endsWith('-specy'))!;
    expect(f.hasPlan).toBe(true);
    expect(f.tasks.map((t) => t.id)).toEqual(['T1', 'T2']);
  });
  it('quick-add appends to spec.md', async () => {
    const res = await post('2026-01-01-00h-00m-specy');
    expect(res.status).toBe(200);
    const txt = readFileSync(path.join(dir, '2026-01-01-00h-00m-specy', 'spec.md'), 'utf8');
    expect(txt).toContain('- [TODO] **Task 3** (frontend): Added');
  });
  it('neither file -> empty state and 404', async () => {
    const f = (await loadFeatures()).find((x) => x.slug.endsWith('-neither'))!;
    expect(f.hasPlan).toBe(false);
    expect(f.tasks).toEqual([]);
    expect((await post('2026-01-02-00h-00m-neither')).status).toBe(404);
  });
});
