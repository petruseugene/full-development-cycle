// `dev-cycle visual gallery` — writes verification/index.html (spec R12, R27, R28).
// A static, script-free page: per screen the screenshot, the reference and the
// checklist table (full row width below the two images, so every column
// is visible without inner scroll at >= 600px). All manifest text goes through esc(); image sources are
// relative paths confined to the project root.

import fs from 'node:fs';
import path from 'node:path';
import {
  atomicWrite, output, parseCommandArgs, readText, resolveFeatureDir, resolveProjectRoot,
} from './core.mjs';
import { CSP_GALLERY, chip, esc, page } from './html.mjs';
import {
  loadVisualConfig, readManifest, resolveInside, screenLimit, verificationDir,
} from './visual-core.mjs';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const EXTRA_CSS = `
.g-head{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center}
.g-row{display:grid;grid-template-columns:minmax(0,1fr);gap:12px}
.g-img{min-width:0}
.g-img img{display:block;border:1px solid var(--hairline);border-radius:var(--radius);background:var(--bg)}
.g-cap{font-size:12px;color:var(--muted);margin:0 0 4px}
.g-checks{min-width:0}
.g-checks td,.g-checks th{overflow-wrap:anywhere}
.g-checks td.num{white-space:nowrap}
@media (min-width:600px){.g-row{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.g-checks{grid-column:1/-1}}
`;

/**
 * Relative URL (from `verDir`) of `target` when it resolves inside `root`,
 * else null. `target` is resolved against `verDir` unless `fromRoot`.
 */
export function imageSrc(root, verDir, target, { fromRoot = false } = {}) {
  if (typeof target !== 'string' || target.trim() === '' || target === 'none') return null;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) && !/^[A-Za-z]:[\\/]/.test(target)) return null;
  const abs = path.resolve(fromRoot ? root : verDir, target);
  const rel = path.relative(root, abs);
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  try {
    resolveInside(root, rel);
  } catch {
    return null;
  }
  const out = path.relative(verDir, abs).split(path.sep).join('/');
  return out.split('/').map(encodeURIComponent).join('/');
}

const fmt = (v) => (v === undefined || v === null || v === '' ? '—' : typeof v === 'number' ? String(Math.round(v * 1000) / 1000) : String(v));
const secs = (v) => (typeof v === 'number' && Number.isFinite(v) ? `${Math.round(v * 10) / 10} s` : '—');

function imageBlock(label, src, alt, missingText) {
  const inner = src
    ? `<img src="${esc(src)}" alt="${esc(alt)}" loading="lazy">`
    : `<p class="muted">${esc(missingText)}</p>`;
  return `<div class="g-img"><p class="g-cap">${esc(label)}</p>${inner}</div>`;
}

function checkRows(checks) {
  if (!Array.isArray(checks) || checks.length === 0) return '<p class="muted">No checks recorded.</p>';
  const rows = checks.filter(isObject).map((c) => `<tr>
<td>${esc(c.type)}</td><td>${esc(c.subject)}</td><td class="num">${esc(fmt(c.measured))}</td>
<td class="num">${esc(fmt(c.expected))}</td><td class="num">${esc(fmt(c.tolerance))}</td>
<td>${esc(fmt(c.source))}</td><td>${chip(c.result, c.result ?? 'unknown')}</td></tr>`).join('\n');
  return `<div class="scroll"><table>
<thead><tr><th>Check</th><th>Subject</th><th>Measured</th><th>Expected</th><th>Tolerance</th><th>Source</th><th>Result</th></tr></thead>
<tbody>
${rows}
</tbody></table></div>`;
}

function teardownStatus(teardown) {
  if (!isObject(teardown) || !Array.isArray(teardown.steps)) return { status: 'unknown', label: 'teardown not run' };
  const failed = teardown.steps.filter((s) => !s?.ok);
  if (failed.length) return { status: 'fail', label: `teardown failed (${failed.length} of ${teardown.steps.length} steps)` };
  return { status: 'pass', label: `teardown done (${teardown.steps.length} steps)` };
}

/**
 * Render the gallery HTML.
 * @param {{manifest: object, teardown?: object|null, root: string, featureDir: string,
 *   visual?: object|null, title?: string}} o
 * @returns {string}
 */
