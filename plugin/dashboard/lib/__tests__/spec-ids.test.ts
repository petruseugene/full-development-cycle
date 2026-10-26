import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { parseSpecIds, parseAcceptanceRef, collectIds } from '../spec-ids';
import { AcceptanceList } from '../../components/TaskModal';

const SAMPLE = `## 4. Requirements
- R1: \`core.mjs\` gains \`mainWorktreeRoot(root)\`. Read synchronously:
  \`.git\` file then \`gitdir:\`.
- R2: **second** requirement.
- **R3**: bold id form.
- **R4** — dash form.
- R5 (area): with area.
- R6. dot form.

## 6. Acceptance
- [ ] AC1: first criterion with \`code\`.
- [x] AC2 (server-gate): second, done.
- [ ] **AC3** — bold dash.
- [ ] AC4 text without a separator is not a definition
- Not an id line, mentions R1 inline.
`;

describe('parseSpecIds', () => {
  const ids = parseSpecIds(SAMPLE);
  it('parses bullet, bold, dash, dot and area forms', () => {
    expect(ids.R1.text).toBe('`core.mjs` gains `mainWorktreeRoot(root)`. Read synchronously: `.git` file then `gitdir:`.');
    expect(ids.R2.text).toBe('**second** requirement.');
    expect(ids.R3.text).toBe('bold id form.');
    expect(ids.R4.text).toBe('dash form.');
    expect(ids.R5.text).toBe('with area.');
    expect(ids.R6.text).toBe('dot form.');
  });
  it('keeps checkbox state', () => {
    expect(ids.AC1.done).toBe(false);
    expect(ids.AC2.done).toBe(true);
    expect(ids.AC3.text).toBe('bold dash.');
    expect(ids.R1.done).toBeUndefined();
  });
  it('skips non-definitions', () => {
    expect(ids.AC4).toBeUndefined();
  });
  it('collects referenced ids and parses refs', () => {
    expect(collectIds(['AC1, AC2 (R1, R2)', undefined])).toEqual(['AC1', 'AC2', 'R1', 'R2']);
    expect(parseAcceptanceRef('AC2 (R1, R2, R3)')).toEqual({ id: 'AC2', refs: ['R1', 'R2', 'R3'], rest: '' });
    expect(parseAcceptanceRef('free text')).toBeNull();
  });
});

describe('real specs', () => {
  const root = path.resolve(__dirname, '../../../../docs/features');
  for (const [slug, expectIds] of [
    ['2026-10-19-19h-53m-worktree-isolation', ['R1', 'R3', 'AC1', 'AC10']],
    ['2026-10-19-21h-50m-dashboard-agent-optional', ['R1', 'R14', 'AC1']],
  ] as const) {
    const f = path.join(root, slug, 'spec.md');
    (existsSync(f) ? it : it.skip)(`resolves ${slug}`, () => {
      const ids = parseSpecIds(readFileSync(f, 'utf8'));
      for (const id of expectIds) expect(ids[id]?.text.length, id).toBeGreaterThan(10);
    });
  }
});

describe('AcceptanceList', () => {
  const specIds = { AC1: { text: 'first `code`', done: false }, AC2: { text: 'second', done: true }, R1: { text: 'req one' } };
  const html = renderToStaticMarkup(createElement(AcceptanceList, { items: ['AC1', 'AC2 (R1, R9)', 'AC99', 'plain'], specIds }));
  it('renders id, text, checkbox and refs', () => {
    expect(html).toContain('AC1');
    expect(html).toContain('<code');
    expect(html).toContain('req one');
    expect(html).toContain('checked');
  });
  it('shows unknown ids as-is', () => {
    expect(html).toContain('AC99');
    expect(html).toContain('R9');
    expect(html).toContain('plain');
  });
});

import { TaskDescription } from '../../components/TaskModal';

describe('done tasks and description heading', () => {
  const steps = [{ text: 'one', done: false }, { text: 'two', done: true }];
  const specIds = { AC1: { text: 'first', done: false } };
  const checked = (h: string) => (h.match(/checked=""/g) ?? []).length;

  it('shows steps and acceptance checked for DONE tasks', () => {
    expect(checked(renderToStaticMarkup(createElement(TaskDescription, { description: '', steps, allDone: true })))).toBe(2);
    expect(checked(renderToStaticMarkup(createElement(AcceptanceList, { items: ['AC1', 'AC7'], specIds, allDone: true })))).toBe(2);
  });
  it('keeps file state otherwise', () => {
    expect(checked(renderToStaticMarkup(createElement(TaskDescription, { description: '', steps })))).toBe(1);
    expect(checked(renderToStaticMarkup(createElement(AcceptanceList, { items: ['AC1'], specIds })))).toBe(0);
  });
  it('hides the Description heading when there is only steps', () => {
    const h = renderToStaticMarkup(createElement(TaskDescription, { description: '', steps }));
    expect(h).not.toContain('Description');
    expect(h).toContain('Steps');
    const withProse = renderToStaticMarkup(createElement(TaskDescription, { description: 'Some prose', steps }));
    expect(withProse).toContain('Description');
    expect(renderToStaticMarkup(createElement(TaskDescription, { description: '', steps: [] }))).toContain('No description provided.');
  });
});
