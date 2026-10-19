import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  AgentName,
  AgentRow,
  DashboardSnapshot,
  Feature,
  HistoryEvent,
  KPIs,
  Task,
  TaskStatus,
} from './types';
import { parseFeatureJson, parsePlanMd, parseReviewMd, parseSpecStatus, parseTestReportMd } from './parsers';
import { DASHBOARD_BUDGET_DOLLARS, DASHBOARD_COST_PER_KTOK } from './config';

function repoRoot(): string {
  const env = process.env.DASHBOARD_FEATURES_DIR;
  if (env && env.trim()) return path.resolve(env);
  const demo = process.env.DASHBOARD_DEMO === '1';
  const cwd = process.cwd();
  // From dashboard/ run, repo root is one up.
  const parent = path.resolve(cwd, '..');
  return demo
    ? path.join(cwd, 'fixtures', 'demo-features')
    : path.join(parent, 'docs', 'features');
}

function skillsRoot(): string {
  const env = process.env.DASHBOARD_SKILLS_DIR;
  if (env && env.trim()) return path.resolve(env);
  const parent = path.resolve(process.cwd(), '..');
  return path.join(parent, '.claude', 'skills');
}

async function readMaybe(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, 'utf8');
  } catch {
    return null;
  }
}

async function listSubdirs(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name);
  } catch {
    return [];
  }
}

function humanizeSlug(slug: string): string {
  return slug
    .replace(/^\d{4}-\d{2}-\d{2}-\d{2}h-\d{2}m-/, '')
    .split('-')
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

function deriveActiveAgents(meta: Feature['meta'], tasks: Task[]): AgentName[] {
  if (!meta) return [];
  const last = meta.history?.slice(-3) ?? [];
  const agents = new Set<AgentName>();
  for (const ev of last) {
    if (ev.status === 'running' || ev.status === 'in_progress') {
      agents.add(ev.subagent as AgentName);
    }
  }
  if (agents.size > 0) return [...agents];
  // Fallback: derive from current_phase
  const phaseAgent: Record<string, AgentName> = {
    discovery: 'discovery',
    spec: 'spec-writer',
    wireframe: 'wireframer',
    plan: 'plan-writer',
    implement: 'frontend-dev',
    review: 'code-reviewer',
    test: 'auto-tester',
    git: 'git-agent',
  };
  const a = phaseAgent[meta.current_phase];
  return a ? [a] : [];
}

function overallStatus(tasks: Task[], meta: Feature['meta']): TaskStatus {
  if (meta?.current_phase === 'done') return 'DONE';
  if (tasks.some((t) => t.status === 'BLOCKED')) return 'BLOCKED';
  if (tasks.some((t) => t.status === 'IN_PROGRESS')) return 'IN_PROGRESS';
  if (tasks.some((t) => t.status === 'IN_TESTING')) return 'IN_TESTING';
  if (tasks.length && tasks.every((t) => t.status === 'DONE')) return 'DONE';
  return 'TODO';
}

export async function loadFeatures(): Promise<Feature[]> {
  const root = repoRoot();
  const slugs = await listSubdirs(root);
  const out: Feature[] = [];

  for (const slug of slugs) {
    const folderPath = path.join(root, slug);
    const [featureRaw, planRaw, reviewRaw, testRaw, statRes] = await Promise.all([
      readMaybe(path.join(folderPath, 'feature.json')),
      readMaybe(path.join(folderPath, 'plan.md')),
      readMaybe(path.join(folderPath, 'review.md')),
      readMaybe(path.join(folderPath, 'test-report.md')),
      fs.stat(folderPath).catch(() => null),
    ]);
    const specRaw = await readMaybe(path.join(folderPath, 'spec.md'));
    const discoveryRaw = await readMaybe(path.join(folderPath, 'discovery.md'));
    const wireframeFiles = await listFiles(path.join(folderPath, 'wireframes'));

    const meta = featureRaw ? parseFeatureJson(featureRaw) : null;
    // R41: with no plan.md, fall back to a `## Tasks` section in spec.md.
    const taskSource = planRaw ?? (specRaw && /^## Tasks\s*$/m.test(specRaw) ? specRaw : null);
    const tasks = taskSource ? parsePlanMd(taskSource) : [];
    const reviews = reviewRaw ? parseReviewMd(reviewRaw) : [];
    const testReport = testRaw ? parseTestReportMd(testRaw) : null;

    // Annotate tasks with review cycle count + active agents
    for (const t of tasks) {
      const tReviews = reviews.filter((r) => r.taskId === t.id);
      const failed = tReviews.filter((r) => r.status === 'CHANGES_REQUIRED').length;
      if (failed > 0) t.reviewCycles = failed;
      if (t.status === 'BLOCKED' && tReviews.length >= 3) {
        t.blockerReason = '3 fix cycles exhausted';
      }
    }

    const id = slug;
    const title = humanizeSlug(slug);
    const updatedAt = statRes?.mtime?.toISOString() ?? new Date().toISOString();
    const active = deriveActiveAgents(meta, tasks);
    if (active.length && tasks.length) {
      const ip = tasks.find((t) => t.status === 'IN_PROGRESS' || t.status === 'IN_TESTING');
      if (ip) ip.activeAgents = active;
    }

    out.push({
      id,
      slug,
      title,
      folderPath,
      meta,
      tasks,
      reviews,
      testReport,
      hasSpec: !!specRaw,
      hasDiscovery: !!discoveryRaw,
      hasWireframes: wireframeFiles.length > 0,
      hasPlan: !!taskSource,
      specStatus: parseSpecStatus(specRaw),
      wireframeFiles,
      updatedAt,
      derived: {
        overallStatus: overallStatus(tasks, meta),
        progress: {
          done: tasks.filter((t) => t.status === 'DONE').length,
          total: tasks.length,
        },
        activeAgents: active,
      },
    });
  }

  out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return out;
}

async function listFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile() && e.name.endsWith('.html')).map((e) => e.name);
  } catch {
    return [];
  }
}

