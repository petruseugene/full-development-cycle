// Static report renderer (R21–R25 presentation, R27, R28). Pure: model in,
// HTML string out. No <script>, no event handlers, no external resources;
// every dynamic string goes through `esc`. The only clock-dependent text is
// the single "generated at" line.
//
//   renderIndex(model)                      -> index.html
//   renderFeature(feature, {generated_at})  -> <folder>.html

import { esc as escBase, page, githubHref, chip as chipBase, CSP_REPORT } from './html.mjs';

// `esc` from html.mjs maps & < > " '; additionally encode `=` so escaped payloads
// never contain a literal `onerror=` / `onload=` (AC27). Renders identically.
const esc = (s) => escBase(s).replace(/=/g, '&#61;');
const chip = (status, label) => chipBase(status, '').replace(/><\/span>$/, () => `>${esc(label ?? status)}</span>`);
const TITLE_SLOT = '\u0000title\u0000';
const doc = (title, body) => page({ title: TITLE_SLOT, csp: CSP_REPORT, body }).replace(TITLE_SLOT, () => esc(title));

// ---------------------------------------------------------------------------
// Deterministic formatting

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const arr = (v) => (Array.isArray(v) ? v : []);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

export function fmtUsd(v) {
  return isNum(v) ? `$${v.toFixed(2)}` : '—';
}

export function fmtTokens(v) {
  if (!isNum(v)) return '—';
  const r = Math.round(v * 10) / 10;
  return `${Number.isInteger(r) ? r.toFixed(0) : r.toFixed(1)}k`;
}

export function fmtDuration(s) {
  if (!isNum(s) || s < 0) return '—';
  const t = Math.round(s);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  const pad = (n) => String(n).padStart(2, '0');
  if (h > 0) return `${h}h ${pad(m)}m`;
  if (m > 0) return `${m}m ${pad(sec)}s`;
  return `${sec}s`;
}

/** ISO → "YYYY-MM-DD HH:MMZ" (UTC); unparsable values are shown escaped as-is. */
export function fmtTime(v) {
  const ms = typeof v === 'string' ? Date.parse(v) : NaN;
  if (Number.isNaN(ms)) return v == null || v === '' ? '—' : String(v);
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')}Z`;
}

const fmtCount = (v) => (isNum(v) ? String(v) : '—');

/** Relative page link for a feature folder; always `./`-prefixed and percent-encoded. */
export function featureHref(folder) {
  return `./${encodeURIComponent(String(folder ?? ''))}.html`;
}

/** Relative path from `.dev-cycle/report/` to the feature's gallery. */
export function galleryHref(folder) {
  return `../../docs/features/${encodeURIComponent(String(folder ?? ''))}/verification/index.html`;
}

// ---------------------------------------------------------------------------
// Shared fragments

const COLORS = {
  primary: '#5B5BF7', text: '#0F172A', muted: '#64748B', hairline: '#E5E7EB',
  ok: '#047857', warn: '#B45309', bad: '#B91C1C', wait: '#94A3B8', surface: '#FFFFFF',
};

const EXTRA_CSS = `<style>
.svgwrap svg{max-width:none;height:auto;display:block}
.trendwrap svg{width:100%;max-width:720px;height:auto;display:block}
.legend{display:flex;flex-wrap:wrap;gap:12px;margin:8px 0 0;padding:0;list-style:none;font-size:13px}
.kv{display:flex;flex-wrap:wrap;gap:4px 16px;margin:0 0 8px}
.wrap{overflow-wrap:break-word}
td.text{min-width:220px}
li .wrap,p .wrap,code.wrap{overflow-wrap:anywhere}
td.num,th.num{text-align:right;white-space:nowrap}
ul.plain{margin:0;padding-left:20px}
header.top{margin:0 0 12px}
@media (max-width:599px){
table.stack thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
table.stack,table.stack tbody,table.stack tr,table.stack td{display:block;width:100%}
table.stack tr{border-bottom:1px solid var(--hairline);padding:6px 0}
table.stack td{border:0;padding:2px 0;display:grid;grid-template-columns:96px minmax(0,1fr);gap:8px;text-align:left;white-space:normal;overflow-wrap:anywhere;min-width:0}
table.stack td::before{content:attr(data-label);color:var(--muted);font-family:var(--font);font-size:12px;font-weight:600}
table.stack td.text{min-width:0}
}
</style>`;

