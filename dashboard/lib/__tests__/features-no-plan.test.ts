import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadFeatures } from '../features';

let dir: string;
const prev = process.env.DASHBOARD_FEATURES_DIR;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'feat-'));
  const lite = path.join(dir, '2026-01-01-00h-00m-lite');
  mkdirSync(lite);
  writeFileSync(path.join(lite, 'feature.json'), JSON.stringify({ feature_slug: 'lite', flow: 'feature', track: 'lite', history: [{ model: 'opus' }] }));
  writeFileSync(path.join(lite, 'spec.md'), '---\nstatus: [TODO]\n---\n# Spec');
  const quick = path.join(dir, '2026-01-02-00h-00m-quick');
  mkdirSync(quick);
  writeFileSync(path.join(quick, 'feature.json'), JSON.stringify({ feature_slug: 'quick', flow: 'feature', track: 'quick' }));
  const bare = path.join(dir, '2026-01-03-00h-00m-bare');
  mkdirSync(bare);
  process.env.DASHBOARD_FEATURES_DIR = dir;
});

afterAll(() => {
  if (prev === undefined) delete process.env.DASHBOARD_FEATURES_DIR;
  else process.env.DASHBOARD_FEATURES_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});

describe('loadFeatures without plan.md / spec.md', () => {
  it('lite: no plan.md -> tasks [], hasPlan false, progress 0/0, specStatus TODO', async () => {
    const f = (await loadFeatures()).find((x) => x.slug.endsWith('-lite'))!;
    expect(f.tasks).toEqual([]);
    expect(f.hasPlan).toBe(false);
    expect(f.derived.progress).toEqual({ done: 0, total: 0 });
    expect(f.hasSpec).toBe(true);
    expect(f.specStatus).toBe('TODO');
    expect(f.meta?.track).toBe('lite');
  });
  it('quick: no spec.md -> hasSpec false, specStatus null, meta without history', async () => {
    const f = (await loadFeatures()).find((x) => x.slug.endsWith('-quick'))!;
    expect(f.hasSpec).toBe(false);
    expect(f.specStatus).toBeNull();
    expect(f.hasPlan).toBe(false);
  });
  it('folder with no files does not throw', async () => {
    const f = (await loadFeatures()).find((x) => x.slug.endsWith('-bare'))!;
    expect(f.meta).toBeNull();
    expect(f.derived.progress).toEqual({ done: 0, total: 0 });
  });
});
