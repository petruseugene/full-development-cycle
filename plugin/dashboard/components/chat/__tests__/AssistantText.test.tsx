/**
 * AssistantText — XSS sanitisation contract (Task 12 / spec R27).
 *
 * The marked → DOMPurify pipeline is the load-bearing security boundary
 * for the assistant_text render path. These tests pin the contract by
 * exercising the exported `renderAssistantMarkdown` pure function:
 *
 *   - <script> blocks are stripped (XSS prevention).
 *   - Markdown emphasis (**bold**) survives sanitisation as <strong>.
 *   - Fenced code blocks render as <pre><code>.
 *   - javascript: URLs in links are neutralised.
 */
import { describe, it, expect } from 'vitest';
import { renderAssistantMarkdown } from '../AssistantText';

describe('renderAssistantMarkdown', () => {
  it('strips <script> tags', () => {
    const html = renderAssistantMarkdown('<script>alert(1)</script>hello');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/alert\(1\)/);
  });

  it('keeps **bold** as <strong>', () => {
    const html = renderAssistantMarkdown('**bold**');
    expect(html).toMatch(/<strong>bold<\/strong>/);
  });

  it('renders code fences as <pre><code>', () => {
    const html = renderAssistantMarkdown('```\nconst x = 1;\n```');
    // <pre> may carry redesign class attributes (chat-redesign spec §6.1);
    // match the opening tag with or without attributes rather than the bare
    // form so the assertion survives the dashboard-token className.
    expect(html).toMatch(/<pre(\s|>)/);
    expect(html).toMatch(/<code/);
    expect(html).toMatch(/const x = 1;/);
  });

  it('strips javascript: URLs in markdown links', () => {
    const html = renderAssistantMarkdown('[click](javascript:alert(1))');
    // DOMPurify removes the href entirely (or rewrites to about:blank)
    // — the literal `javascript:` scheme must not survive.
    expect(html).not.toMatch(/javascript:/i);
  });
});
