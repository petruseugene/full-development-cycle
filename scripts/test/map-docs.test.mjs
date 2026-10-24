import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CLI_PATH } from './helpers.mjs';

// Doc checks for the codebase map (AC21-AC24). Examples run through the real CLI (L9).
const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('AC21: orchestrator docs use context --touches within caps', () => {
  const caps = {
    'skills/orchestrator/SKILL.md': 18765,
    'skills/orchestrator/references/quick.md': 8192,
    'skills/playbook/references/lifecycle.md': 29105,
  };
  for (const [p, cap] of Object.entries(caps)) {
    const s = rd(p);
    assert.ok(s.includes('context --touches'), p);
    assert.ok(!s.includes('lessons list --touches'), p);
    assert.ok(Buffer.byteLength(s) <= cap, p);
  }
  assert.ok(rd('skills/code-reviewer/SKILL.md').includes('lessons list --touches'));
});

test('AC22: discovery and implementer skills mention the map', () => {
  const d = rd('skills/discovery/SKILL.md');
  for (const t of ['map', '.dev-cycle/map.md', '## Notes']) assert.ok(d.includes(t), t);
  assert.match(d, /Never edit above `## Notes`/);
  for (const p of ['skills/backend-dev/SKILL.md', 'skills/frontend-dev/SKILL.md']) {
    assert.ok(rd(p).includes('Project map'), p);
  }
});

test('AC23: README rows, disclosure and paragraph', () => {
  const s = rd('README.md');
  assert.ok(s.includes('map [--check] [--force] [--json]'));
  assert.ok(s.includes('context [--touches'));
  const sec = s.slice(s.indexOf('## What dev-cycle runs and sends'), s.indexOf('## Installation'));
  assert.ok(sec.includes('`map`') && sec.includes('git ls-files'));
  const para = s.split('\n').find((l) => l.startsWith('**Codebase map.**'));
  assert.ok(para && para.includes('report --all') && para.includes('CLAUDE.md'));
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'map-docs-'));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const git = (...a) => spawnSync('git', a, { cwd: dir, env, encoding: 'utf8' });
  git('init', '-q');
  fs.mkdirSync(path.join(dir, 'apps/web'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'r', workspaces: ['apps/*'] }));
  fs.writeFileSync(path.join(dir, 'apps/web/package.json'), JSON.stringify({ name: 'web', scripts: { dev: 'x' } }));
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return { dir, env };
}

function examples(text) {
  const out = [];
  for (const m of text.matchAll(/`(node (?:<State CLI>|scripts\/dev-cycle\.mjs) (?:map|context)\b[^`]*)`/g)) out.push(m[1]);
  return out;
}

test('AC23: every map/context example in README and discovery runs (L9)', () => {
  const cmds = [...examples(rd('README.md')), ...examples(rd('skills/discovery/SKILL.md'))];
  assert.ok(cmds.length >= 2, 'examples found');
  const { dir, env } = fixture();
  // Documented order: `map` writes the file first, so `map --check` is fresh.
  const first = spawnSync(process.execPath, [CLI_PATH, 'map'], { cwd: dir, env, encoding: 'utf8' });
  assert.equal(first.status, 0, first.stdout + first.stderr);
  for (const c of cmds) {
    const argv = c.replace(/^node (<State CLI>|scripts\/dev-cycle\.mjs)/, '').trim();
    const args = (argv.match(/"[^"]*"|\S+/g) || []).map((a) => a.replace(/^"|"$/g, ''));
    const r = spawnSync(process.execPath, [CLI_PATH, ...args], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(r.status, 0, `${c}: ${r.stdout}${r.stderr}`);
  }
});

test('AC24: CHANGELOG mentions map and context --touches (L18)', () => {
  const s = rd('CHANGELOG.md');
  const m = s.match(/## \[(?:Unreleased|\d+\.\d+\.\d+)\][\s\S]*?(?=\n## \[|$)/g) || [];
  assert.ok(m.some((sec) => sec.includes('`map') && sec.includes('context --touches')));
});
