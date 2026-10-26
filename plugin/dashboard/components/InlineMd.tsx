import type { ReactNode } from 'react';

// Minimal inline markdown: `code`, **bold**, *em*. Everything else is text.
const TOKEN_RE = /`([^`]+)`|\*\*([^*]+)\*\*|(?:^|(?<=[\s(]))\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g;

export function InlineMd({ text }: { text: string }) {
  const nodes: ReactNode[] = [];
  let last = 0;
  let k = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    const i = m.index ?? 0;
    if (i > last) nodes.push(text.slice(last, i));
    if (m[1] !== undefined)
      nodes.push(
        <code key={k++} className="mono text-[12px] px-1 py-px rounded bg-ink-50 text-ink-800">
          {m[1]}
        </code>,
      );
    else if (m[2] !== undefined) nodes.push(<strong key={k++}>{m[2]}</strong>);
    else nodes.push(<em key={k++}>{m[3]}</em>);
    last = i + m[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return <>{nodes}</>;
}
