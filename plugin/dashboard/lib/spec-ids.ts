// Resolve requirement / acceptance ids (R1, AC2, AC1.3) to their definitions
// in a feature's spec.md.

export interface SpecId {
  text: string;
  /** Checkbox state when the spec line is `- [ ]` / `- [x]`. */
  done?: boolean;
}

const ID = '(?:AC|R)\\d+(?:\\.\\d+)*';
export const ID_RE = new RegExp(`\\b${ID}\\b`, 'g');
const DEF_RE = new RegExp(
  `^(\\s*)(?:[-*+]\\s+)?(?:\\[([ xX])\\]\\s*)?(\\*\\*)?(${ID})(\\*\\*)?(?:\\s*\\([^)]*\\))?(\\*\\*)?\\s*([:：.—–]|-\\s)?(\\*\\*)?\\s*(.*)$`,
);
const MAX_TEXT = 700;

/** id -> definition, first definition of an id wins. Continuation lines (indented) are joined. */
export function parseSpecIds(raw: string | null | undefined): Record<string, SpecId> {
  const out: Record<string, SpecId> = {};
  if (!raw) return out;
  let cur: { id: string; parts: string[]; done?: boolean } | null = null;
  const flush = () => {
    if (!cur) return;
    let text = cur.parts.join(' ').replace(/\s+/g, ' ').trim();
    if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT - 1).trimEnd() + '…';
    if (text && !out[cur.id]) out[cur.id] = cur.done === undefined ? { text } : { text, done: cur.done };
    cur = null;
  };
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(DEF_RE);
    if (m && m[9] && (m[7] || m[3] || m[5] || m[6])) {
      flush();
      cur = { id: m[4], parts: [m[9]], done: m[2] === undefined ? undefined : m[2] !== ' ' };
      continue;
    }
    if (!cur) continue;
    if (!line.trim() || /^#{1,6}\s/.test(line)) flush();
    else if (/^\s+\S/.test(line)) cur.parts.push(line.trim().replace(/^[-*+]\s+/, ''));
    else flush();
  }
  flush();
  return out;
}

/** Ids referenced anywhere in the given acceptance strings. */
export function collectIds(texts: (string | undefined)[]): string[] {
  const set = new Set<string>();
  for (const t of texts) for (const m of (t ?? '').matchAll(ID_RE)) set.add(m[0]);
  return [...set];
}

export interface AcceptanceRef {
  id: string;
  /** Ids listed in a trailing "(R1, R2)" group. */
  refs: string[];
  /** Any text after the id that is not a pure id group. */
  rest: string;
}

/** "AC2 (R1, R2, R3)" -> { id: AC2, refs: [R1,R2,R3] }; non-id items return null. */
export function parseAcceptanceRef(item: string): AcceptanceRef | null {
  const m = item.trim().match(new RegExp(`^(${ID})\\s*(.*)$`));
  if (!m) return null;
  const rest = m[2].trim();
  if (!rest) return { id: m[1], refs: [], rest: '' };
  const g = rest.match(/^\(([^()]*)\)$/);
  if (g) {
    const parts = g[1].split(/[,;]/).map((s) => s.trim()).filter(Boolean);
    if (parts.length && parts.every((p) => new RegExp(`^${ID}$`).test(p))) return { id: m[1], refs: parts, rest: '' };
  }
  return { id: m[1], refs: [], rest };
}
