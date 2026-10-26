// Composition check engine for `visual check`: hierarchy/DOM parsers and the
// pure evaluateChecks() that turns a screen's checks into results.
//
// Rule: a value computed by the CLI (from boxes or pixels) always wins; a
// vision --measure only fills a check the CLI could not compute.
import { UsageError } from './core.mjs';

const EPS = 1e-9;
const CHECK_TYPES = ['support', 'scale', 'overlap', 'tap', 'colors'];

const round = (n) => Math.round(n * 1e6) / 1e6;
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

function asObject(input, label) {
  if (typeof input !== 'string') return input;
  try { return JSON.parse(input); }
  catch (e) { throw new UsageError(`${label}: invalid JSON (${e.message})`); }
}

const BOUNDS_RE = /^\s*\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]\s*\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]\s*$/;

/** Walk a Maestro `hierarchy` JSON tree. Returns Map<id, {x,y,width,height}>. */
export function parseMaestroHierarchy(input) {
  const root = asObject(input, 'hierarchy');
  const boxes = new Map();
  const stack = [root];
  let guard = 0;
  while (stack.length && guard++ < 200000) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) { for (let i = node.length - 1; i >= 0; i--) stack.push(node[i]); continue; }
    const attrs = node.attributes && typeof node.attributes === 'object' ? node.attributes : node;
    const m = typeof attrs.bounds === 'string' ? BOUNDS_RE.exec(attrs.bounds) : null;
    if (m) {
      const [x1, y1, x2, y2] = m.slice(1).map(Number);
      if (x2 >= x1 && y2 >= y1) {
        const box = { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
        for (const key of ['resource-id', 'accessibilityText', 'id']) {
          const id = attrs[key];
          if (typeof id === 'string' && id && !boxes.has(id)) boxes.set(id, box);
        }
      }
    }
    if (Array.isArray(node.children)) for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
  }
  return boxes;
}

/** Read `{elements:{id:{x,y,width,height}}}`. Returns Map<id, box>. */
export function parseDomRects(input) {
  const root = asObject(input, 'dom rects');
  const boxes = new Map();
  const els = root && typeof root === 'object' ? root.elements : null;
  if (!els || typeof els !== 'object' || Array.isArray(els)) return boxes;
  for (const [id, r] of Object.entries(els)) {
    if (!r || typeof r !== 'object') continue;
    const { x, y, width, height } = r;
    if (![x, y, width, height].every(finite) || width < 0 || height < 0) continue;
    boxes.set(id, { x, y, width, height });
  }
  return boxes;
}

/** Parse `<check>:<subject>=<number>`. Throws UsageError on malformed / non-finite. */
export function parseMeasure(text) {
  const s = String(text ?? '');
  const colon = s.indexOf(':');
  const eq = s.lastIndexOf('=');
  if (colon <= 0 || eq <= colon + 1 || eq === s.length - 1) {
    throw new UsageError(`bad --measure '${s}': expected <check>:<subject>=<number>`);
  }
  const check = s.slice(0, colon);
  const subject = s.slice(colon + 1, eq);
  const raw = s.slice(eq + 1).trim();
  if (!CHECK_TYPES.includes(check)) throw new UsageError(`bad --measure '${s}': unknown check '${check}'`);
  const value = raw === '' ? NaN : Number(raw);
  if (!Number.isFinite(value)) throw new UsageError(`bad --measure '${s}': value must be a finite number`);
  return { check, subject, value };
}

// ---- colour -------------------------------------------------------------

