import matter from 'gray-matter';
import type {
  Task,
  TaskStatus,
  TaskTag,
  ReviewVerdict,
  TestReport,
  FeatureJson,
} from './types';

const STATUS_MAP: Record<string, TaskStatus> = {
  TODO: 'TODO',
  'IN PROGRESS': 'IN_PROGRESS',
  'IN_PROGRESS': 'IN_PROGRESS',
  DOING: 'IN_PROGRESS',
  'IN TESTING': 'IN_TESTING',
  'IN_TESTING': 'IN_TESTING',
  TESTING: 'IN_TESTING',
  'IMPL-DONE': 'IN_TESTING',
  'IN REVIEW': 'IN_TESTING',
  BLOCKED: 'BLOCKED',
  DONE: 'DONE',
};

const STACK_TOKENS = ['frontend', 'backend', 'mixed', 'infra'];

/** Split on commas/whitespace, exact (case-insensitive) token compare. */
function parseTagTokens(raw: string): {
  tag: TaskTag;
  owner: boolean;
  content: boolean;
  stackless: boolean;
} {
  const tokens = raw
    .toLowerCase()
    .split(/[\s,]+/)
    .map((t) => t.replace(/^[(\[`*:]+|[)\]`*:]+$/g, ''))
    .filter(Boolean);
  const stack = tokens.find((t) => STACK_TOKENS.includes(t));
  return {
    tag: (stack as TaskTag) || 'mixed',
    owner: tokens.includes('owner'),
    content: tokens.includes('content'),
    stackless: !stack,
  };
}

/**
 * Parse plan.md into a list of Task objects.
 *
 * Recognized line shape (per plan-writer skill):
 *   - [TODO] **Task 1** (backend): <name>
 */
export function parsePlanMd(raw: string): Task[] {
  const { content } = matter(raw);
  const tasks: Task[] = [];
  const lines = content.split(/\r?\n/);

  const detailHeaderRe = /^###\s+Task\s+(\d+)\s*:?\s*(.+?)(?:\s*`?\[(TODO|IN PROGRESS|IN_PROGRESS|IN TESTING|IN_TESTING|IMPL-DONE|IN REVIEW|BLOCKED|DONE)\]`?)?\s*$/i;
  const taskLineRe =
    /^[-*]\s*\[(TODO|IN[_ ]PROGRESS|DOING|IN[_ ]TESTING|TESTING|IMPL-DONE|IN[_ ]REVIEW|BLOCKED|DONE)\]\s*\*\*Task\s*(\d+)\*\*\s*(?:\(([^)]+)\))?\s*[:\-]?\s*(.+)$/i;

  for (const line of lines) {
    const m = line.match(taskLineRe);
    if (!m) continue;
    const statusKey = m[1].toUpperCase().replace('_', ' ');
    const idx = parseInt(m[2], 10);
    const parsedTag = parseTagTokens(m[3] || '');
    const title = m[4].trim();
    tasks.push({
      id: `T${idx}`,
      index: idx,
      title,
      tag: parsedTag.tag,
      owner: parsedTag.owner,
      content: parsedTag.content,
      stackless: parsedTag.stackless,
      status: STATUS_MAP[statusKey] || 'TODO',
    });
  }

  let currentDetailIdx: number | null = null;
  let currentBuf: string[] = [];
  const detailMap = new Map<number, string>();
  for (const line of lines) {
    const dh = line.match(detailHeaderRe);
    if (dh) {
      if (currentDetailIdx != null) {
        detailMap.set(currentDetailIdx, currentBuf.join('\n').trim());
      }
      currentDetailIdx = parseInt(dh[1], 10);
      currentBuf = [];
      if (dh[3]) {
        const s = STATUS_MAP[dh[3].toUpperCase().replace('_', ' ')] || 'TODO';
        const t = tasks.find((x) => x.index === currentDetailIdx);
        if (t && t.status === 'TODO') t.status = s;
      }
      continue;
    }
    if (currentDetailIdx != null) currentBuf.push(line);
  }
  if (currentDetailIdx != null) detailMap.set(currentDetailIdx, currentBuf.join('\n').trim());

  for (const t of tasks) {
    const body = detailMap.get(t.index);
    if (!body) continue;
    const tagM = body.match(/\*\*Tag:\*\*[ \t]*([^\n]+)/i);
    if (tagM) {
      const pt = parseTagTokens(tagM[1]);
      if (pt.owner) t.owner = true;
      if (pt.content) t.content = true;
      if (!pt.stackless && t.stackless) {
        t.tag = pt.tag;
        t.stackless = false;
      }
    }
    const filesM = body.match(/\*\*Files:\*\*\s*([^\n]+)/i);
    if (filesM) t.files = filesM[1].split(/[,;]/).map((s) => s.trim()).filter(Boolean);
    const accM = body.match(/\*\*Acceptance:\*\*\s*([\s\S]*?)(?=\*\*Steps:\*\*|$)/i);
    if (accM) t.acceptance = accM[1].trim();
    const stepM = body.match(/\*\*Steps:\*\*([\s\S]*?)$/i);
    if (stepM) {
      t.steps = stepM[1]
        .split(/\r?\n/)
        .map((l) => l.replace(/^\s*-\s*\[[ x]\]\s*/, '').trim())
        .filter((l) => l && !l.startsWith('#'));
    }
    const firstPara = body
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .find((p) => p && !/^\*\*(Files|Acceptance|Steps):/i.test(p));
    if (firstPara && !t.description) t.description = firstPara.slice(0, 240);
  }

  return tasks.sort((a, b) => a.index - b.index);
}

/**
 * Parse review.md — appended per-task by code-reviewer.
 *
 * Sections shaped like:
 *   ## Task <N> · cycle <K>  — APPROVED | CHANGES_REQUIRED
 *   - L42: Prefer `useThemeToken` over `useToken`.
 */
export function parseReviewMd(raw: string): ReviewVerdict[] {
  const verdicts: ReviewVerdict[] = [];
  const sectionRe =
    /^##\s+Task\s+(\d+)(?:\s*[·\-]\s*cycle\s*(\d+))?\s*[—–-]?\s*(APPROVED|CHANGES_REQUIRED)/i;
  const lines = raw.split(/\r?\n/);
  let active: ReviewVerdict | null = null;
  for (const line of lines) {
    const m = line.match(sectionRe);
    if (m) {
      if (active) verdicts.push(active);
      active = {
        taskId: `T${m[1]}`,
        cycle: m[2] ? parseInt(m[2], 10) : 1,
        status: m[3].toUpperCase() as 'APPROVED' | 'CHANGES_REQUIRED',
        findings: [],
      };
      continue;
    }
    if (!active) continue;
    const f = line.match(/^\s*[-*]\s*(?:`?(L\d+)`?\s*[:\-]\s*)?(.+)$/);
    if (f) {
      const comment = f[2].trim();
      if (comment) active.findings.push({ line: f[1], comment });
    }
  }
  if (active) verdicts.push(active);
  return verdicts;
}

/**
 * Parse test-report.md. Tries YAML frontmatter from the report contract first,
 * then falls back to body inspection.
 */
export function parseTestReportMd(raw: string): TestReport {
  const fm = matter(raw);
  const data = fm.data as { status?: string; failures_count?: number };
  const cases: { name: string; status: 'pass' | 'fail' | 'running' }[] = [];
  const visualDiffs: { name: string; status: 'pass' | 'diff' | 'fail' }[] = [];

  for (const line of fm.content.split(/\r?\n/)) {
    const c = line.match(/^[-*]\s*\[?\s*(pass|fail|running|✓|✗|x)\s*\]?\s*(.+?)(?:\s+[—\-]\s+(.+))?$/i);
    if (c) {
      const raw = c[1].toLowerCase();
      const status = raw === '✓' ? 'pass' : raw === '✗' || raw === 'x' ? 'fail' : (raw as 'pass' | 'fail' | 'running');
      cases.push({ name: c[2].trim(), status });
    }
    const v = line.match(/visual-diff[:\s]*(?:\S+\s*[—\-]\s*)?(\d+)\s*\/\s*(\d+)/i);
    if (v) {
      const total = parseInt(v[2], 10);
      const pass = parseInt(v[1], 10);
      for (let i = 0; i < pass; i++) visualDiffs.push({ name: `bp-${i + 1}`, status: 'pass' });
      for (let i = pass; i < total; i++) visualDiffs.push({ name: `bp-${i + 1}`, status: 'diff' });
    }
  }

  return {
    status:
      data.status === 'PASSED' || data.status === 'FAILED'
        ? data.status
        : cases.some((c) => c.status === 'fail')
          ? 'FAILED'
          : 'PASSED',
    failures_count: data.failures_count ?? cases.filter((c) => c.status === 'fail').length,
    cases: cases.length ? cases : undefined,
    visualDiffs: visualDiffs.length ? visualDiffs : undefined,
  };
}

/**
 * Read the YAML frontmatter `status:` of spec.md and strip brackets, so
 * `[TODO]` -> `TODO`. Returns null on null input / no frontmatter / no status.
 */
export function parseSpecStatus(raw: string | null): string | null {
  if (typeof raw !== 'string') return null;
  try {
    const data = matter(raw).data as { status?: unknown };
    const v = data?.status;
    if (typeof v === 'string') {
      const s = v.replace(/^[\s\[]+|[\s\]]+$/g, '').trim();
      return s || null;
    }
    if (Array.isArray(v) && v.length) {
      const s = String(v[0]).trim();
      return s || null;
    }
    return null;
  } catch {
    return null;
  }
}

export function parseFeatureJson(raw: string): FeatureJson | null {
  try {
    return JSON.parse(raw) as FeatureJson;
  } catch {
    return null;
  }
}
