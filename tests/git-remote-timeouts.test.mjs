// AC37: every test in git-remote.test.mjs that spawns git or gh carries a
// 60 s timeout, so a hung credential helper cannot stall the whole suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const FILE = fileURLToPath(new URL('./git-remote.test.mjs', import.meta.url));
/** Anything in a test body that starts git or gh. */
const SPAWNS_RE = /\b(?:mkRepo|mkGitRepo|gitCmd|mkGhStub|repo\.git|spawnSync|execFileSync)\b|\brun\(/;

/** [{title, header, body}] for each top-level `test(` call. */
function topLevelTests(text) {
  const starts = [...text.matchAll(/^test\(/gm)].map((m) => m.index);
  return starts.map((at, i) => {
    const chunk = text.slice(at, starts[i + 1] ?? text.length);
    const header = chunk.slice(0, chunk.indexOf('=>'));
    return { title: /^test\((['"`])(.*?)\1/.exec(chunk)?.[2] ?? '?', header, body: chunk };
  });
}

test('AC37: every git-remote test that spawns git or gh passes { timeout: 60_000 }', () => {
  const tests = topLevelTests(fs.readFileSync(FILE, 'utf8'));
  assert.ok(tests.length >= 10, `parsed ${tests.length} tests`);
  const spawning = tests.filter((t) => SPAWNS_RE.test(t.body));
  assert.ok(spawning.length >= 10, `only ${spawning.length} spawning tests detected`);
  const missing = spawning.filter((t) => !/\{\s*timeout:\s*60_000\s*\}/.test(t.header)).map((t) => t.title);
  assert.deepEqual(missing, []);
});
