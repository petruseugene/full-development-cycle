import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderIndex, renderFeature, fmtUsd, fmtTokens, fmtDuration, featureHref } from '../lib/report-html.mjs';
import { buildTimeline } from '../lib/report-timeline.mjs';
import { buildCost, buildTrend, buildTracks } from '../lib/report-cost.mjs';
import { buildAcMap } from '../lib/report-ac.mjs';
import { CSP_REPORT } from '../lib/html.mjs';

const P = {
  script: '<script>alert(1)</script>',
  img: '"><img src=x onerror=alert(1)>',
  a: '<a href="javascript:alert(1)">t</a>',
  svg: '<svg onload=alert(1)>',
};

const HISTORY = [
  { phase: 'discovery', subagent: 'dev-cycle:discovery', status: 'DONE', ts: '2026-10-19T01:10:00Z', started_at: '2026-10-19T01:00:00Z', ended_at: '2026-10-19T01:10:00Z', tokens: { input: 1 }, usd_est: 0.5, tokens_k: 10, model: 'opus', summary: P.img },
  { phase: 'plan', subagent: 'plan-writer', status: 'DONE', ts: '2026-10-19T01:20:00Z', duration_s: 300, tokens_k: 4, model: 'opus' },
  { phase: 'implement.task=2', subagent: 'backend-dev', status: 'DONE', ts: '2026-10-19T01:50:00Z', started_at: '2026-10-19T01:40:00Z', ended_at: '2026-10-19T01:50:00Z', tokens: { input: 1 }, usd_est: 1.25, tokens_k: 30, model: 'sonnet' },
  { phase: 'implement.task=3', subagent: P.svg, status: 'BLOCKED', ts: '2026-10-19T01:52:00Z', started_at: '2026-10-19T01:45:00Z', ended_at: '2026-10-19T01:52:00Z', tokens_k: 12, model: P.script },
  { phase: 'implement.task=2', subagent: 'backend-dev', status: 'DONE', ts: '2026-10-19T02:00:00Z', duration_s: 120, usd_est: 0.75, tokens: { input: 1 }, tokens_k: 9 },
  { phase: 'implement.task=2', subagent: 'backend-dev', status: 'DONE', ts: '2026-10-19T02:10:00Z', duration_s: 60, tokens_k: 3 },
  { phase: 'owner.task=4', subagent: 'owner', status: 'DONE', ts: '2026-10-19T03:00:00Z' },
  { phase: 'gate', subagent: 'cli', executor: 'cli', status: 'DONE', ts: '2026-10-19T03:05:00Z' },
];

const SPEC = `# Spec ${P.script}

## Acceptance criteria

- [ ] AC1: first ${P.a}
- [ ] AC2: second ${P.svg}
- [ ] AC3: third
`;
const PLAN = `# Plan

## Task details

### Task 1: ${P.a}  \`[TODO]\`
**Tag:** backend
**Touches:** \`a/**\`
**Acceptance:** AC1–AC2
`;
const REPORT = `# Report

## AC coverage — auto
- [pass] AC1 — a.test.mjs › "${P.svg}"
- [fail] AC2 — b.test.mjs › "${P.img}"
`;

function makeFeature(over = {}) {
  const tl = buildTimeline(HISTORY, { tasks: [{ n: 1, tag: 'backend', status: 'TODO', dependsOn: [], touches: ['a/**'] }, { n: 2, tag: 'backend', status: 'TODO', dependsOn: [1], touches: ['b/**'] }] });
  const { ac_map, counts } = buildAcMap({ specText: SPEC, planText: PLAN, reportText: REPORT });
  return {
    folder: '2026-10-19-01h-00m-demo',
    slug: 'demo',
    title: P.script,
    flow: 'feature',
    track: 'full',
    created: '2026-10-19T01:00:00Z',
    ...tl,
    cost: buildCost(HISTORY),
    ac_map,
    ac_counts: counts,
    gallery: { path: 'docs/features/2026-10-19-01h-00m-demo/verification/index.html', exists: true, verdict: 'PASSED', run_time_s: 95, budget_s: 360 },
    ...over,
  };
}

