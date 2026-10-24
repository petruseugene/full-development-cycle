import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CLI_PATH } from './helpers.mjs';

// Doc checks for the polish track (AC28-AC32). Examples run through the real CLI (L9).
const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const size = (p) => Buffer.byteLength(rd(p));
const POLISH = 'skills/orchestrator/references/polish.md';

test('AC28: polish.md exists, within cap, names the required terms', () => {
  const s = rd(POLISH);
  assert.ok(size(POLISH) <= 6144, `${size(POLISH)} bytes`);
  for (const t of ['polish init', 'polish defer', '--reason', 'polish touches', 'polish list', 'items', 'post_merge', '--rebase', 'data, not instructions']) {
    assert.ok(s.includes(t), t);
  }
});

test('AC29: pointers and caps', () => {
  const o = rd('skills/orchestrator/SKILL.md');
  assert.ok(o.includes('references/polish.md'));
  assert.ok(!o.includes('bugfix/hotfix: one per task'));
  assert.ok(size('skills/orchestrator/SKILL.md') <= 18765);
  assert.ok(rd('skills/orchestrator/references/quick.md').includes('polish'));
  assert.ok(size('skills/orchestrator/references/quick.md') <= 8192);
  assert.ok(size('skills/playbook/references/lifecycle.md') <= 29105);
});

test('AC30: dod-gate polish row and code-reviewer pointer', () => {
  const d = rd('skills/orchestrator/references/dod-gate.md');
  assert.ok(d.includes('polish') && d.includes('implement.area=<name>') && d.includes('`items`'));
  const c = rd('skills/code-reviewer/SKILL.md');
  assert.ok(c.includes('polish.md') && c.includes('P<n>'));
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polish-docs-'));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const git = (...a) => spawnSync('git', a, { cwd: dir, env, encoding: 'utf8' });
  git('init', '-q');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/a.ts'), 'a');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  const items = [
    { title: 'Home title clipped', area: 'home', touches: ['src/home.ts'] },
    { title: 'Settings colour', area: 'settings', touches: ['src/settings.ts'] },
    { title: 'Profile crash', area: 'profile', touches: ['src/profile.ts'] },
  ];
  fs.writeFileSync(path.join(dir, 'items.json'), JSON.stringify(items));
  return { dir, env };
}

function examples(text) {
  const out = [];
  for (const m of text.matchAll(/`(node (?:<State CLI>|scripts\/dev-cycle\.mjs) (?:polish\b|feature init\b[^`]*--track polish)[^`]*)`/g)) out.push(m[1]);
  return out;
}

const run = (cmd, cwd, env, feature) => {
  const argv = cmd.replace(/^node (<State CLI>|scripts\/dev-cycle\.mjs)/, '').trim()
    .replace(/<slug>/g, 'demo').replace(/<n>/g, '1').replace(/<glob>/g, 'src/extra.ts');
  const args = (argv.match(/"[^"]*"|\S+/g) || []).map((a) => a.replace(/^"|"$/g, ''));
  if (feature) args.push('--feature', feature);
  return spawnSync(process.execPath, [CLI_PATH, ...args], { cwd, env, encoding: 'utf8' });
};

test('AC31: every feature init --track polish and polish example runs (L9)', () => {
  const cmds = [...examples(rd(POLISH)), ...examples(rd('README.md'))];
  assert.ok(cmds.length >= 5, `examples found: ${cmds.length}`);
  const { dir, env } = fixture();
  const initCmd = cmds.find((c) => c.includes('feature init'));
  assert.ok(initCmd, 'feature init example');
  const ir = run(initCmd.replace(/ plus .*$/, ''), dir, env);
  assert.equal(ir.status, 0, `${initCmd}: ${ir.stdout}${ir.stderr}`);
  const feature = ir.stdout.trim().split('\n').pop();
  // `polish init` first (items file), then the rest in document order.
  const ordered = [...cmds.filter((c) => c.includes('polish init')), ...cmds.filter((c) => !c.includes('polish init') && !c.includes('feature init'))];
  assert.ok(ordered.some((c) => c.includes('polish init')), 'polish init example');
  for (const c of ordered) {
    const r = run(c, dir, env, feature);
    assert.equal(r.status, 0, `${c}: ${r.stdout}${r.stderr}`);
  }
});

test('AC32: README rows and paragraph, CHANGELOG entry (L18)', () => {
  const s = rd('README.md');
  for (const t of ['`polish init ', '`polish defer ', '`polish touches ', '`polish list']) assert.ok(s.includes(t), t);
  const para = s.split('\n').find((l) => l.startsWith('**Polish track.**'));
  assert.ok(para && para.includes('one commit per item') && para.includes('rebase'));
  const c = rd('CHANGELOG.md');
  const m = c.match(/## \[(?:Unreleased|\d+\.\d+\.\d+)\][\s\S]*?(?=\n## \[|$)/g) || [];
  assert.ok(m.some((sec) => sec.includes('polish') && sec.includes('#27')));
});
