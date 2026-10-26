// Open-decisions block of spec.md (`## Open decisions` with `### D<n>: <question>`
// headings and 2-4 option bullets). Pure parsing, no I/O.

import { UsageError } from './core.mjs';

const REC = ' (Recommended)';

/** Lines of the `## Open decisions` section (fences skipped), or null when absent. */
function sectionLines(text) {
  if (typeof text !== 'string') return null;
  let fence = false;
  let inSection = false;
  let found = false;
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    if (/^##\s/.test(line)) {
      inSection = /^##\s+Open decisions\s*$/i.test(line);
      if (inSection) found = true;
      continue;
    }
    if (inSection) out.push(line);
  }
  return found ? out : null;
}

/** Lenient: true when any `### D<n>:` heading sits under `## Open decisions`. */
export function hasOpenDecisions(text) {
  const lines = sectionLines(text);
  return !!lines && lines.some((l) => /^###\s+D\d+\s*:/.test(l));
}

/**
 * Strict parse. Returns [] when the section or its decisions are absent;
 * throws UsageError on a malformed decision.
 * @param {string} text spec.md text
 * @returns {{id: string, question: string, options: {label: string, consequence: string, recommended: boolean}[], recommended: string}[]}
 */
export function parseOpenDecisions(text) {
  const lines = sectionLines(text);
  if (!lines) return [];
  const raw = [];
  let cur = null;
  for (const line of lines) {
    const h = /^###\s+(.*?)\s*$/.exec(line);
    if (h && !/^####/.test(line)) {
      const m = /^(D\d+)\s*:\s*(.*)$/.exec(h[1]);
      if (!m || !m[2]) throw new UsageError(`open decisions: heading '### ${h[1]}' must be '### D<n>: <question>'`);
      cur = { id: m[1], question: m[2], options: [] };
      raw.push(cur);
      continue;
    }
    if (!cur) continue;
    const b = /^\s*-\s+(.*?)\s*$/.exec(line);
    if (b) cur.options.push(b[1]);
  }
  const seen = new Set();
  return raw.map((d) => {
    if (seen.has(d.id)) throw new UsageError(`open decisions: duplicate decision id ${d.id}`);
    seen.add(d.id);
    if (d.options.length < 2 || d.options.length > 4) {
      throw new UsageError(`open decisions: ${d.id} has ${d.options.length} options (need 2-4)`);
    }
    const options = d.options.map((o) => {
      const i = o.indexOf(' — ');
      const label = i < 0 ? '' : o.slice(0, i).trim();
      const consequence = i < 0 ? '' : o.slice(i + 3).trim();
      if (!label || !consequence) throw new UsageError(`open decisions: ${d.id} option '${o}' must be '<label> — <consequence>'`);
      const rec = label.endsWith(REC);
      return { label: rec ? label.slice(0, -REC.length).trim() : label, consequence, rec };
    });
    const recs = options.filter((o) => o.rec).length;
    if (recs === 0) throw new UsageError(`open decisions: ${d.id} has no (Recommended) option`);
    if (recs > 1) throw new UsageError(`open decisions: ${d.id} has more than one (Recommended) option`);
    if (!options[0].rec) throw new UsageError(`open decisions: ${d.id} (Recommended) must be on the first option`);
    return {
      id: d.id,
      question: d.question,
      options: options.map((o, i) => ({ label: o.label, consequence: o.consequence, recommended: i === 0 })),
      recommended: options[0].label,
    };
  });
}