function card(title, inner, id) {
  return `<section class="card"${id ? ` id="${esc(id)}"` : ''}><h2>${esc(title)}</h2>\n${inner}\n</section>`;
}

/**
 * A table. `rows` are `<tr>` strings, or arrays of `td()` cells; with
 * `{stack: true}` array rows get a `data-label` per cell and the table turns
 * into stacked label/value cards below 600px (no inner horizontal scroll).
 */
function table(headers, rows, empty = 'None.', { stack = false } = {}) {
  if (rows.length === 0) return `<p class="muted">${esc(empty)}</p>`;
  const labels = headers.map((h) => (Array.isArray(h) ? h[0] : h));
  const th = headers.map((h) => {
    const [label, cls] = Array.isArray(h) ? h : [h, ''];
    return `<th scope="col"${cls ? ` class="${cls}"` : ''}>${esc(label)}</th>`;
  }).join('');
  const trs = rows.map((r) => (Array.isArray(r)
    ? `<tr>${r.map((cell, i) => (stack ? cell.replace(/^<td/, `<td data-label="${esc(labels[i] ?? '')}"`) : cell)).join('')}</tr>`
    : r));
  return `<div class="scroll"><table${stack ? ' class="stack"' : ''}><thead><tr>${th}</tr></thead><tbody>\n${trs.join('\n')}\n</tbody></table></div>`;
}

/** Escaped text with break opportunities after each `-` and `/` (slugs, branches, paths). */
const breakable = (s) => esc(s).replace(/[-/]/g, (c) => `${c}<wbr>`);
const slug = (folder) => breakable(folder);
const featureLink = (folder) => `<a class="wrap" href="${esc(featureHref(folder))}">${slug(folder)}</a>`;

const td = (html, cls) => `<td${cls ? ` class="${cls}"` : ''}>${html}</td>`;

function generatedLine(at) {
  return `<p class="muted">Generated at <span class="num">${esc(fmtTime(at))}</span></p>`;
}

function statusKey(status) {
  const s = String(status ?? '').toUpperCase();
  if (s.startsWith('DONE_WITH') || s.startsWith('NEEDS')) return 'warn';
  if (s.startsWith('DONE') || s === 'PASSED' || s === 'APPROVED') return 'ok';
  if (s.startsWith('BLOCK') || s.startsWith('FAIL') || s === 'CHANGES_REQUIRED') return 'bad';
  return 'neutral';
}

// ---------------------------------------------------------------------------
// Index