function makeModel(over = {}) {
  const feats = [
    { folder: 'f-measured', created: '2026-10-01', flow: 'feature', history: HISTORY },
    { folder: 'f-estimated', created: '2026-10-02', flow: 'feature', track: 'lite', history: [{ phase: 'x', subagent: 'y', ts: '2026-10-02T00:00:00Z', tokens_k: 50 }] },
    { folder: P.a, created: '2026-10-03', flow: 'bugfix', history: [] },
  ];
  return {
    generated_at: '2026-10-19T04:00:00Z',
    features: [
      makeFeature(),
      { folder: P.img, unreadable: `bad json ${P.script}` },
      { folder: 'javascript:alert(1)', flow: 'feature' },
    ],
    trend: buildTrend(feats),
    tracks: buildTracks(feats),
    waiting_owner: [
      { folder: 'f1', task: 4, title: P.a, since: '2026-10-19T01:20:00Z' },
      { folder: 'f1', task: 5, title: 'done one', duration_s: 3600, done: true },
    ],
    unconfirmed_merges: [
      { folder: 'f1', kind: 'pr', branch: P.svg, state: 'open', url: 'https://github.com/o/r/pull/1' },
      { folder: 'f2', kind: 'pr', branch: 'b', state: 'unknown', url: 'javascript:alert(1)' },
      { folder: 'f3', kind: 'pr', branch: 'c', state: 'closed-unmerged', url: 'https://evil.example/x' },
      { folder: 'f4', kind: 'post_merge', step: P.script },
    ],
    ...over,
  };
}

