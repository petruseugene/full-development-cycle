import { assertSameOrigin } from '@/lib/csrf';
import { NextResponse } from 'next/server';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadFeatures } from '@/lib/features';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Strict task-line regex. Inlined verbatim per plan.md Task 1 (R6).
 *
 * Do NOT import the broader parser regex from `dashboard/lib/parsers.ts` —
 * this appender requires the strict shape from spec R6 to compute the next
 * task number deterministically.
 */
const STRICT_TASK_LINE_RE =
  /^- \[(?:TODO|IN PROGRESS|IN_PROGRESS|DONE|BLOCKED|IN TESTING|IMPL-DONE|IN REVIEW)\] \*\*Task (\d+)\*\* /;

const ALLOWED_TAGS = new Set(['frontend', 'backend', 'mixed', 'infra', 'owner', 'content']);
const MAX_TITLE_LEN = 100;
const MAX_DESCRIPTION_LEN = 1000;

type ValidatedBody = {
  title: string;
  tag: 'frontend' | 'backend' | 'mixed' | 'infra' | 'owner' | 'content';
  description: string | null;
};

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

function notFound(message: string) {
  return NextResponse.json({ error: message }, { status: 404 });
}

function validateBody(raw: unknown): ValidatedBody | NextResponse {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return badRequest('invalid json');
  }
  const body = raw as Record<string, unknown>;

  // title
  if (typeof body.title !== 'string') {
    return badRequest('Title is required.');
  }
  const trimmedTitle = body.title.trim();
  if (trimmedTitle.length === 0) {
    return badRequest('Title is required.');
  }
  if (/[\r\n]/.test(trimmedTitle)) {
    return badRequest('Title must be a single line.');
  }
  if (trimmedTitle.length > MAX_TITLE_LEN) {
    return badRequest('Title must be 100 characters or fewer.');
  }

  // tag
  if (typeof body.tag !== 'string' || !ALLOWED_TAGS.has(body.tag)) {
    return badRequest('Tag must be one of frontend, backend, mixed, infra, owner, content.');
  }
  const tag = body.tag as ValidatedBody['tag'];

  // description (optional)
  let description: string | null = null;
  if (body.description !== undefined && body.description !== null) {
    if (typeof body.description !== 'string') {
      return badRequest('Description must be a string.');
    }
    if (body.description.length > MAX_DESCRIPTION_LEN) {
      return badRequest('Description must be 1000 characters or fewer.');
    }
    description = body.description;
  }

  return { title: trimmedTitle, tag, description };
}

/**
 * Compute next task number N by scanning plan.md line-by-line.
 *
 * Per R6: `N = max(captured integers) + 1`. If no lines match, `N = 1`.
 */