function trendSvg(trend) {
  // L/R leave room for the axis labels ("$12.34", "2546.5k tok"); PX/PY keep data
  // points (r=5) inside the plot so they never touch an axis or its label.
  const W = 640; const H = 220; const L = 64; const R = 80; const T = 16; const B = 36; const PX = 14; const PY = 12;
  const pts = arr(trend).filter((p) => p && typeof p === 'object');
  const meas = pts.filter((p) => p.measured === true && isNum(p.usd_est));
  const est = pts.filter((p) => p.measured !== true && isNum(p.tokens_k));
  const maxUsd = Math.max(0, ...meas.map((p) => p.usd_est)) || 1;
  const maxTok = Math.max(0, ...est.map((p) => p.tokens_k)) || 1;
  const n = pts.length;
  const x = (i) => (n <= 1 ? L + (W - L - R) / 2 : L + PX + (i * (W - L - R - 2 * PX)) / (n - 1));
  const y = (v, max) => T + PY + (H - T - B - 2 * PY) * (1 - v / max);
  const f = (v) => (Math.round(v * 10) / 10).toFixed(1);
  const parts = [];
  parts.push(`<line x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}" stroke="${COLORS.hairline}"/>`);
  parts.push(`<line x1="${L}" y1="${T}" x2="${L}" y2="${H - B}" stroke="${COLORS.hairline}"/>`);
  parts.push(`<line x1="${W - R}" y1="${T}" x2="${W - R}" y2="${H - B}" stroke="${COLORS.hairline}"/>`);
  parts.push(`<text x="${L - 4}" y="${T + 4}" text-anchor="end" font-size="10" fill="${COLORS.muted}">${esc(fmtUsd(maxUsd))}</text>`);
  parts.push(`<text x="${L - 4}" y="${H - B}" text-anchor="end" font-size="10" fill="${COLORS.muted}">$0</text>`);
  parts.push(`<text x="${W - R + 4}" y="${T + 4}" font-size="10" fill="${COLORS.muted}">${esc(fmtTokens(maxTok))} tok</text>`);
  parts.push(`<text x="${W - R + 4}" y="${H - B}" font-size="10" fill="${COLORS.muted}">0k</text>`);
  parts.push(`<text x="${L}" y="${H - 8}" font-size="10" fill="${COLORS.muted}">oldest</text>`);
  parts.push(`<text x="${W - R}" y="${H - 8}" text-anchor="end" font-size="10" fill="${COLORS.muted}">newest (by created)</text>`);
  pts.forEach((p, i) => {
    const cx = f(x(i));
    if (p.measured === true && isNum(p.usd_est)) {
      const cy = f(y(p.usd_est, maxUsd));
      parts.push(`<circle cx="${cx}" cy="${cy}" r="5" fill="${COLORS.primary}" stroke="${COLORS.primary}"><title>${esc(`${p.folder ?? ''} · measured · ${fmtUsd(p.usd_est)}`)}</title></circle>`);
    } else if (isNum(p.tokens_k)) {
      const cy = y(p.tokens_k, maxTok);
      parts.push(`<rect x="${f(x(i) - 5)}" y="${f(cy - 5)}" width="10" height="10" fill="${COLORS.surface}" stroke="${COLORS.warn}" stroke-width="2"><title>${esc(`${p.folder ?? ''} · estimated · ~${fmtTokens(p.tokens_k)} tok`)}</title></rect>`);
    }
  });
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Cost trend: measured dollars (filled circles) and estimated k-tokens (hollow squares), ordered by created date">${parts.join('')}</svg>`;
}

function renderTrend(trend) {
  const pts = arr(trend).filter((p) => p && typeof p === 'object');
  if (pts.length === 0) return '<p class="muted">No features with cost data.</p>';
  const legend = `<ul class="legend" aria-label="Legend">
<li><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="5" fill="${COLORS.primary}"/></svg> measured — USD (left axis)</li>
<li><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect x="1" y="1" width="10" height="10" fill="${COLORS.surface}" stroke="${COLORS.warn}" stroke-width="2"/></svg> estimated — k tokens (right axis)</li>
</ul>`;
  const rows = pts.map((p) => {
    const measured = p.measured === true;
    return [td(featureLink(p.folder)), td(esc(fmtTime(p.created)), 'num'), td(measured ? chip('ok', 'measured') : chip('estimated', 'estimated')), td(esc(measured ? fmtUsd(p.usd_est) : `~${fmtTokens(p.tokens_k)} tok`), 'num')];
  });
  return `<div class="trendwrap">${trendSvg(pts)}</div>\n${legend}\n${table(['Feature', ['Created', 'num'], 'Kind', ['Value', 'num']], rows, 'None.', { stack: true })}`;
}

function renderTracks(tracks) {
  const rows = arr(tracks).filter((t) => t && typeof t === 'object').map((t) => {
    const usd = isNum(t.median_usd) ? `${fmtUsd(t.median_usd)} <span class="muted">(n=${esc(fmtCount(t.usd_n))})</span>` : '—';
    return [td(esc(t.flow ?? '—')), td(esc(t.track ?? '—')), td(`${esc(fmtCount(t.n))}${t.small_sample ? ` ${chip('warn', 'small sample')}` : ''}`, 'num'), td(usd, 'num'), td(esc(isNum(t.median_tokens_k) ? `~${fmtTokens(t.median_tokens_k)}` : '—'), 'num'), td(esc(fmtDuration(t.median_wall_s)), 'num')];
  });
  return table(['Flow', 'Track', ['n', 'num'], ['Median $ (measured)', 'num'], ['Median k tok (est.)', 'num'], ['Median wall time', 'num']], rows, 'No features.', { stack: true });
}

