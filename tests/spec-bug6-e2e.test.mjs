import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkFixture, runCli, sampleFeatureJson } from './helpers.mjs';

const SPEC = `# Spec

## 6. Acceptance Criteria
- [ ] AC1: base one
- [ ] AC2: **[заменён 22.10 → AC5]** old body text
- [ ] AC3: base three

## Правка 22.10 — design v2

### 9.13. Acceptance Criteria правки
- [ ] AC4: new four
- [ ] AC5: new five

## Tasks
`;
const plan = (status) => `# Plan

## Tasks
- [ ] Task 1 (backend): one

### Task 1: one  \`[${status}]\`
**Tag:** backend
**Touches:** src/a.ts
**Acceptance:** AC2, AC4
`;

function run(status) {
  const fx = mkFixture({ featureJson: sampleFeatureJson({}), files: { 'plan.md': plan(status), 'spec.md': SPEC } });
  try {
    const b = runCli(['brief', '1'], { cwd: fx.root });
    const f = path.join(fx.featureDir, 'briefs', 'task-1.md');
    const md = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
    const a = runCli(['spec', 'analyze', '--json', '--feature', fx.featureDir], { cwd: fx.root });
    return { b, md, a, out: JSON.parse(a.stdout) };
  } finally { fx.cleanup(); }
}

test('bug #6 e2e: TODO task on superseded AC2 — brief resolves to AC5, analyze errors', () => {
  const { b, md, a, out } = run('TODO');
  assert.equal(b.status, 0, b.stderr);
  assert.ok(md.includes('AC5: new five') && md.includes('AC4: new four'), md);
  assert.ok(!md.includes('old body text'));
  assert.equal(a.status, 1);
  const e = out.errors.find((x) => x.code === 'superseded-ref');
  assert.ok(e, JSON.stringify(out));
  assert.match(e.message, /AC2/);
});

test('bug #6 e2e: DONE task on superseded AC2 — brief ok, analyze only warns', () => {
  const { b, a, out } = run('DONE');
  assert.equal(b.status, 0, b.stderr);
  assert.equal(a.status, 0);
  assert.equal(out.errors.length, 0);
  assert.ok(out.warnings.some((w) => w.code === 'superseded-ref-done' && /AC2/.test(w.message)), JSON.stringify(out));
});
