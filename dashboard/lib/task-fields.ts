// Parsing helpers for the structured fields of a plan/spec task section
// (Files / Acceptance / Steps). Separators inside (), [], {} and `code`
// spans are not separators.

/** Split on top-level `,` / `;` only. */
export function splitTopLevel(text: string, seps = ',;'): string[] {
  const out: string[] = [];
  let depth = 0;
  let inCode = false;
  let cur = '';
  for (const ch of text) {
    if (ch === '`') inCode = !inCode;
    else if (!inCode) {
      if ('([{'.includes(ch)) depth++;
      else if (')]}'.includes(ch)) depth = Math.max(0, depth - 1);
      else if (depth === 0 && seps.includes(ch)) {
        out.push(cur);
        cur = '';
        continue;
      }
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

const BULLET_RE = /^\s*(?:[-*+]|\d+[.)])\s+/;

/** Acceptance block -> items. Bullets are one item each; plain lines split at top level. */
export function parseAcceptanceItems(raw: string | undefined): string[] {
  if (!raw) return [];
  const items: string[] = [];
  let lastBullet = false;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim() || /^\s*(?:-{3,}|\*{3,})\s*$/.test(line)) {
      lastBullet = false;
      continue;
    }
    if (BULLET_RE.test(line)) {
      items.push(line.replace(BULLET_RE, '').trim());
      lastBullet = true;
    } else if (lastBullet && /^\s+/.test(line)) {
      items[items.length - 1] += ' ' + line.trim();
    } else {
      items.push(...splitTopLevel(line));
      lastBullet = false;
    }
  }
  return items.filter(Boolean);
}

/** Files line -> raw items (one per file, annotation kept). */
export function parseFilesList(raw: string): string[] {
  return splitTopLevel(raw);
}

export interface FileItem {
  path: string;
  note: string;
}

/** "`a/b.ts` (modify: `x` ~l.5, `y`)" -> { path: "a/b.ts", note: "modify: `x` ~l.5, `y`" } */
export function parseFileItem(item: string): FileItem {
  let s = item.trim().replace(BULLET_RE, '');
  let path: string;
  const bt = s.match(/^`([^`]+)`\s*/);
  if (bt) {
    path = bt[1].trim();
    s = s.slice(bt[0].length);
  } else {
    const m = s.match(/^[^\s(]+/);
    path = (m ? m[0] : s).replace(/^`|`$/g, '');
    s = s.slice(m ? m[0].length : s.length).trim();
  }
  const paren = s.match(/^\(([\s\S]*)\)\s*$/);
  const note = (paren ? paren[1] : s).trim();
  return { path, note };
}

export interface StepItem {
  text: string;
  done: boolean;
}

export function parseStepItems(block: string): StepItem[] {
  const out: StepItem[] = [];
  for (const l of block.split(/\r?\n/)) {
    const m = l.match(/^\s*[-*+]\s*\[([ xX])\]\s*(.*)$/);
    if (m) out.push({ text: m[2].trim(), done: m[1] !== ' ' });
    else if (out.length && /^\s{2,}\S/.test(l) && !BULLET_RE.test(l)) out[out.length - 1].text += ' ' + l.trim();
  }
  return out.filter((s) => s.text);
}