function renderWaitingOwner(list) {
  const rows = arr(list).filter((w) => w && typeof w === 'object').map((w) => {
    const done = w.completed === true || w.done === true;
    const state = done ? chip('ok', 'done') : chip('warn', 'waiting');
    const task = w.task ?? w.n;
    // Open waits show no duration: an elapsed time would be clock-dependent text
    // outside the single "generated at" line (spec §5 Determinism). "Waiting since" carries it.
    const dur = done && isNum(w.duration_s) ? fmtDuration(w.duration_s) : '—';
    return [td(featureLink(w.folder)), td(esc(task == null ? '—' : `Task ${task}`)), td(breakable(w.title ?? ''), 'wrap'), td(state), td(esc(fmtTime(w.since)), 'num'), td(esc(dur), 'num')];
  });
  return table(['Feature', 'Task', 'Title', 'State', ['Waiting since', 'num'], ['Duration', 'num']], rows, 'Nobody is waiting for the owner.', { stack: true });
}

function renderMerges(list) {
  const rows = arr(list).filter((m) => m && typeof m === 'object').map((m) => {
    const state = String(m.state ?? (m.step || m.kind === 'post-merge' || m.kind === 'post_merge' ? 'unconfirmed' : 'unknown'));
    const href = githubHref(m.url);
    const what = m.step != null
      ? `post-merge step <code>${breakable(m.step)}</code>`
      : m.branch != null ? `branch <code>${breakable(m.branch)}</code>` : esc(m.kind ?? '—');
    return [td(featureLink(m.folder)), td(what, 'wrap'), td(chip(state === 'unconfirmed' ? 'warn' : state, state)), td(href ? `<a href="${esc(href)}" rel="noopener noreferrer">PR</a>` : m.reason ? `<span class="muted">${breakable(m.reason)}</span>` : '—')];
  });
  return table(['Feature', 'What', 'State', 'Link / note'], rows, 'No unconfirmed merges.', { stack: true });
}

function renderFeatureList(features) {
  const items = arr(features).filter((f) => f && typeof f === 'object').map((f) => {
    if (f.unreadable) {
      return `<li><span class="wrap">${slug(f.folder)}</span> — ${chip('bad', 'unreadable')} <span class="muted wrap">unreadable: ${esc(f.unreadable)}</span></li>`;
    }
    const meta = [f.flow, f.track].filter((v) => v != null && v !== '').map(String).join(' · ');
    return `<li>${featureLink(f.folder)}${meta ? ` <span class="muted">${esc(meta)}</span>` : ''}</li>`;
  });
  return items.length ? `<ul class="plain">\n${items.join('\n')}\n</ul>` : '<p class="muted">No features.</p>';
}

/** @param {{generated_at?: string, features?: object[], trend?: object[], tracks?: object[], waiting_owner?: object[], unconfirmed_merges?: object[]}} model */
export function renderIndex(model) {
  const m = obj(model);
  const body = [
    EXTRA_CSS,
    '<header class="top"><h1>dev-cycle report</h1>',
    generatedLine(m.generated_at),
    '</header>',
    card('Features', renderFeatureList(m.features), 'features'),
    card('Cost trend', renderTrend(m.trend), 'trend'),
    card('Track comparison', renderTracks(m.tracks), 'tracks'),
    card('Waiting for owner', renderWaitingOwner(m.waiting_owner), 'waiting-owner'),
    card('Unconfirmed merges', renderMerges(m.unconfirmed_merges), 'unconfirmed-merges'),
  ].join('\n');
  return doc('dev-cycle report', body);
}

// ---------------------------------------------------------------------------
// Feature page

const IMPLEMENT_RE = /^implement(\.|$)/;

/** Map timeline row → "fix cycle k" (k-th implement entry per phase key, k ≥ 2 → k−1). */
function fixCycleLabels(timeline) {
  const byIndex = [...timeline].map((r, i) => ({ r, i, key: isNum(r.index) ? r.index : i }))
    .sort((a, b) => a.key - b.key || a.i - b.i);
  const seen = new Map();
  const out = new Map();
  for (const { r } of byIndex) {
    if (typeof r.phase !== 'string' || !IMPLEMENT_RE.test(r.phase)) continue;
    const k = (seen.get(r.phase) ?? 0) + 1;
    seen.set(r.phase, k);
    if (k >= 2) out.set(r, k - 1);
  }
  return out;
}