function assertSafe(html, label) {
  assert.doesNotMatch(html, /<script/i, `${label}: <script`);
  assert.doesNotMatch(html, /onerror=/i, `${label}: onerror=`);
  assert.doesNotMatch(html, /onload=/i, `${label}: onload=`);
  assert.doesNotMatch(html, /<img src=x/i, `${label}: <img src=x`);
  assert.doesNotMatch(html, /\s[a-z-]+\s*=\s*["']?\s*javascript:/i, `${label}: javascript: in attribute`);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, `${label}: on* handler`);
  // AC28: CSP first in <head>, no external resources, only github https hrefs.
  assert.ok(html.includes(`<head><meta http-equiv="Content-Security-Policy" content="${CSP_REPORT}">`), `${label}: CSP meta`);
  assert.doesNotMatch(html, /src\s*=\s*["']?https?:/i, `${label}: external src`);
  assert.doesNotMatch(html, /<link/i, `${label}: <link`);
  assert.doesNotMatch(html, /@import/i, `${label}: @import`);
  assert.doesNotMatch(html, /url\(\s*["']?https?:/i, `${label}: url()`);
  assert.doesNotMatch(html, /http:\/\//i, `${label}: http://`);
  for (const m of html.matchAll(/href\s*=\s*"([^"]*)"/gi)) {
    if (/^https?:/i.test(m[1])) assert.match(m[1], /^https:\/\/github\.com\//, `${label}: href ${m[1]}`);
    assert.doesNotMatch(m[1], /^(javascript|data):/i, `${label}: href scheme`);
  }
}

test('AC27/AC28: index escapes every payload and follows CSP/URL rules', () => {
  const html = renderIndex(makeModel());
  assertSafe(html, 'index');
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('&quot;&gt;&lt;img src&#61;x onerror&#61;alert(1)&gt;'));
  assert.ok(html.includes('&lt;svg onload&#61;alert(1)&gt;'));
  assert.ok(html.includes('unreadable: bad json &lt;script&gt;'));
  // folder named "javascript:alert(1)" is a ./-prefixed, encoded relative link
  assert.ok(html.includes('href="./javascript%3Aalert(1).html"'));
});

test('AC28: only github PR URLs become links; javascript:/evil hosts render none', () => {
  const html = renderIndex(makeModel());
  assert.ok(html.includes('href="https://github.com/o/r/pull/1"'));
  assert.ok(!html.includes('evil.example'));
  assert.ok(!/javascript:alert\(1\)"/.test(html));
  const hrefs = [...html.matchAll(/href="(https:[^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(hrefs, ['https://github.com/o/r/pull/1']);
  for (const url of ['javascript:alert(1)', 'https://evil.example/x']) {
    const only = renderIndex(makeModel({ unconfirmed_merges: [{ folder: 'f', branch: 'b', state: 'open', url }] }));
    assert.doesNotMatch(only, /href="(https:|javascript:)/);
    assert.ok(only.includes('chip-warn">open<'));
  }
});

test('AC27/AC28: feature page escapes every payload and follows CSP/URL rules', () => {
  const html = renderFeature(makeFeature(), { generated_at: '2026-10-19T04:00:00Z' });
  assertSafe(html, 'feature');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('&lt;svg onload&#61;alert(1)&gt;'));
  const unreadable = renderFeature({ folder: P.img, unreadable: P.script });
  assertSafe(unreadable, 'unreadable feature');
  assert.ok(unreadable.includes('unreadable: &lt;script&gt;'));
});

test('AC22: feature timeline is inline SVG with lanes, timing, fix cycles and waits', () => {
  const f = makeFeature();
  assert.ok(f.lanes >= 2, 'overlapping implement entries get separate lanes');
  const html = renderFeature(f, { generated_at: 'x' });
  assert.match(html, /<div class="svgwrap timeline"><svg [^>]*role="img"/);
  assert.match(html, /lane 1</);
  assert.match(html, /lane 2</);
  assert.ok(html.includes('self-reported'));
  assert.ok(html.includes('point'));
  assert.ok(html.includes('fix cycle 1'));
  assert.ok(html.includes('fix cycle 2'));
  assert.ok(html.includes('idle/wait'));
  assert.ok(html.includes('owner wait'));
  assert.ok(html.includes('discovery · dev-cycle:discovery · DONE · 10m 00s · $0.50'));
  assert.ok(html.includes('~12k tok (est.)'));
  // plan groups, wrapped in overflow containers
  assert.ok(html.includes('Group 1: Task 1'));
  assert.ok(html.includes('Group 2: Task 2'));
  assert.ok(html.includes('class="scroll"'));
});

test('feature page: cost tables, AC map chips and counts, gallery link', () => {
  const html = renderFeature(makeFeature(), { generated_at: 'x' });
  for (const h of ['By agent', 'By model', 'By phase', 'Measured $', 'Est. k tokens', 'Measured n', 'Estimated n']) assert.ok(html.includes(h), h);
  assert.ok(html.includes('>discovery<'), 'dev-cycle: prefix normalized');
  const cost = html.slice(html.indexOf('id="cost"'), html.indexOf('id="ac-map"'));
  assert.ok(!cost.includes('>cli<'), 'cli entries excluded');
  assert.ok(!cost.includes('>dev-cycle:discovery<'));
  assert.ok(html.includes('chip-bad">failing<'));
  assert.ok(html.includes('chip-ok">auto<'));
  assert.ok(html.includes('Task 1'));
  assert.ok(html.includes('href="../../docs/features/2026-10-19-01h-00m-demo/verification/index.html"'));
  assert.ok(html.includes('<code class="wrap">docs/features/2026-10-19-01h-00m-demo/verification/index.html</code>'));
  assert.ok(html.includes('chip-ok">PASSED<'));
  assert.ok(html.includes('1m 35s'));
  const none = renderFeature(makeFeature({ gallery: { exists: false } }), {});
  assert.ok(none.includes('No gallery'));
  assert.ok(!none.includes('href="../../docs'));
});

test('AC23: index trend labels measured vs estimated points, tracks show small sample', () => {
  const html = renderIndex(makeModel());
  assert.match(html, /<div class="trendwrap"><svg /);
  assert.match(html, /<circle [^>]*><title>f-measured · measured · \$/);
  assert.match(html, /<rect [^>]*><title>f-estimated · estimated · ~50k tok<\/title>/);
  assert.ok(html.includes('measured — USD'));
  assert.ok(html.includes('estimated — k tokens'));
  assert.ok(html.includes('chip-warn">small sample<'));
  assert.ok(html.includes('Waiting for owner'));
  assert.ok(html.includes('1h 00m'));
  assert.ok(html.includes('2026-10-19 01:20Z'));
});

test('deterministic output: identical input gives byte-identical HTML except generated_at', () => {
  const a = renderIndex(makeModel());
  const b = renderIndex(makeModel());
  assert.equal(a, b);
  const c = renderIndex(makeModel({ generated_at: '2027-01-01T00:00:00Z' }));
  const strip = (s) => s.replace(/Generated at <span class="num">[^<]*<\/span>/, '');
  assert.notEqual(a, c);
  assert.equal(strip(a), strip(c));
  const fa = renderFeature(makeFeature(), { generated_at: '2026-10-19T04:00:00Z' });
  const fb = renderFeature(makeFeature(), { generated_at: '2030-10-19T04:00:00Z' });
  assert.equal(strip(fa), strip(fb));
});

test('determinism: open owner waits render no clock-dependent duration (no "so far")', () => {
  const at = (now, waiting_s) => renderIndex(makeModel({
    generated_at: now,
    waiting_owner: [{ folder: 'f1', task: 4, title: 't', since: '2026-10-19T01:20:00Z', waiting_s }],
  }));
  const strip = (s) => s.replace(/Generated at <span class="num">[^<]*<\/span>/, '');
  const a = at('2026-10-19T02:20:00Z', 3600);
  const b = at('2026-10-19T05:21:59Z', 14519);
  assert.equal(strip(a), strip(b));
  assert.doesNotMatch(a, /so far/);
});

test('index tables stack into labelled cards on narrow screens; slugs break only at hyphens', () => {
  const html = renderIndex(makeModel({
    waiting_owner: [{ folder: '2026-10-19-01h-26m-visual-tester', task: 4, title: 't', since: '2026-10-19T01:20:00Z' }],
  }));
  assert.match(html, /@media \(max-width:599px\)\{[^}]*table\.stack thead/);
  for (const id of ['trend', 'tracks', 'waiting-owner', 'unconfirmed-merges']) {
    const sec = html.split(`id="${id}"`)[1].split('</section>')[0];
    assert.match(sec, /<table class="stack">/, id);
    assert.match(sec, /<td data-label="Feature"|<td data-label="Flow"/, id);
  }
  assert.match(html, />2026-<wbr>10-<wbr>19-<wbr>01h-<wbr>26m-<wbr>visual-<wbr>tester<\/a>/);
  assert.ok(html.includes('href="./2026-10-19-01h-26m-visual-tester.html"'), 'href is the plain relative file name');
  assert.doesNotMatch(html, /<base/i);
});

test('branch names, steps and paths break only after - and / (no mid-word wraps at 375)', () => {
  const html = renderIndex(makeModel({
    unconfirmed_merges: [
      { folder: 'f1', kind: 'pr', branch: 'feat/workflow-hardening', state: 'open', url: 'https://github.com/o/r/pull/1' },
      { folder: 'f2', kind: 'post_merge', step: 'scripts/post-merge.sh' },
    ],
  }));
  assert.ok(html.includes('branch <code>feat/<wbr>workflow-<wbr>hardening</code>'));
  assert.ok(html.includes('post-merge step <code>scripts/<wbr>post-<wbr>merge.sh</code>'));
});

test('cost trend: data points stay inside a padded plot, clear of the axis labels', () => {
  const trend = [
    { folder: 'a', created: '2026-01-01T00:00:00Z', measured: false, tokens_k: 2546.5 },
    { folder: 'b', created: '2026-01-02T00:00:00Z', measured: true, usd_est: 12.34 },
    { folder: 'c', created: '2026-01-03T00:00:00Z', measured: false, tokens_k: 2546.5 },
  ];
  const svg = renderIndex(makeModel({ trend })).split('<div class="trendwrap">')[1].split('</svg>')[0];
  const num = (re) => [...svg.matchAll(re)].map((m) => Number(m[1]));
  const [rightAxis] = num(/<line x1="(\d+)" y1="16" x2="\1"/g).filter((v) => v > 320);
  const [leftAxis] = num(/<line x1="(\d+)" y1="16" x2="\1"/g).filter((v) => v < 320);
  const xs = [...num(/<circle cx="([\d.]+)"/g), ...num(/<rect x="([\d.]+)"/g).map((v) => v + 5)];
  const ys = [...num(/<circle cx="[\d.]+" cy="([\d.]+)"/g), ...num(/<rect x="[\d.]+" y="([\d.]+)"/g).map((v) => v + 5)];
  assert.equal(xs.length, 3);
  for (const x of xs) assert.ok(x - 5 >= leftAxis + 8 && x + 5 <= rightAxis - 8, `x ${x} too close to an axis`);
  for (const y of ys) assert.ok(y - 5 >= 16 + 6, `y ${y} overlaps the top labels`);
  // the right label ("2546.5k tok", ~11 chars at 10px) fits inside the viewBox
  assert.ok(640 - (rightAxis + 4) >= 11 * 6);
});

test('empty / legacy inputs render without throwing', () => {
  const idx = renderIndex({});
  assertSafe(idx, 'empty index');
  const f = renderFeature({ folder: 'legacy' });
  assertSafe(f, 'legacy feature');
  assert.ok(f.includes('No timed history entries.'));
});

test('formatters are deterministic', () => {
  assert.equal(fmtUsd(1.005), '$1.00');
  assert.equal(fmtUsd(undefined), '—');
  assert.equal(fmtTokens(12.34), '12.3k');
  assert.equal(fmtTokens(12), '12k');
  assert.equal(fmtDuration(3725), '1h 02m');
  assert.equal(fmtDuration(65), '1m 05s');
  assert.equal(fmtDuration(9), '9s');
  assert.equal(featureHref('a b'), './a%20b.html');
});

test('renders a model built by buildReportModel from the report fixtures (AC27/AC28)', async () => {
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { buildReportModel } = await import('../lib/report-model.mjs');
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'report');
  const gh = async () => ({ code: 0, stdout: JSON.stringify({ state: 'OPEN', url: 'javascript:alert(1)' }), stderr: '' });
  const model = await buildReportModel({ featuresRoot: root, now: '2026-02-01T00:00:00.000Z', gh,
    profile: { post_merge: [{ name: 'deploy', confirm: true }] } });
  const idx = renderIndex(model);
  assertSafe(idx, 'fixture index');
  assert.ok(idx.includes('unreadable: '));
  assert.ok(idx.includes('Waiting for owner'));
  for (const f of model.features) {
    const html = renderFeature(f, { generated_at: model.generated_at });
    assertSafe(html, `fixture ${f.folder}`);
  }
  const xss = model.features.find((f) => /xss/.test(f.folder));
  assert.ok(xss && !xss.unreadable);
  assert.ok(renderFeature(xss, {}).includes('&lt;script&gt;'));
});
