import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { UsageError } from './core.mjs';

export function configRoot(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

export function validateAgentId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new UsageError(`invalid agent id '${id}'`);
  return id;
}

export function validateSessionId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(id)) throw new UsageError(`invalid session id '${id}'`);
  return id;
}

function projectDirs(root) {
  const pdir = path.join(root, 'projects');
  try {
    return fs.readdirSync(pdir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(pdir, d.name));
  } catch { return []; }
}

/** projects/*\/<sid>/subagents/agent-<id>.jsonl → path or null. */
export function findAgentTranscript(root, sessionId, agentId) {
  validateSessionId(sessionId); validateAgentId(agentId);
  for (const p of projectDirs(root)) {
    const f = path.join(p, sessionId, 'subagents', `agent-${agentId}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

/** Main session file(s) and subagent files for a session. */
export function findSessionFiles(root, sessionId) {
  validateSessionId(sessionId);
  const out = { main: [], agents: [] };
  for (const p of projectDirs(root)) {
    const main = path.join(p, `${sessionId}.jsonl`);
    if (fs.existsSync(main)) out.main.push(main);
    const sub = path.join(p, sessionId, 'subagents');
    try {
      for (const n of fs.readdirSync(sub)) if (/^agent-.+\.jsonl$/.test(n)) out.agents.push(path.join(sub, n));
    } catch { /* none */ }
  }
  return out;
}

const emptyTotals = () => ({ input: 0, output: 0, cache_read: 0, cache_write: 0, cache_write_1h: 0 });

/** Coerce a transcript usage field to a finite number (security S6). */
export function usageNum(v) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Per-model totals keyed by a transcript-controlled model string: a Map, so
 * `__proto__` / `constructor` are plain keys (security S6). toObject() turns
 * it into a plain object with own properties only (Object.fromEntries).
 */
export class ModelTotals {
  constructor() { this.map = new Map(); }
  /** Add a usage record `u` (fields coerced) under `model`. */
  add(model, u) {
    const key = typeof model === 'string' && model !== '' ? model : 'unknown';
    let bm = this.map.get(key);
    if (!bm) { bm = emptyTotals(); this.map.set(key, bm); }
    for (const k of Object.keys(bm)) bm[k] += usageNum(u?.[k]);
  }
  /** Merge a `{model: totals}` object (from another result). */
  addAll(byModel) {
    for (const [m, u] of Object.entries(byModel ?? {})) this.add(m, u);
  }
  toObject() { return Object.fromEntries(this.map); }
}

function createAccumulator(filter = {}) {
  const byId = new Map();
  let malformed = 0;
  let anon = 0;
  const [from, to] = filter.window || [];
  const fromT = from ? Date.parse(from) : null;
  const toT = to ? Date.parse(to) : null;
  return {
    add(line) {
      if (!line || !line.trim()) return;
      let o;
      try { o = JSON.parse(line); } catch { malformed++; return; }
      if (!o || o.type !== 'assistant' || !o.message || !o.message.usage) return;
      const m = o.message;
      if (m.model === '<synthetic>') return;
      if (filter.sidechain === false && o.isSidechain !== false) return;
      if (fromT !== null || toT !== null) {
        const t = Date.parse(o.timestamp);
        if (Number.isNaN(t) || (fromT !== null && t < fromT) || (toT !== null && t > toT)) return;
      }
      byId.set(m.id ?? `__anon${anon++}`, m);
    },
    result() {
      const total = emptyTotals();
      const by_model = new ModelTotals();
      for (const m of byId.values()) {
        const u = m.usage;
        const d = {
          input: usageNum(u.input_tokens),
          output: usageNum(u.output_tokens),
          cache_read: usageNum(u.cache_read_input_tokens),
          cache_write: usageNum(u.cache_creation_input_tokens),
          cache_write_1h: usageNum(u.cache_creation?.ephemeral_1h_input_tokens),
        };
        by_model.add(m.model, d);
        for (const k of Object.keys(d)) total[k] += d[k];
      }
      return { ...total, by_model: by_model.toObject(), malformed };
    },
  };
}

/** Pure: lines is an iterable of strings. filter: {sidechain:false, window:[from,to]} */
export function sumUsage(lines, { filter } = {}) {
  const acc = createAccumulator(filter);
  for (const l of lines) acc.add(l);
  return acc.result();
}

/** Streaming file reader: reads the file once. */
export async function sumUsageFile(file, { filter } = {}) {
  const acc = createAccumulator(filter);
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const l of rl) acc.add(l);
  return acc.result();
}

function mergeInto(a, b) {
  for (const k of Object.keys(emptyTotals())) a[k] += b[k];
  a.malformed += b.malformed;
  const merged = new ModelTotals();
  merged.addAll(a.by_model);
  merged.addAll(b.by_model);
  a.by_model = merged.toObject();
}

function childrenOf(dir, id) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return out; }
  for (const n of names) {
    const m = /^agent-(.+)\.meta\.json$/.exec(n);
    if (!m) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
      if (meta.parentAgentId === id && /^[A-Za-z0-9_-]{1,64}$/.test(m[1])) out.push(m[1]);
    } catch { /* ignore */ }
  }
  return out;
}

/** Strict ISO-8601 string → canonical `toISOString()`, else null (security W6). */
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/;
export function normIso(ts) {
  if (typeof ts !== 'string' || !ISO_RE.test(ts)) return null;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** First/last transcript `timestamp` of an agent (normalised ISO), or null when missing/none. */
export async function agentTimeRange(root, sessionId, agentId) {
  const file = findAgentTranscript(root, sessionId, agentId);
  if (!file) return null;
  let first = null; let last = null;
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const l of rl) {
    if (!l.trim()) continue;
    let ts;
    try { ts = JSON.parse(l)?.timestamp; } catch { continue; }
    const iso = normIso(ts);
    if (iso === null) continue;
    if (first === null) first = iso;
    last = iso;
  }
  return first === null ? null : { started_at: first, ended_at: last };
}

/** Usage of an agent plus all nested descendants. Returns null if transcript missing. */
export async function agentUsage(root, sessionId, agentId) {
  const file = findAgentTranscript(root, sessionId, agentId);
  if (!file) return null;
  const dir = path.dirname(file);
  const total = await sumUsageFile(file);
  const nested = [];
  const seen = new Set([agentId]);
  const queue = [agentId];
  while (queue.length) {
    for (const c of childrenOf(dir, queue.shift())) {
      if (seen.has(c)) continue;
      seen.add(c);
      const f = path.join(dir, `agent-${c}.jsonl`);
      if (!fs.existsSync(f)) continue;
      mergeInto(total, await sumUsageFile(f));
      nested.push(c);
      queue.push(c);
    }
  }
  return { ...total, nested };
}