function costLabel(r) {
  if (isNum(r.usd_est)) return fmtUsd(r.usd_est);
  if (isNum(r.tokens_k)) return `~${fmtTokens(r.tokens_k)} tok (est.)`;
  return '';
}

function barLabel(r, cycle) {
  const parts = [r.phase, r.subagent, r.status].filter((v) => v != null && v !== '').map(String);
  if (r.timing === 'point') parts.push('point');
  else parts.push(fmtDuration(isNum(r.duration_s) ? r.duration_s : (Date.parse(r.end) - Date.parse(r.start)) / 1000));
  const cost = costLabel(r);
  if (cost) parts.push(cost);
  if (r.timing === 'self-reported') parts.push('self-reported');
  if (cycle) parts.push(`fix cycle ${cycle}`);
  return parts.join(' · ');
}

const clip = (s, n) => (n <= 1 ? '' : s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1))}…`);

function timelineSvg(f) {
  const rows = arr(f.timeline).filter((r) => r && typeof r === 'object' && !Number.isNaN(Date.parse(r.start)) && !Number.isNaN(Date.parse(r.end)));
  const waits = arr(f.waits).filter((w) => w && typeof w === 'object' && !Number.isNaN(Date.parse(w.start)) && !Number.isNaN(Date.parse(w.end)));
  if (rows.length === 0) return null;
  const times = [...rows, ...waits].flatMap((r) => [Date.parse(r.start), Date.parse(r.end)]);
  const t0 = Math.min(...times);
  const t1 = Math.max(...times);
  const span = Math.max(1, t1 - t0);
  const laneCount = Math.max(1, isNum(f.lanes) ? f.lanes : 0, ...rows.map((r) => (isNum(r.lane) ? r.lane + 1 : 1)));
  const G = 72; const W = Math.min(2400, Math.max(960, rows.length * 90)); const P = 12;
  const ROW = 34; const TOP = 24;
  const H = TOP + (laneCount + (waits.length ? 1 : 0)) * ROW + 28;
  const x = (ms) => G + ((ms - t0) / span) * (W - G - P);
  const f1 = (v) => (Math.round(v * 10) / 10).toFixed(1);
  const cycles = fixCycleLabels(rows);
  const parts = [];
  parts.push(`<text x="${G}" y="14" font-size="11" fill="${COLORS.muted}">${esc(fmtTime(new Date(t0).toISOString()))}</text>`);
  parts.push(`<text x="${W - P}" y="14" text-anchor="end" font-size="11" fill="${COLORS.muted}">${esc(fmtTime(new Date(t1).toISOString()))} (+${esc(fmtDuration(span / 1000))})</text>`);

  for (let lane = 0; lane < laneCount; lane++) {
    const y = TOP + lane * ROW;
    parts.push(`<line x1="${G}" y1="${y + ROW - 2}" x2="${W - P}" y2="${y + ROW - 2}" stroke="${COLORS.hairline}"/>`);
    parts.push(`<text x="4" y="${y + 20}" font-size="11" fill="${COLORS.muted}">lane ${lane + 1}</text>`);
    const inLane = rows.filter((r) => (isNum(r.lane) ? r.lane : 0) === lane).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    inLane.forEach((r, i) => {
      const xs = x(Date.parse(r.start));
      const xe = x(Date.parse(r.end));
      const nextX = i + 1 < inLane.length ? x(Date.parse(inLane[i + 1].start)) : W - P;
      const label = barLabel(r, cycles.get(r));
      const color = { ok: COLORS.ok, bad: COLORS.bad, warn: COLORS.warn }[statusKey(r.status)] ?? COLORS.primary;
      const tip = `<title>${esc(`${label}${r.summary ? ` — ${r.summary}` : ''}`)}</title>`;
      if (r.timing === 'point') {
        parts.push(`<g><path d="M${f1(xs)} ${y + 4} l5 7 l-5 7 l-5 -7 z" fill="${color}"/>${tip}</g>`);
      } else {
        const w = Math.max(2, xe - xs);
        const dash = r.timing === 'self-reported' ? ' stroke-dasharray="3 2"' : '';
        parts.push(`<g><rect x="${f1(xs)}" y="${y + 4}" width="${f1(w)}" height="14" rx="3" fill="${color}" fill-opacity="0.25" stroke="${color}"${dash}/>${tip}</g>`);
      }
      const chars = Math.floor((nextX - xs - 4) / 6);
      const text = clip(label, chars);
      if (text) parts.push(`<text x="${f1(xs + 2)}" y="${y + 30}" font-size="10" fill="${COLORS.text}">${esc(text)}</text>`);
    });
  }
  if (waits.length) {
    const y = TOP + laneCount * ROW;
    parts.push(`<text x="4" y="${y + 20}" font-size="11" fill="${COLORS.muted}">waits</text>`);
    const sw = [...waits].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    sw.forEach((w, i) => {
      const xs = x(Date.parse(w.start));
      const xe = x(Date.parse(w.end));
      const label = `${w.kind === 'owner' ? `owner wait${w.task != null ? ` · Task ${w.task}` : ''}` : 'idle/wait'} · ${fmtDuration(w.duration_s)}`;
      const nextX = i + 1 < sw.length ? x(Date.parse(sw[i + 1].start)) : W - P;
      parts.push(`<g><rect x="${f1(xs)}" y="${y + 4}" width="${f1(Math.max(2, xe - xs))}" height="14" rx="3" fill="${COLORS.wait}" fill-opacity="0.35" stroke="${COLORS.wait}" stroke-dasharray="2 2"/><title>${esc(label)}</title></g>`);
      const text = clip(label, Math.floor((Math.max(nextX, xe) - xs - 4) / 6));
      if (text) parts.push(`<text x="${f1(xs + 2)}" y="${y + 30}" font-size="10" fill="${COLORS.text}">${esc(text)}</text>`);
    });
  }
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Timeline: ${esc(String(rows.length))} entries in ${esc(String(laneCount))} lanes">${parts.join('')}</svg>`;
}

