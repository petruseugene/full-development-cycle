import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Doc-level acceptance checks (AC1-4, AC8, AC9, AC11, AC20-22, AC31) for the
// prompt-slices feature, plus the cost-cuts checks (AC8, AC14, AC16, AC17,
// AC19, AC20, AC32, AC33). Read-only over the repo tree.
const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const skills = fs.readdirSync(path.join(ROOT, 'skills'))
  .filter((d) => fs.existsSync(path.join(ROOT, 'skills', d, 'SKILL.md')));
const FREE = ['orchestrator', 'architector'];

test('AC1: exactly 13 skills carry disable-model-invocation; orchestrator and architector do not', () => {
  const flagged = skills.filter((s) => /^disable-model-invocation: true$/m.test(rd(`skills/${s}/SKILL.md`)));
  assert.equal(skills.length, 15);
  assert.equal(flagged.length, 13);
  for (const s of FREE) assert.ok(!flagged.includes(s), s);
});

test('AC2: no Skill-tool invocation of a flagged skill in skills/commands/hooks/session-start/README', () => {
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
      const p = `${d}/${e.name}`;
      if (e.isDirectory()) walk(p); else if (/\.(md|json|sh)$/.test(e.name)) files.push(p);
    }
  };
  for (const d of ['skills', 'commands', 'hooks']) if (fs.existsSync(path.join(ROOT, d))) walk(d);
  files.push('scripts/session-start.sh', 'README.md');
  const re = /Skill\(dev-cycle:|Invoke the `dev-cycle:|Use the `dev-cycle:/;
  for (const f of files) {
    rd(f).split('\n').forEach((line, i) => {
      if (re.test(line)) assert.match(line, /dev-cycle:(orchestrator|architector)/, `${f}:${i + 1}`);
    });
  }
});

