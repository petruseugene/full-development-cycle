// Pure spec/task/coverage consistency check (spec R7-R12). No file I/O.
//
//   analyzeSpec({specText, tasksText, reportText}) -> { errors, warnings, checked }

import { parseSpecAcs, parseAcIds } from './spec-acs.mjs';
import { parsePlan, isOwnerTask } from './plan.mjs';
import { parseAcCoverage } from './report-ac.mjs';

const OPEN_STATUSES = new Set(['TODO', 'IN PROGRESS', 'BLOCKED']);
const AC = (n) => `AC${n}`;

/** Supersede cycles among defined ACs, one entry per distinct cycle. */
function findCycles(acs) {
  const cycles = [];
  const seen = new Set();
  const stack = [];
  const done = new Set();
  const visit = (n) => {
    const ac = acs.get(n);
    if (!ac || !ac.superseded || ac.removed || done.has(n)) return;
    const at = stack.indexOf(n);
    if (at >= 0) {
      const members = stack.slice(at);
      const key = [...members].sort((a, b) => a - b).join(',');
      if (!seen.has(key)) { seen.add(key); cycles.push(members); }
      return;
    }
    stack.push(n);
    for (const t of ac.superseded.by) visit(t);
    stack.pop();
    done.add(n);
  };
  for (const n of acs.keys()) visit(n);
  return cycles;
}

/**
 * @param {{specText: string, tasksText?: string|null, reportText?: string|null}} input
 * @returns {{errors: object[], warnings: object[], checked: {tasks: boolean, coverage: boolean}}}
 */
export function analyzeSpec({ specText, tasksText = null, reportText = null }) {
  const { acs, duplicates, unscoped, markerErrors } = parseSpecAcs(specText);
  const errors = [];
  const warnings = [];
  const err = (code, message, extra = {}) => errors.push({ code, message, ...extra });
  const warn = (code, message, extra = {}) => warnings.push({ code, message, ...extra });

  for (const d of duplicates) {
    err('duplicate-ac', `${AC(d.n)} is defined more than once (lines ${d.lines.join(', ')})`, { ac: AC(d.n) });
  }
  for (const m of markerErrors) err('bad-marker', `${AC(m.n)} line ${m.line}: ${m.problem}`, { ac: AC(m.n) });
  for (const ac of acs.values()) {
    if (!ac.superseded) continue;
    for (const t of ac.superseded.by) {
      if (!acs.has(t)) err('missing-target', `${AC(ac.n)} is superseded by ${AC(t)}, which is not defined`, { ac: AC(ac.n) });
    }
  }
  for (const cyc of findCycles(acs)) {
    err('supersede-cycle', `supersede cycle: ${[...cyc, cyc[0]].map(AC).join(' → ')}`, { ac: AC(cyc[0]) });
  }

  const checked = { tasks: false, coverage: false };
  if (tasksText !== null && tasksText !== undefined) {
    checked.tasks = true;
    const referenced = new Set();
    for (const t of parsePlan(tasksText)) {
      const ids = parseAcIds(t.acceptanceRaw || '');
      if (ids.length === 0 && !isOwnerTask(t)) {
        warn('task-no-ac', `task ${t.n} lists no AC in **Acceptance:**`, { task: t.n });
      }
      for (const n of ids) {
        referenced.add(n);
        const ac = acs.get(n);
        if (!ac) {
          err('unknown-ac', `task ${t.n} references ${AC(n)}, which is not defined in spec.md`, { ac: AC(n), task: t.n });
        } else if (ac.superseded && !ac.removed) {
          const to = ac.superseded.by.map(AC).join(', ');
          if (OPEN_STATUSES.has(t.status)) {
            err('superseded-ref', `task ${t.n} (${t.status}) references ${AC(n)}, superseded → ${to}`, { ac: AC(n), task: t.n });
          } else {
            warn('superseded-ref-done', `task ${t.n} (${t.status}) references ${AC(n)}, superseded → ${to}`, { ac: AC(n), task: t.n });
          }
        }
      }
    }
    for (const ac of acs.values()) {
      if (!ac.superseded && !ac.removed && !referenced.has(ac.n)) {
        warn('ac-no-task', `${AC(ac.n)} is referenced by no task`, { ac: AC(ac.n) });
      }
    }
  }

  if (reportText !== null && reportText !== undefined) {
    const { entries } = parseAcCoverage(reportText);
    if (entries.some((e) => e.source !== 'legacy')) {
      checked.coverage = true;
      const covered = new Set(entries.filter((e) => e.status !== 'none').map((e) => e.ac));
      for (const ac of acs.values()) {
        if (!ac.superseded && !ac.removed && !covered.has(ac.n)) {
          warn('ac-no-test', `${AC(ac.n)} has no test coverage in test-report.md`, { ac: AC(ac.n) });
        }
      }
    }
  }

  for (const u of unscoped) {
    warn('ac-unscoped', `${AC(u.n)} at line ${u.line} is outside any Acceptance Criteria section`, { ac: AC(u.n) });
  }
  return { errors, warnings, checked };
}