function renderTimeline(f) {
  const svg = timelineSvg(f);
  if (!svg) return '<p class="muted">No timed history entries.</p>';
  const rows = arr(f.timeline).filter((r) => r && typeof r === 'object');
  const cycles = fixCycleLabels(rows);
  const legend = '<p class="muted">Solid bars: transcript timing. Dashed bars: self-reported (ts − duration). Diamonds: point (no duration). Grey: idle/wait and owner wait.</p>';
  const trs = rows.map((r) => {
    const timing = r.timing === 'transcript' ? 'transcript' : r.timing === 'point' ? 'point' : 'self-reported';
    const cyc = cycles.get(r);
    return `<tr>${td(esc(isNum(r.lane) ? r.lane + 1 : '—'), 'num')}${td(esc(r.phase ?? ''), 'wrap')}${td(esc(r.subagent ?? ''), 'wrap')}${td(chip(statusKey(r.status), r.status ?? '—'))}${td(esc(fmtTime(r.start)), 'num')}${td(esc(timing === 'point' ? '—' : fmtDuration(isNum(r.duration_s) ? r.duration_s : (Date.parse(r.end) - Date.parse(r.start)) / 1000)), 'num')}${td(esc(costLabel(r) || '—'), 'num')}${td(esc(timing))}${td(esc(cyc ? `fix cycle ${cyc}` : ''))}${td(esc(r.summary ?? ''), 'wrap text')}</tr>`;
  });
  return `<div class="svgwrap timeline">${svg}</div>\n${legend}\n${table([['Lane', 'num'], 'Phase', 'Subagent', 'Status', ['Start', 'num'], ['Duration', 'num'], ['Cost', 'num'], 'Timing', 'Fix cycle', 'Summary'], trs)}`;
}

