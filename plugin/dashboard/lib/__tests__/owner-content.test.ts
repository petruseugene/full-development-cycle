import { describe, it, expect } from 'vitest';
import { parsePlanMd } from '../parsers';
import { bucketBoard, applyFilters, activeFilterCount, EMPTY_FILTERS } from '../board-filters';
import type { Feature, Task } from '../types';

const plan = (tag: string) => `- [TODO] **Task 1** (${tag}): Do thing\n`;

describe('parsePlanMd owner/content flags (AC32)', () => {
  it('(owner)', () => {
    const [t] = parsePlanMd(plan('owner'));
    expect(t).toMatchObject({ owner: true, content: false, tag: 'mixed', stackless: true });
  });
  it('(backend, owner)', () => {
    const [t] = parsePlanMd(plan('backend, owner'));
    expect(t).toMatchObject({ owner: true, tag: 'backend', stackless: false });
  });
  it('(backend, content)', () => {
    const [t] = parsePlanMd(plan('backend, content'));
    expect(t).toMatchObject({ content: true, owner: false, tag: 'backend' });
  });
  it('(frontend)', () => {
    const [t] = parsePlanMd(plan('frontend'));
    expect(t).toMatchObject({ owner: false, content: false, tag: 'frontend' });
  });
  it('exact token match', () => {
    const [t] = parsePlanMd(plan('contentful, ownership'));
    expect(t).toMatchObject({ owner: false, content: false });
  });
  it('reads **Tag:** in details', () => {
    const raw = `- [TODO] **Task 1**: X\n\n### Task 1: X\n\n**Tag:** backend, owner\n**Files:** a.ts\n`;
    const [t] = parsePlanMd(raw);
    expect(t).toMatchObject({ owner: true, tag: 'backend' });
  });
  it.each(['(owner)', 'owner:', '`owner`', '[owner]', '**owner**'])('strips decoration in **Tag:** %s', (tag) => {
    const raw = `- [TODO] **Task 1**: X\n\n### Task 1: X\n\n**Tag:** ${tag}\n`;
    const [t] = parsePlanMd(raw);
    expect(t.owner).toBe(true);
  });
  it('(owner) in list line with stack still owner', () => {
    const [t] = parsePlanMd(plan('backend, (owner)'));
    expect(t).toMatchObject({ owner: true, tag: 'backend' });
  });
});

const mk = (id: string, status: Task['status'], owner = false, content = false): Task => ({
  id, index: 1, title: id, tag: 'mixed', owner, content, status,
});
const feature = (tasks: Task[]): Feature =>
  ({ id: 'f', slug: 'f', title: 'F', tasks, reviews: [], meta: null, updatedAt: '' }) as unknown as Feature;

describe('bucketBoard status (AC33)', () => {
  it('has 6 ordered columns incl. empty waiting column', () => {
    const cols = bucketBoard([feature([])], 'status');
    expect(cols.map((c) => c.label)).toEqual([
      'To do', 'In progress', 'Testing', 'Blocked', 'Waiting for owner', 'Merged',
    ]);
  });
  it('routes owner tasks', () => {
    const cols = bucketBoard([feature([mk('a', 'TODO', true), mk('b', 'DONE', true)])], 'status');
    const by = Object.fromEntries(cols.map((c) => [c.key, c.items.map((i) => i.task.id)]));
    expect(by.WAITING_OWNER).toEqual(['a']);
    expect(by.TODO).toEqual([]);
    expect(by.DONE).toEqual(['b']);
  });
});

describe('flag filter (AC35)', () => {
  const f = [feature([mk('a', 'TODO', true), mk('b', 'TODO', false, true), mk('c', 'TODO')])];
  it('owner keeps only owner tasks', () => {
    const out = applyFilters(f, { ...EMPTY_FILTERS, flags: ['owner'] });
    expect(out[0].tasks.map((t) => t.id)).toEqual(['a']);
  });
  it('counts flags', () => {
    expect(activeFilterCount({ ...EMPTY_FILTERS, flags: ['owner', 'content'] })).toBe(2);
  });
});
