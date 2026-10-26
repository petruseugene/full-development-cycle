// Plain-text excerpt for task cards. Task descriptions come from plan.md and
// often start with the metadata block (Tag / Touches / ...) that the card
// already renders as chips, plus raw markdown.

// Fields shown elsewhere on the card or in the modal; Files / Acceptance /
// Steps are brief scaffolding, not a description.
const META_KEYS = ['Tag', 'Touches', 'Depends on', 'Size', 'Model', 'Wireframes', 'Files', 'Acceptance', 'Steps'];

const META_RE = new RegExp(
  `\\*\\*(?:${META_KEYS.join('|')}):?\\*\\*:?[\\s\\S]*?(?=\\*\\*[A-Za-z][A-Za-z ]*(?::\\*\\*|\\*\\*:)|$)`,
  'gi',
);

export function cleanExcerpt(raw: string | undefined | null): string {
  if (!raw) return '';
  const lines = raw
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(META_RE, ' ')
        .replace(/^\s*[-*+]\s+\[[ xX]\]\s*/, '') // checkbox marker
        .replace(/^\s*(?:#{1,6}|>|[-*+]|\d+\.)\s+/, '') // heading / quote / bullet
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // links / images
        .replace(/`+([^`]*)`+/g, '$1')
        .replace(/(\*\*|__)(.*?)\1/g, '$2')
        .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,;:!?]|$)/g, '$1$2')
        .replace(/[*`]+/g, '')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((line) => line && !/^(?:-{3,}|\*{3,}|_{3,})$/.test(line));
  return lines.join(' ').trim();
}

/** Cut `text` to at most `max` chars on a word boundary, appending an ellipsis. */
export function truncateWords(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  const base = sp > max * 0.5 ? cut.slice(0, sp) : cut;
  return base.replace(/[\s.,;:!?-]+$/, '') + '…';
}

/**
 * Full prose of a task body for the modal: metadata fields, Steps section,
 * headings and rules removed; paragraphs kept; inline markdown left intact.
 */
export function fullProse(body: string | undefined | null): string {
  if (!body) return '';
  const beforeSteps = body.split(/\*\*Steps:\*\*/i)[0];
  return beforeSteps
    .replace(META_RE, ' ')
    .split(/\r?\n/)
    .filter((l) => !/^\s*(?:#{1,6}\s|-{3,}\s*$|\*{3,}\s*$|_{3,}\s*$)/.test(l))
    .join('\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
