import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  AgentName,
  AgentRow,
  DashboardSnapshot,
  Feature,
  HistoryEvent,
  Task,
  TaskStatus,
} from './types';
import { collectIds, parseSpecIds } from './spec-ids';
import { parseFeatureJson, parsePlanMd, parseReviewMd, parseSpecStatus, parseTestReportMd } from './parsers';
import { buildKPIs, closeTasksOfClosedFeature } from './kpis';

export { buildKPIs };

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
    const polishRaw = await readMaybe(path.join(folderPath, 'polish.md'));
    const discoveryRaw = await readMaybe(path.join(folderPath, 'discovery.md'));
    const wireframeFiles = await listFiles(path.join(folderPath, 'wireframes'));

    const meta = featureRaw ? parseFeatureJson(featureRaw) : null;
    // R41: with no plan.md, fall back to a `## Tasks` section in spec.md.
    // Polish batches: polish.md is the task source when neither exists (read-only).
    const taskSource =
      planRaw ?? (specRaw && /^## Tasks\s*$/m.test(specRaw) ? specRaw : null) ?? polishRaw;
    const tasks = closeTasksOfClosedFeature(taskSource ? parsePlanMd(taskSource) : [], meta);
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
      specIds: resolveSpecIds(specRaw, tasks),
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

function resolveSpecIds(specRaw: string | null, tasks: Task[]): Feature['specIds'] {
  if (!specRaw) return undefined;
  const wanted = collectIds(tasks.map((t) => t.acceptance));
  if (!wanted.length) return undefined;
  const all = parseSpecIds(specRaw);
  const out: NonNullable<Feature['specIds']> = {};
  for (const id of wanted) if (all[id]) out[id] = all[id];
  return Object.keys(out).length ? out : undefined;
}
