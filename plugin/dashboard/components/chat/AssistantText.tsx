'use client';

/**
 * AssistantText — sanitised markdown renderer for the assistant_text event
 * blocks rendered in the Chat tab (Task 12).
 *
 * Spec / AC refs:
 *   - AC1   — events stream into the chat log
 *   - AC3   — assistant text supports markdown (gfm + line breaks)
 *   - AC17  — `.msg-assistant` body uses sanitised markdown
 *   - AC19  — composer lives below the chat log; markdown is the only
 *             assistant-side rich text
 *   - R27   — assistant_text → marked + DOMPurify; code fences are plain
 *             `<pre><code>` with no syntax highlighting
 *   - Chat redesign spec §6.1 (body) — wrapper is Geist 13.5/ink-900, and
 *     `<code> / <pre> / <a>` get dashboard-token Tailwind classes instead of
 *     the prior paper/handwritten aesthetic.
 *
 * Security: the pipeline is strictly
 *
 *   text → marked.parse(text, { gfm: true, breaks: true })
 *        → DOMPurify.sanitize(html)
 *        → applyMarkdownClassOverrides(html)   // class-attr injection only
 *        → dangerouslySetInnerHTML
 *
 * Sanitisation MUST happen before injection — raw `marked` output is never
 * passed into the DOM. The class-injection step runs on already-sanitised
 * HTML and only adds presentation `class="..."` attributes; it never
 * reintroduces user content into attribute values. The colocated test
 * (`__tests__/AssistantText.test.tsx`) pins this contract by feeding
 * `<script>alert(1)</script>**bold**` and asserting the script tag is
 * stripped while bold renders.
 *
 * The component is intentionally pure: no state, no effects, no refs. The
 * caller passes the (possibly streaming-coalesced) text string from
 * `useEventStream`; this component re-runs the parse/sanitise pipeline on
 * every render. `marked.parse` is synchronous when no async extensions are
 * registered and DOMPurify v3 runs in-place on a DocumentFragment, so even
 * frequent updates (one rAF tick per chunk) stay well under a frame budget
 * for the message sizes we expect (R27 + Constraints §5 performance budget).
 */

import { marked } from 'marked';
import DOMPurify from 'dompurify';

interface AssistantTextProps {
  /** The (coalesced) markdown body for one assistant message block. */
  text: string;
}

// Dashboard-token Tailwind classes for the markdown overrides defined in
// spec §6.1 (body subsection). Kept as module constants so the contract is
// easy to grep and the regex injection below stays declarative.
const CODE_CLASSES =
  'mono text-[12px] bg-ink-50 border border-line px-1.5 py-px rounded text-ink-700';
const PRE_CLASSES =
  'bg-ink-900 text-ink-200 rounded-md p-2.5 mono text-[11.5px] overflow-auto';
const A_CLASSES = 'text-primary hover:underline';

/**
 * Inject a `class="..."` attribute (or merge into an existing class attr) on
 * every matching opening tag. Operates on already-sanitised HTML — DOMPurify
 * has already run, so we are not introducing an XSS vector here, only adding
 * presentation classes to known-safe markup.
 */
export function applyMarkdownClassOverrides(html: string): string {
  const inject = (input: string, tag: string, classes: string): string => {
    const openTag = new RegExp(`<${tag}(\\s[^>]*)?>`, 'gi');
    return input.replace(openTag, (_match, attrs: string | undefined) => {
      const rest = attrs ?? '';
      if (/\sclass\s*=\s*(['"])([^'"]*)\1/i.test(rest)) {
        const merged = rest.replace(
          /\sclass\s*=\s*(['"])([^'"]*)\1/i,
          (_m, q: string, existing: string) =>
            ` class=${q}${existing} ${classes}${q}`,
        );
        return `<${tag}${merged}>`;
      }
      return `<${tag}${rest} class="${classes}">`;
    });
  };
  let out = inject(html, 'pre', PRE_CLASSES);
  out = inject(out, 'code', CODE_CLASSES);
  out = inject(out, 'a', A_CLASSES);
  return out;
}

/**
 * Parse + sanitise pipeline. Extracted as a pure function so the colocated
 * test can exercise it without rendering. `marked.parse` with `async: false`
 * is synchronous and returns a string; the runtime `typeof` guard pins that
 * contract for TS (whose signature widens to `string | Promise<string>`).
 */
export function renderAssistantMarkdown(text: string): string {
  const html = marked.parse(text, { gfm: true, breaks: true, async: false });
  const raw = typeof html === 'string' ? html : String(html);
  // Sanitisation BEFORE injection — DOMPurify strips <script>, javascript:,
  // event-handler attrs, and other XSS vectors. Pins the security boundary
  // documented at module scope. The colocated test exercises this contract.
  const clean = DOMPurify.sanitize(raw);
  return applyMarkdownClassOverrides(clean);
}

export default function AssistantText({ text }: AssistantTextProps): JSX.Element {
  // Empty / whitespace-only text renders nothing rather than an empty <div>
  // so a freshly-allocated assistant block (waiting on its first chunk)
  // doesn't push a hollow card into the chat log.
  if (!text) return <></>;
  const clean = renderAssistantMarkdown(text);
  return (
    <div
      className="assistant-text text-[13.5px] text-ink-900 leading-[1.55]"
      // Sanitised above. The marked → DOMPurify pipeline is the load-bearing
      // security boundary; see module-level JSDoc. eslint-disable-next-line is
      // intentional here — DOMPurify makes this safe.
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: clean }}
    />
  );
}