function renderWaitsAndCycles(f) {
  const waits = arr(f.waits).filter((w) => w && typeof w === 'object').map((w) =>
    `<tr>${td(esc(w.kind === 'owner' ? 'owner wait' : 'idle/wait'))}${td(esc(w.task == null ? '—' : `Task ${w.task}`))}${td(esc(fmtTime(w.start)), 'num')}${td(esc(fmtTime(w.end)), 'num')}${td(esc(fmtDuration(w.duration_s)), 'num')}</tr>`);
  const cycles = arr(f.fix_cycles).filter((c) => c && typeof c === 'object').map((c) =>
    `<tr>${td(esc(typeof c.task === 'number' ? `Task ${c.task}` : c.task ?? '—'))}${td(esc(`fix cycle ${c.cycle ?? '?'}`))}${td(esc(costLabel(c) || '—'), 'num')}</tr>`);
  return `<h3>Waits</h3>\n${table(['Kind', 'Task', ['Start', 'num'], ['End', 'num'], ['Duration', 'num']], waits, 'No waits.')}\n<h3>Fix cycles</h3>\n${table(['Task', 'Cycle', ['Cost', 'num']], cycles, 'No fix cycles.')}`;
}

function renderPlanGroups(groups) {
  const list = arr(groups);
  if (list.length === 0) return '<p class="muted">No plan groups (no plan.md).</p>';
  const items = list.map((g, i) => `<li>Group ${i + 1}: ${esc(arr(g).map((n) => `Task ${n}`).join(', ') || '—')}</li>`);
  return `<ol class="plain">\n${items.join('\n')}\n</ol>`;
}

function renderWorktrees(list) {
  const rows = arr(list).filter((r) => r && typeof r === 'object').map((r) =>
    `<tr>${td(esc(r.mode ?? '—'))}${td(esc(arr(r.tasks).map((n) => `Task ${n}`).join(', ') || '—'))}${td(esc(r.touches_expanded ?? 0), 'num')}${td(esc(r.stray ?? 0), 'num')}${td(esc(r.conflicts ?? 0), 'num')}</tr>`);
  return table(['Mode', 'Tasks', ['Touches expanded', 'num'], ['Stray', 'num'], ['Conflicts', 'num']], rows, 'None.');
}

function costTable(title, map) {
  const rows = Object.entries(obj(map)).map(([k, v]) => {
    const r = obj(v);
    return `<tr>${td(esc(k), 'wrap')}${td(esc(fmtCount(r.calls)), 'num')}${td(esc(fmtUsd(r.usd_est)), 'num')}${td(esc(isNum(r.tokens_k) ? `~${fmtTokens(r.tokens_k)}` : '—'), 'num')}${td(esc(fmtCount(r.measured)), 'num')}${td(esc(fmtCount(r.estimated)), 'num')}</tr>`;
  });
  return `<h3>${esc(title)}</h3>\n${table([title.replace(/^By /, '').replace(/^./, (c) => c.toUpperCase()), ['Calls', 'num'], ['Measured $', 'num'], ['Est. k tokens', 'num'], ['Measured n', 'num'], ['Estimated n', 'num']], rows, 'No entries.')}`;
}

function renderCost(cost) {
  const c = obj(cost);
  const counts = obj(c.counts);
  return [
    `<p class="kv"><span>${chip('ok', 'measured')} entries: <span class="num">${esc(fmtCount(counts.measured ?? 0))}</span></span><span>${chip('estimated', 'estimated')} entries: <span class="num">${esc(fmtCount(counts.estimated ?? 0))}</span></span></p>`,
    costTable('By agent', c.by_agent),
    costTable('By model', c.by_model),
    costTable('By phase', c.by_phase),
  ].join('\n');
}

const AC_CHIP = { failing: 'bad', auto: 'ok', visual: 'ok', manual: 'warn', none: 'warn', unknown: 'neutral' };
const AC_ORDER = ['failing', 'auto', 'visual', 'manual', 'none', 'unknown'];