function computeNextTaskNumber(planContents: string): number {
  let max = 0;
  const lines = planContents.split('\n');
  for (const line of lines) {
    const m = STRICT_TASK_LINE_RE.exec(line);
    if (m) {
      const n = Number.parseInt(m[1], 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return max + 1;
}

/**
 * Insert the new task list-item line at the bottom of the existing `## Tasks`
 * list (per R11). Returns the new full file contents.
 *
 * Rules:
 * - Locate the `## Tasks` header.
 * - Find the last contiguous list-item line (`/^- \[/`) under it. Insert the
 *   new line immediately after that last list-item.
 * - If `## Tasks` is empty (header present, no list items): insert immediately
 *   after the blank line that follows the `## Tasks` header.
 * - Never insert *after* a trailing blank line — the new line stays inside the
 *   `## Tasks` section.
 */
function insertTaskListItem(planContents: string, newLine: string): string {
  const lines = planContents.split('\n');
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === '## Tasks') {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) {
    // No `## Tasks` section — append the new line as a new section at the end.
    // The spec assumes the section exists for an existing plan.md, but we
    // remain defensive: create a minimal section so the result is still
    // parser-correct.
    const trailing = planContents.endsWith('\n') ? '' : '\n';
    return `${planContents}${trailing}\n## Tasks\n\n${newLine}`;
  }

  // Find the end of the `## Tasks` section: first line at index > headerIdx
  // that begins with `## ` (next top-level section) or end of file.
  let sectionEnd = lines.length;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) {
      sectionEnd = i;
      break;
    }
  }

  // Within [headerIdx + 1, sectionEnd), find the last list-item line.
  let lastListItemIdx = -1;
  for (let i = headerIdx + 1; i < sectionEnd; i++) {
    if (/^- \[/.test(lines[i])) {
      lastListItemIdx = i;
    }
  }

  // The new line content (without trailing `\n`, since `lines.join('\n')` adds
  // separators between elements).
  const newLineNoLf = newLine.endsWith('\n') ? newLine.slice(0, -1) : newLine;

  if (lastListItemIdx !== -1) {
    // Insert immediately after the last list-item.
    lines.splice(lastListItemIdx + 1, 0, newLineNoLf);
  } else {
    // No list items in the section. Insert after the blank line that follows
    // the `## Tasks` header. Convention: `## Tasks\n\n` — header then blank.
    // Place the new line at headerIdx + 2 (after header + blank).
    let insertAt = Math.min(headerIdx + 2, sectionEnd);

    // If the next line is the next top-level section header (i.e. there is
    // no existing blank-line separator between us and `## Task details`),
    // add a trailing blank line so the one-blank-line gap between sections
    // is preserved.
    const needsTrailingBlank =
      insertAt < lines.length && lines[insertAt].startsWith('## ');
    if (needsTrailingBlank) {
      lines.splice(insertAt, 0, newLineNoLf, '');
    } else {
      // If we're at the very end of the file and the array's final element
      // is the trailing-newline marker (''), step back one slot so the
      // resulting file still ends with a single LF.
      if (insertAt === lines.length && lines.length > 0 && lines[lines.length - 1] === '') {
        insertAt = lines.length - 1;
      }
      lines.splice(insertAt, 0, newLineNoLf);
    }
  }

  return lines.join('\n');
}

/**
 * Append the `### Task N: <title>` section to `## Task details` (per R12, R13,
 * AC16, AC17). Only called when description is provided and non-empty after
 * trim.
 */
function appendTaskDetailsSection(
  planContents: string,
  taskNumber: number,
  title: string,
  description: string,
): string {
  const sectionHeader = `### Task ${taskNumber}: ${title}`;
  const sectionBody = description.endsWith('\n') ? description : `${description}\n`;

  const lines = planContents.split('\n');

  // Find `## Task details` header.
  let detailsHeaderIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === '## Task details') {
      detailsHeaderIdx = i;
      break;
    }
  }

  if (detailsHeaderIdx === -1) {
    // No `## Task details` section — append a new top-level section at the
    // end of the file, preceded by a single blank line, containing only the
    // new `### Task N` subsection (per AC17).
    const baseEndsWithLf = planContents.endsWith('\n');
    const base = baseEndsWithLf ? planContents : `${planContents}\n`;
    // We want: <existing>\n\n## Task details\n\n### Task N: <title>\n\n<body>
    return `${base}\n## Task details\n\n${sectionHeader}\n\n${sectionBody}`;
  }

  // Find the end of the `## Task details` section.
  let sectionEnd = lines.length;
  for (let i = detailsHeaderIdx + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) {
      sectionEnd = i;
      break;
    }
  }

  // Insert the new subsection at the end of the section content, separated
  // from the previous block by a single blank line. Find the last non-empty
  // line within the section.
  let lastContentIdx = detailsHeaderIdx;
  for (let i = detailsHeaderIdx + 1; i < sectionEnd; i++) {
    if (lines[i].trim() !== '') lastContentIdx = i;
  }

  // Build the new subsection as an array of lines:
  //   '' (blank-line separator)
  //   '### Task N: <title>'
  //   '' (blank line between header and body)
  //   ...body lines (body trailing '\n' produces a trailing '' from split)
  const bodyLines = sectionBody.split('\n');
  // Drop the trailing '' from split so the joined section ends with a single
  // '\n' at the section boundary (the next line in `lines` adds another).
  const newBlock: string[] = ['', sectionHeader, '', ...bodyLines.slice(0, -1)];

  lines.splice(lastContentIdx + 1, 0, ...newBlock);

  return lines.join('\n');
}

export async function POST(
  req: Request,
  { params }: { params: { id: string } },
) {
  const csrf = assertSameOrigin(req, { requireJson: true });
  if (csrf) return csrf;

  // R2: feature resolution via loadFeatures (no raw path.join of URL segment).
  const features = await loadFeatures();
  const feature = features.find((f) => f.id === params.id);
  if (!feature) {
    return notFound('feature not found');
  }

  // R3: JSON-parse body inside try/catch.
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return badRequest('invalid json');
  }

  // R4: body validation.
  const validated = validateBody(raw);
  if (validated instanceof NextResponse) return validated;
  const { title, tag, description } = validated;

  // R5: resolve the task file: plan.md, else spec.md with a `## Tasks` section.
  let planPath = path.join(feature.folderPath, 'plan.md');
  let planContents: string;
  try {
    planContents = await fs.readFile(planPath, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      const msg = e instanceof Error ? e.message : String(e);
      return NextResponse.json({ error: msg }, { status: 500 });
    }
    const specPath = path.join(feature.folderPath, 'spec.md');
    try {
      const specContents = await fs.readFile(specPath, 'utf8');
      if (!/^## Tasks\s*$/m.test(specContents)) {
        return notFound('No task list (plan.md or spec.md ## Tasks)');
      }
      planPath = specPath;
      planContents = specContents;
    } catch (e2) {
      if ((e2 as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return notFound('No task list (plan.md or spec.md ## Tasks)');
      }
      const msg = e2 instanceof Error ? e2.message : String(e2);
      return NextResponse.json({ error: msg }, { status: 500 });
    }
  }

  // R6: compute next task number N.
  const taskNumber = computeNextTaskNumber(planContents);

  // R10, R14: build the appended task list-item line (LF only, exact byte
  // format).
  const newTaskLine = `- [TODO] **Task ${taskNumber}** (${tag}): ${title}\n`;

  // R11: insert into `## Tasks`.
  let next = insertTaskListItem(planContents, newTaskLine);

  // R12, R13: when description is provided and non-empty after trim, append
  // `### Task N: <title>` section under `## Task details`.
  if (description !== null) {
    const trimmedDescription = description.trim();
    if (trimmedDescription.length > 0) {
      next = appendTaskDetailsSection(next, taskNumber, title, description);
    }
  }

  // R9: single fs.writeFile of the full next-version string.
  try {
    await fs.writeFile(planPath, next, 'utf8');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  // R7: success response. R8: no 409. R28: no watcherHub.publish — chokidar
  // handles refresh.
  return NextResponse.json({ task_number: taskNumber });
}