export function buildKPIs(features: Feature[]): KPIs {
  const allTasks = features.flatMap((f) => f.tasks);
  const tasksInFlight = allTasks.filter(
    (t) => t.status === 'IN_PROGRESS' || t.status === 'IN_TESTING',
  ).length;
  const blocked = allTasks.filter((t) => t.status === 'BLOCKED').length;

  const cycles = features
    .filter((f) => f.derived.overallStatus === 'DONE' && f.meta?.history?.length)
    .map((f) => totalDurationHours(f.meta!.history))
    .filter((h): h is number => h != null && h > 0);
  const avgCycleHours = cycles.length
    ? cycles.reduce((a, b) => a + b, 0) / cycles.length
    : null;

  const tokens_k = features.reduce((sum, f) => {
    const t = f.meta?.totals?.by_subagent ?? {};
    return sum + Object.values(t).reduce((s, x) => s + (x.tokens_k || 0), 0);
  }, 0);
  const dollars = +features
    .reduce((sum, f) => {
      const m = f.meta?.totals?.measured;
      if (m && Number(m.measured_entries) > 0) return sum + (Number(m.usd_est) || 0);
      const by = f.meta?.totals?.by_subagent ?? {};
      const k = Object.values(by).reduce((s, x) => s + (Number(x?.tokens_k) || 0), 0);
      return sum + k * DASHBOARD_COST_PER_KTOK;
    }, 0)
    .toFixed(2);

  const trends = buildTrends(features);

  return {
    activeFeatures: features.filter((f) => f.derived.overallStatus !== 'DONE').length,
    tasksInFlight,
    blocked,
    avgCycleHours,
    agentSpend: { dollars, tokens: Math.round(tokens_k * 1000), budget: DASHBOARD_BUDGET_DOLLARS },
    trends,
  };
}

function totalDurationHours(history: HistoryEvent[]): number | null {
  const secs = history.reduce((s, h) => s + (h.duration_s || 0), 0);
  return secs > 0 ? +(secs / 3600).toFixed(2) : null;
}

/**
 * Returns an array of `daysBack` UTC YYYY-MM-DD date strings, oldest -> newest,
 * with the last entry being today (UTC). Used for per-day trend bucketing.
 */
function bucketByDay(daysBack = 9): string[] {
  const out: string[] = [];
  const today = new Date();
  // Anchor at UTC midnight for the current day.
  const anchor = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const dayMs = 24 * 60 * 60 * 1000;
  for (let i = daysBack - 1; i >= 0; i--) {
    out.push(new Date(anchor - i * dayMs).toISOString().slice(0, 10));
  }
  return out;
}