function renderAcMap(f) {
  const rows = arr(f.ac_map).filter((r) => r && typeof r === 'object');
  const counts = obj(f.ac_counts ?? f.ac_map_counts);
  const countLine = `<p class="kv">${AC_ORDER.map((k) => `<span>${chip(AC_CHIP[k], k)} <span class="num">${esc(fmtCount(isNum(counts[k]) ? counts[k] : rows.filter((r) => r.class === k).length))}</span></span>`).join('')}</p>`;
  const trs = rows.map((r) => {
    const id = r.ac ?? r.id;
    const label = typeof id === 'number' || /^\d+$/.test(String(id ?? '')) ? `AC${id}` : String(id ?? '—');
    const tasks = arr(r.tasks);
    const tests = arr(r.tests).length ? arr(r.tests) : r.evidence ? [`${r.source ? `${r.source}: ` : ''}${r.evidence}`] : [];
    const cls = String(r.class ?? 'unknown');
    return `<tr>${td(esc(label), 'num')}${td(esc(String(r.text ?? '').slice(0, 160)), 'wrap text')}${td(esc(tasks.length ? tasks.map((n) => `Task ${n}`).join(', ') : '—'))}${td(tests.length ? tests.map((t) => esc(t)).join('<br>') : '—', 'wrap')}${td(chip(AC_CHIP[cls] ?? 'neutral', cls))}</tr>`;
  });
  return `${countLine}\n${table([['AC', 'num'], 'Text', 'Tasks', 'Tests', 'Class'], trs, 'No acceptance criteria found in spec.md.')}`;
}

function renderGallery(f) {
  const g = obj(f.gallery);
  const path = `docs/features/${String(f.folder ?? '')}/verification/index.html`;
  if (g.exists !== true) {
    return `<p class="muted">No gallery. Expected at <code class="wrap">${esc(path)}</code>.</p>`;
  }
  const v = g.verdict;
  const status = typeof v === 'string' ? v : obj(v).status;
  const runTime = isNum(g.run_time_s) ? g.run_time_s : obj(v).run_time_s;
  const budget = isNum(g.budget_s) ? g.budget_s : obj(v).budget_s;
  return [
    `<p><a href="${esc(galleryHref(f.folder))}">Open verification gallery</a></p>`,
    `<p>Path: <code class="wrap">${esc(path)}</code></p>`,
    `<p class="kv"><span>Verdict: ${status ? chip(String(status).toLowerCase(), status) : '<span class="muted">none</span>'}</span><span>Run time: <span class="num">${esc(fmtDuration(runTime))}</span>${isNum(budget) ? ` <span class="muted">/ budget ${esc(fmtDuration(budget))}</span>` : ''}</span></p>`,
  ].join('\n');
}

/**
 * @param {object} feature one entry of model.features
 * @param {{generated_at?: string}} [opts]
 */
export function renderFeature(feature, { generated_at } = {}) {
  const f = obj(feature);
  const name = f.title ?? f.slug ?? f.folder ?? 'feature';
  const meta = [
    ['Folder', f.folder], ['Flow', f.flow], ['Track', f.track], ['Phase', f.current_phase], ['Branch', f.branch], ['Created', f.created == null ? null : fmtTime(f.created)],
  ].filter(([, v]) => v != null && v !== '').map(([k, v]) => `<span>${esc(k)}: <span class="wrap">${esc(v)}</span></span>`).join('');
  const head = `<header class="top"><p><a href="./index.html">← All features</a></p><h1 class="wrap">${esc(name)}</h1>\n<p class="kv muted">${meta}</p>\n${generatedLine(generated_at)}</header>`;
  if (f.unreadable) {
    const body = [EXTRA_CSS, head, card('Unreadable', `<p>${chip('bad', 'unreadable')} <span class="wrap">unreadable: ${esc(f.unreadable)}</span></p>`)].join('\n');
    return doc(`${name} — dev-cycle report`, body);
  }
  const body = [
    EXTRA_CSS,
    head,
    card('Timeline', renderTimeline(f), 'timeline'),
    card('Waits and fix cycles', renderWaitsAndCycles(f), 'waits'),
    card('Plan groups', renderPlanGroups(f.plan_groups), 'plan-groups'),
    ...(arr(f.worktrees).length > 0 ? [card('Worktrees', renderWorktrees(f.worktrees), 'worktrees')] : []),
    card('Cost', renderCost(f.cost), 'cost'),
    card('Acceptance criteria map', renderAcMap(f), 'ac-map'),
    card('Verification gallery', renderGallery(f), 'gallery'),
  ].join('\n');
  return doc(`${name} — dev-cycle report`, body);
}