test('AC3: required reading item 1 is a Read of the playbook core, never Invoke/Skill tool', () => {
  for (const s of skills.filter((x) => x !== 'playbook')) {
    const m = rd(`skills/${s}/SKILL.md`).match(/^## Required reading\s*\n+(1\..*)$/m);
    assert.ok(m, s);
    assert.match(m[1], /Read `\$\{CLAUDE_PLUGIN_ROOT\}\/skills\/playbook\/SKILL\.md`/, s);
    assert.doesNotMatch(m[1], /Invoke|Skill tool/, s);
  }
});

test('AC4: orchestrator dispatch template and parallel-groups carry the R4 template', () => {
  const o = rd('skills/orchestrator/SKILL.md');
  const p = rd('skills/orchestrator/references/parallel-groups.md');
  assert.match(o, /Plugin root: `\$\{CLAUDE_PLUGIN_ROOT\}`/);
  for (const t of [o, p]) {
    const flat = t.replace(/\s+/g, ' ');
    assert.ok(flat.includes('Read `<root>/skills/<x>/SKILL.md`'));
    assert.ok(flat.includes('`${CLAUDE_PLUGIN_ROOT}` means `<root>`'));
    assert.ok(flat.includes('`references/…` paths are relative to `<root>/skills/<x>/`'));
    assert.ok(flat.includes('Do not call the Skill tool for dev-cycle skills'));
    assert.ok(!flat.includes('Use the `dev-cycle:'));
  }
});

test('AC8: playbook core is <= 4800 bytes with sections 2,3,6,8 and a lifecycle stub only', () => {
  const b = fs.readFileSync(path.join(ROOT, 'skills/playbook/SKILL.md'));
  assert.ok(b.length <= 4800, `${b.length} bytes`);
  const t = b.toString('utf8');
  for (const h of ['## 2.', '## 3.', '## 6.', '## 8.']) assert.ok(t.includes(h), h);
  assert.ok(t.includes('references/lifecycle.md'));
  for (const h of ['## 1. Lifecycle flows', '## 4.', '## 5.', '## 7.', '## 10.']) assert.ok(!t.includes(h), h);
});

test('AC9: lifecycle.md holds the orchestrator sections and routing/registry rows', () => {
  const t = rd('skills/playbook/references/lifecycle.md');
  for (const h of ['## 1. Lifecycle flows', '### §1a', '### Bugfix flow', '### §1c', '## 4.', '## 5.', '## 7.', '## 9.', '## 10.']) {
    assert.ok(t.includes(h), h);
  }
  const reg = t.slice(t.indexOf('## 10.'));
  for (const s of skills.filter((x) => !['playbook', 'using-dev-cycle'].includes(x))) assert.ok(reg.includes(`dev-cycle:${s}`), `registry ${s}`);
  for (const old of ['static-checker', 'git-agent', 'dependency-auditor', 'a11y-auditor', 'db-migrator', 'release-manager']) {
    assert.ok(reg.includes(`\`${old}\``), `alias ${old}`);
  }
  assert.ok(reg.includes('`a11y`') && reg.includes('`deps-audit`'));
  const routing = t.slice(t.indexOf('## 7.'), t.indexOf('## 9.'));
  assert.ok((routing.match(/^\|/gm) || []).length >= 10);
});

test('AC11: non-orchestrator skills do not route readers to lifecycle.md (architector conditional only)', () => {
  for (const s of skills.filter((x) => !['orchestrator', 'playbook', 'architector'].includes(x))) {
    assert.ok(!rd(`skills/${s}/SKILL.md`).includes('lifecycle.md'), s);
  }
  const arch = rd('skills/architector/SKILL.md').split('\n').filter((l) => l.includes('lifecycle.md'));
  assert.ok(arch.every((l) => /only when/.test(l)));
  const o = rd('skills/orchestrator/SKILL.md');
  assert.match(o, /Read `\$\{CLAUDE_PLUGIN_ROOT\}\/skills\/playbook\/references\/lifecycle\.md`/);
});

test('AC20: code-reviewer lessons step (list before add) and core §6 lessons_added', () => {
  const t = rd('skills/code-reviewer/SKILL.md');
  assert.ok(t.indexOf('lessons list --touches') < t.indexOf('lessons add'));
  assert.match(t, /zero lessons is allowed/);
  assert.match(rd('skills/playbook/SKILL.md'), /lessons_added:/);
});

test('AC21: orchestrator documents the Lessons (advisory) append for lite and quick', () => {
  const t = rd('skills/orchestrator/SKILL.md');
  assert.match(t, /Lessons \(advisory\)/);
  assert.match(t, /lite and quick/);
});

test('AC22: task-format documents owner/content, combined form and Recipe; plan-writer lists them', () => {
  const t = rd('skills/plan-writer/references/task-format.md');
  assert.match(t, /\(backend, content\)/);
  assert.match(t, /`owner`/);
  assert.match(t, /`content`/);
  assert.match(t, /\*\*Recipe:\*\*/);
  const pw = rd('skills/plan-writer/SKILL.md');
  assert.match(pw, /frontend\|backend\|mixed.*owner.*content/);
});

test('AC31: dispatch-table rows, OWNER dashboard line and explicit-confirmation rule', () => {
  const o = rd('skills/orchestrator/SKILL.md');
  const l = rd('skills/playbook/references/lifecycle.md');
  for (const t of [o, l]) {
    assert.ok(t.includes('content → dev-cycle:backend-dev'));
    assert.ok(t.includes('owner → none (wait for owner)'));
  }
  assert.ok(rd('skills/orchestrator/references/dashboard-format.md').includes('> OWNER: Task <n> — <title> (waiting)'));
  assert.match(o, /only after the user explicitly confirms that task/);
});

// ---- cost-cuts-simplify-isolation ----
const walkFiles = (d, out = []) => {
  for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
    const p = `${d}/${e.name}`;
    if (e.isDirectory()) walkFiles(p, out); else out.push(p);
  }
  return out;
};

test('cost-cuts AC8: the git fallback marker lives only in cli-fallback; guard and README say "not a security boundary"', () => {
  assert.ok(rd('skills/cli-fallback/SKILL.md').includes('DEV_CYCLE_GIT_FALLBACK=1'));
  for (const s of skills.filter((x) => x !== 'cli-fallback')) {
    assert.ok(!rd(`skills/${s}/SKILL.md`).includes('DEV_CYCLE_GIT_FALLBACK=1'), s);
  }
  assert.ok(rd('scripts/git-guard.mjs').includes('not a security boundary'));
  assert.ok(rd('README.md').includes('not a security boundary'));
});

test('cost-cuts AC14: code-reviewer cycle >= 2 mode; model resolution has the four rules and no L -> opus', () => {
  const cr = rd('skills/code-reviewer/SKILL.md');
  assert.match(cr, /incremental/);
  assert.match(cr, /--since-cycle/);
  assert.match(cr, /previous/i);
  const l = rd('skills/playbook/references/lifecycle.md');
  const mr = l.slice(l.indexOf('### Model resolution'));
  const idx = ['`feature.json.models[<skill>]`', 'code-reviewer at cycle ≥ 2 → `sonnet`', 'doc task', 'registry default'].map((k) => mr.indexOf(k));
  assert.ok(idx.every((i) => i >= 0), String(idx));
  assert.deepEqual([...idx].sort((a, b) => a - b), idx, 'rules in order');
  assert.ok(!/Size[^\n]*L[^\n]*opus/.test(mr.replace('There is no Size-based escalation', '')) || /no Size-based escalation/.test(mr));
  for (const f of [...walkFiles('skills')].filter((x) => x.endsWith('.md'))) {
    assert.ok(!/→ `opus`|escalate to opus|escalates to opus/.test(rd(f)), f);
  }
});