function srgbToLab(r, g, b) {
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const R = lin(r), G = lin(g), B = lin(b);
  const X = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047;
  const Y = 0.2126729 * R + 0.7151522 * G + 0.072175 * B;
  const Z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f(X), fy = f(Y), fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** Percentage of pixels within CIE76 deltaE <= maxDe of `hex`. */
export function colorPct(png, hex, maxDe) {
  const [tr, tg, tb] = hexToRgb(hex);
  const target = srgbToLab(tr, tg, tb);
  const { data, channels, width, height } = png;
  const total = width * height;
  const limit = maxDe * maxDe;
  const cache = new Map();
  let count = 0;
  let lastKey = -1, lastHit = false;
  for (let i = 0, n = total * channels; i < n; i += channels) {
    const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    let hit;
    if (key === lastKey) hit = lastHit;
    else {
      hit = cache.get(key);
      if (hit === undefined) {
        const [L, a, b] = srgbToLab(data[i], data[i + 1], data[i + 2]);
        hit = (L - target[0]) ** 2 + (a - target[1]) ** 2 + (b - target[2]) ** 2 <= limit;
        if (cache.size < 200000) cache.set(key, hit);
      }
      lastKey = key; lastHit = hit;
    }
    if (hit) count++;
  }
  return total ? (count / total) * 100 : 0;
}

// ---- evaluation ---------------------------------------------------------

function elementSpec(screen, name) {
  const e = screen.elements?.[name];
  if (typeof e === 'string') return { id: e, foot: 0, support: 0 };
  if (e && typeof e === 'object') {
    return { id: e.id, foot: (e.foot_offset_pct ?? 0) / 100, support: (e.support_offset_pct ?? 0) / 100 };
  }
  return { id: name, foot: 0, support: 0 };
}

function overlapArea(a, b) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** Documented keys of a profile check, per type (R1). Anything else is unknown. */
export const CHECK_KEYS = Object.freeze({
  support: ['type', 'element', 'on'],
  scale: ['type', 'a', 'b', 'expect'],
  overlap: ['type', 'a', 'b'],
  tap: ['type', 'elements'],
  colors: ['type'],
});

/** Keys of `check` that R1 does not define for its type (empty for an unknown type). */
export function unknownCheckKeys(check) {
  if (!check || typeof check !== 'object' || !Object.hasOwn(CHECK_KEYS, check.type)) return [];
  return Object.keys(check).filter((k) => !CHECK_KEYS[check.type].includes(k));
}

/**
 * evaluateChecks(screen, opts) -> [{type, subject, measured, expected, tolerance, source, result}]
 *   screen: profile screen ({elements, checks, ...})
 *   opts.visual: profile.visual defaults (tolerance_pct, tap_min_pt, forbidden_colors, color_delta_e, color_min_pct)
 *   opts.boxes: Map<id, box> from a parser; opts.boxSource: 'hierarchy' | 'dom'
 *   opts.png: decodePng result (or null when no pixels were read)
 *   opts.measures: [{check, subject, value}] from parseMeasure
 */
export function evaluateChecks(screen, opts = {}) {
  const visual = opts.visual || {};
  const boxes = opts.boxes instanceof Map ? opts.boxes : new Map();
  const boxSource = opts.boxSource === 'dom' ? 'dom' : 'hierarchy';
  const measures = opts.measures || [];
  const png = opts.png || null;
  const results = [];

  // Colour subjects are hex strings: compare case-insensitively (`#FF00FF` == `#ff00ff`).
  const sameSubject = (type, a, b) => (type === 'colors' ? String(a).toLowerCase() === String(b).toLowerCase() : a === b);
  const measureFor = (type, subject) => measures.find((m) => m.check === type && sameSubject(type, m.subject, subject));
  const box = (name) => boxes.get(elementSpec(screen, name).id);

  for (const check of screen?.checks || []) {
    // Tolerances come from profile.visual only (R1); per-check keys outside
    // CHECK_KEYS are not honoured, so an undocumented override has no effect.
    const tolPct = finite(visual.tolerance_pct) ? visual.tolerance_pct : 10;
    const T = tolPct / 100;
    const push = (subject, measured, expected, tolerance, source, result) => results.push({
      type: check.type, subject, measured: measured === null ? null : round(measured), expected, tolerance, source, result,
    });

    if (check.type === 'support') {
      const subject = check.element;
      const A = box(check.element), S = box(check.on);
      const judge = (gapFrac) => Math.abs(gapFrac) <= T + EPS;
      if (A && S && A.height > 0) {
        const a = elementSpec(screen, check.element), s = elementSpec(screen, check.on);
        const gap = (A.y + A.height - a.foot * A.height) - (S.y + s.support * S.height);
        const cx = A.x + A.width / 2;
        const inside = cx >= S.x - EPS && cx <= S.x + S.width + EPS;
        push(subject, gap / A.height, 0, tolPct, boxSource, judge(gap / A.height) && inside ? 'pass' : 'fail');
      } else {
        const m = measureFor('support', subject);
        if (m) push(subject, m.value, 0, tolPct, 'vision', judge(m.value) ? 'pass' : 'fail');
        else push(subject, null, 0, tolPct, boxSource, 'unmeasured');
      }
    } else if (check.type === 'scale') {
      const subject = `${check.a}/${check.b}`;
      const expect = finite(check.expect) ? check.expect : 1;
      const A = box(check.a), B = box(check.b);
      const judge = (ratio) => Math.abs(ratio / expect - 1) <= T + EPS;
      if (A && B && B.height > 0) {
        const ratio = A.height / B.height;
        push(subject, ratio, expect, tolPct, boxSource, judge(ratio) ? 'pass' : 'fail');
      } else {
        const m = measureFor('scale', subject);
        if (m) push(subject, m.value, expect, tolPct, 'vision', judge(m.value) ? 'pass' : 'fail');
        else push(subject, null, expect, tolPct, boxSource, 'unmeasured');
      }
    } else if (check.type === 'overlap') {
      const subject = `${check.a}/${check.b}`;
      const A = box(check.a), B = box(check.b);
      if (A && B) {
        const area = overlapArea(A, B);
        const small = Math.min(A.width * A.height, B.width * B.height);
        push(subject, small > 0 ? area / small : (area > 0 ? 1 : 0), 0, 0, boxSource, area === 0 ? 'pass' : 'fail');
      } else {
        const m = measureFor('overlap', subject);
        if (m) push(subject, m.value, 0, 0, 'vision', m.value === 0 ? 'pass' : 'fail');
        else push(subject, null, 0, 0, boxSource, 'unmeasured');
      }
    } else if (check.type === 'tap') {
      const names = Array.isArray(check.elements) ? check.elements : [];
      const subject = names.join(',');
      const min = visual.tap_min_pt;
      const found = names.map(box);
      if (!finite(min) || !names.length) { push(subject, null, min ?? null, 0, boxSource, 'unmeasured'); continue; }
      if (found.every(Boolean)) {
        const least = Math.min(...found.map((b) => Math.min(b.width, b.height)));
        push(subject, least, min, 0, boxSource, least >= min - EPS ? 'pass' : 'fail');
      } else {
        const m = measureFor('tap', subject);
        if (m) push(subject, m.value, min, 0, 'vision', m.value >= min - EPS ? 'pass' : 'fail');
        else push(subject, null, min, 0, boxSource, 'unmeasured');
      }
    } else if (check.type === 'colors') {
      const deltaE = finite(visual.color_delta_e) ? visual.color_delta_e : 10;
      const minPct = finite(visual.color_min_pct) ? visual.color_min_pct : 0.1;
      const usable = png && png.data && !png.unsupported && !png.error;
      for (const hex of visual.forbidden_colors || []) {
        const verdict = (pct) => (pct >= minPct - EPS ? 'fail' : 'pass');
        if (usable) {
          const pct = colorPct(png, hex, deltaE);
          push(hex, pct, minPct, deltaE, 'pixels', verdict(pct));
        } else {
          const m = measureFor('colors', hex);
          if (m) push(hex, m.value, minPct, deltaE, 'vision', verdict(m.value));
          else push(hex, null, minPct, deltaE, 'pixels', 'unmeasured');
        }
      }
    }
  }
  return results;
}