export function renderGallery({ manifest, teardown = null, root, featureDir, visual = null, title }) {
  const verDir = verificationDir(featureDir);
  const screensObj = isObject(manifest?.screens) ? manifest.screens : {};
  const selected = Array.isArray(manifest?.plan?.selected) ? manifest.plan.selected : [];
  const ids = [...selected.filter((id) => id in screensObj), ...Object.keys(screensObj).filter((id) => !selected.includes(id))];
  const verdict = isObject(manifest?.verdict) ? manifest.verdict : null;

  const sumDur = ids.reduce((a, id) => a + (Number(screensObj[id]?.duration_s) || 0), 0);
  const total = verdict?.run_time_s ?? sumDur;
  const budget = verdict?.budget_s ?? manifest?.plan?.budget_s;
  const td = teardownStatus(teardown);

  const header = `<div class="card g-head">
<h1>${esc(title ?? 'Visual verification')}</h1>
<span>Verdict: ${verdict ? chip(verdict.status, verdict.status) : chip('unknown', 'no verdict')}</span>
<span>Total time: <span class="num">${esc(secs(total))}</span> of <span class="num">${esc(budget ? secs(budget) : '—')}</span> budget</span>
<span>${chip(td.status, td.label)}</span>
</div>`;

  const sections = ids.map((id) => {
    const s = isObject(screensObj[id]) ? screensObj[id] : {};
    const shot = imageSrc(root, verDir, s.screenshot);
    const hasRef = typeof s.reference === 'string' && s.reference !== '' && s.reference !== 'none';
    const refSrc = hasRef ? imageSrc(root, verDir, s.reference, { fromRoot: true }) : null;
    const refText = hasRef ? 'reference outside project' : 'no reference';
    const limit = screenLimit(s, visual);
    const over = typeof s.duration_s === 'number' && s.duration_s > limit;
    const meta = [
      `Duration: <span class="num">${esc(secs(s.duration_s))}</span> of <span class="num">${esc(secs(limit))}</span> limit`,
      over || s.timed_out || s.overrun ? chip('warn', s.timed_out ? 'timed out' : 'over limit') : '',
      s.result ? chip(s.result, s.result) : '',
    ].filter(Boolean).join(' ');
    const acs = Array.isArray(s.acs) && s.acs.length ? ` <span class="muted">${esc(s.acs.join(', '))}</span>` : '';
    return `<section class="card">
<h2>${esc(s.title ?? id)} <code>${esc(id)}</code>${acs}</h2>
<p>${meta}</p>
<div class="g-row">
${imageBlock('Screenshot', shot, `Screenshot of ${s.title ?? id}`, 'no screenshot')}
${imageBlock('Reference', refSrc, `Reference for ${s.title ?? id}`, refText)}
<div class="g-checks"><p class="g-cap">Checklist</p>${checkRows(s.checks)}</div>
</div>
</section>`;
  }).join('\n');

  const empty = ids.length ? '' : '<p class="card muted">No screens recorded in the manifest.</p>';
  return page({
    title: title ?? 'Visual verification',
    csp: CSP_GALLERY,
    body: `<style>${EXTRA_CSS}</style>\n${header}\n${sections}${empty}`,
  });
}

/** @param {string[]} argv @param {import('./core.mjs').CliContext} ctx */
export async function run(argv, ctx) {
  const { values } = parseCommandArgs(argv, { usage: 'visual gallery' });
  const featureDir = resolveFeatureDir(ctx, values);
  const root = resolveProjectRoot(ctx);
  const manifest = readManifest(featureDir); // also writes verification/.gitignore
  let teardown = null;
  const tdText = readText(path.join(verificationDir(featureDir), 'teardown.json'), { optional: true });
  if (tdText) {
    try { teardown = JSON.parse(tdText); } catch { teardown = null; }
  }
  let visual = null;
  try { visual = loadVisualConfig(ctx, featureDir).visual; } catch { visual = null; }
  const html = renderGallery({ manifest, teardown, root, featureDir, visual, title: `Visual verification — ${path.basename(featureDir)}` });
  const file = path.join(verificationDir(featureDir), 'index.html');
  atomicWrite(file, html);
  const rel = path.relative(root, file).split(path.sep).join('/');
  output(ctx, values, { text: `wrote ${rel}`, data: { file: rel, screens: Object.keys(manifest.screens ?? {}).length } });
  return 0;
}