test('cost-cuts AC16: plan-writer carries the S-task merge rule', () => {
  for (const f of ['skills/plan-writer/SKILL.md', 'skills/plan-writer/references/sizing-heuristics.md']) {
    const t = rd(f);
    assert.match(t, /Size-S/);
    assert.match(t, /owner/);
  }
});

test('cost-cuts AC17: core section 6 has the 5-line rule and every dispatchable skill repeats it in its Output contract', () => {
  const core = rd('skills/playbook/SKILL.md');
  assert.ok(core.includes('at most 5 lines'));
  assert.ok(Buffer.byteLength(core) <= 4800);
  for (const s of skills.filter((x) => !['playbook', 'using-dev-cycle', 'orchestrator'].includes(x))) {
    const t = rd(`skills/${s}/SKILL.md`);
    const oc = t.slice(t.indexOf('## Output contract'));
    assert.ok(oc.includes('at most 5 lines'), s);
  }
});

test('cost-cuts AC19: 15 skill folders, merged skills gone, cli-fallback present', () => {
  const dirs = fs.readdirSync(path.join(ROOT, 'skills'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  assert.equal(dirs.length, 15);
  for (const old of ['static-checker', 'git-agent', 'dependency-auditor', 'a11y-auditor', 'db-migrator', 'release-manager']) {
    assert.ok(!dirs.includes(old), old);
  }
  assert.ok(fs.existsSync(path.join(ROOT, 'skills/cli-fallback/SKILL.md')));
});

test('cost-cuts AC20: moved references exist and nothing points at the removed skill folders', () => {
  for (const f of [
    'skills/cli-fallback/references/hotfix.md', 'skills/cli-fallback/references/commit-message-style.md',
    'skills/cli-fallback/references/stack-detection.md', 'skills/cli-fallback/references/tool-recipes.md',
    'skills/backend-dev/references/migrations.md', 'skills/security-reviewer/references/audit-recipes.md',
    'skills/security-reviewer/references/license-policy.md', 'skills/visual-tester/references/axe-recipes.md',
    'skills/visual-tester/references/wcag-aa-cheatsheet.md', 'skills/visual-tester/references/mobile-a11y.md',
    'skills/orchestrator/references/release.md', 'skills/orchestrator/references/recipes.md',
  ]) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), f);
  }
  const re = /skills\/(git-agent|static-checker|db-migrator|a11y-auditor|dependency-auditor|release-manager)\//;
  const files = [...walkFiles('skills'), ...walkFiles('commands'), 'README.md'];
  for (const f of files) assert.ok(!re.test(rd(f)), f);
});

test('cost-cuts AC32: the orchestrator never asks for the track and lists the escalation rules', () => {
  const o = rd('skills/orchestrator/SKILL.md');
  assert.ok(!/Track\? full \/ lite \/ quick/.test(o));
  assert.ok(!/Track\? full \/ lite \/ quick/.test(rd('skills/playbook/references/lifecycle.md')));
  assert.match(o, /`quick` \(the default\)/);
  assert.match(o, /> TRACK: <track> — <reason>/);
  assert.match(o, /`lite`: the request spans more than one area, or adds a new screen or a new API/);
  assert.match(o, /`full`: it spans several subsystems, has architecture impact, or needs wireframes/);
});

test('cost-cuts AC33: lifecycle and orchestrator shrink limits; new verbs and rules are documented', () => {
  assert.ok(fs.statSync(path.join(ROOT, 'skills/playbook/references/lifecycle.md')).size <= 29105);
  assert.ok(fs.statSync(path.join(ROOT, 'skills/orchestrator/SKILL.md')).size <= 18765);
  const o = rd('skills/orchestrator/SKILL.md');
  for (const k of ['`ship [', '`init [', 'review snapshot', 'review diff', 'git-guard', 'cli-fallback', '--release auto']) {
    assert.ok(o.includes(k), k);
  }
  const l = rd('skills/playbook/references/lifecycle.md');
  for (const k of ['review snapshot', 'ship', 'Threat notes', '--release auto', 'skills/cli-fallback/references/hotfix.md', 'Model resolution']) {
    assert.ok(l.includes(k), k);
  }
  assert.ok(rd('skills/orchestrator/references/recipes.md').includes('## Grammar'));
});

test('worktree-isolation AC24: worktrees.md exists, is complete and is referenced', () => {
  const w = rd('skills/orchestrator/references/worktrees.md');
  for (const k of ['worktree start', 'worktree collect', 'worktree remove --all', 'stray']) {
    assert.ok(w.includes(k), k);
  }
  assert.ok(rd('skills/orchestrator/SKILL.md').includes('references/worktrees.md'));
});