function dayKey(ts: string | undefined | null): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function buildTrends(features: Feature[]): KPIs['trends'] {
  const days = bucketByDay(9);

  // activeFeatures: per day, count features created on or before that day
  // whose overall status (as-of-today) is not DONE. This is the documented
  // R6 approximation since we lack per-day phase snapshots.
  const activeFeatures = days.map((day) =>
    features.filter((f) => {
      const created = dayKey(f.meta?.created);
      if (!created) return false;
      if (created > day) return false;
      return f.derived.overallStatus !== 'DONE';
    }).length,
  );

  // blocked: per day, count of BLOCKED history events whose ts falls on that day.
  const blockedByDay = new Map<string, number>();
  for (const f of features) {
    for (const ev of f.meta?.history ?? []) {
      if (ev.status !== 'BLOCKED') continue;
      const k = dayKey(ev.ts);
      if (!k) continue;
      blockedByDay.set(k, (blockedByDay.get(k) ?? 0) + 1);
    }
  }
  const blocked = days.map((day) => blockedByDay.get(day) ?? 0);

  // cycleHours: per day, mean cycle hours among DONE features whose latest
  // history entry falls on that day. Carry forward previous day's value when
  // empty so the sparkline has no visual gaps. Initial day defaults to 0.
  const cycleByDay = new Map<string, number[]>();
  for (const f of features) {
    if (f.derived.overallStatus !== 'DONE') continue;
    const history = f.meta?.history ?? [];
    if (!history.length) continue;
    const latest = history[history.length - 1];
    const k = dayKey(latest?.ts);
    if (!k) continue;
    const hours = totalDurationHours(history);
    if (hours == null) continue;
    const arr = cycleByDay.get(k) ?? [];
    arr.push(hours);
    cycleByDay.set(k, arr);
  }
  const cycleHours: number[] = [];
  let last = 0;
  for (const day of days) {
    const arr = cycleByDay.get(day);
    if (arr && arr.length) {
      const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
      last = +mean.toFixed(2);
    }
    cycleHours.push(last);
  }

  return { activeFeatures, blocked, cycleHours };
}

export function buildTicker(features: Feature[]): HistoryEvent[] {
  const all: HistoryEvent[] = [];
  for (const f of features) {
    for (const h of f.meta?.history ?? []) {
      all.push({ ...h, message: `${h.subagent} → ${h.status} on ${f.title}` });
    }
  }
  return all.sort((a, b) => (a.ts < b.ts ? 1 : -1)).slice(0, 12);
}

function parseSkillFrontmatter(raw: string): { name?: string; description?: string } {
  const match = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const body = match[1];
  const out: { name?: string; description?: string } = {};
  for (const line of body.split(/\r?\n/)) {
    const m = line.match(/^(name|description)\s*:\s*(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[m[1] as 'name' | 'description'] = val;
  }
  return out;
}

export async function buildAgents(features: Feature[]): Promise<AgentRow[]> {
  const root = skillsRoot();
  const dirs = await listSubdirs(root);
  const rows = new Map<string, AgentRow>();

  for (const dir of dirs) {
    const skillPath = path.join(root, dir, 'SKILL.md');
    const raw = await readMaybe(skillPath);
    if (raw == null) continue;
    const fm = parseSkillFrontmatter(raw);
    const name = fm.name ?? dir;
    rows.set(name, {
      name,
      description: fm.description ?? '',
      calls: 0,
      approved: null,
      retried: 0,
      time_s: 0,
      tokens_k: 0,
      last_used: null,
    });
  }

  for (const f of features) {
    const by = f.meta?.totals?.by_subagent;
    if (!by) continue;
    for (const [agent, t] of Object.entries(by)) {
      const row = rows.get(agent);
      if (!row) continue;
      const calls = Number(t?.calls) || 0;
      row.calls += calls;
      row.retried += Number(t?.retried) || 0;
      row.time_s += Number(t?.time_s) || 0;
      row.tokens_k += Number(t?.tokens_k) || 0;
      if (typeof t?.approved === 'number') {
        row.approved = (row.approved ?? 0) + t.approved;
      }
      if (calls > 0 && (row.last_used == null || f.id > row.last_used)) {
        row.last_used = f.id;
      }
    }
  }

  return [...rows.values()];
}

export async function buildSnapshot(): Promise<DashboardSnapshot> {
  const features = await loadFeatures();
  const agents = await buildAgents(features);
  return {
    features,
    kpis: buildKPIs(features),
    ticker: buildTicker(features),
    agents,
    generatedAt: new Date().toISOString(),
  };
}

export function featuresRootPath(): string {
  return repoRoot();
}
