import { describe, it, expect, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { ReactNode } from 'react';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: Array<() => void> = [];
function render(ui: ReactNode) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => root.render(ui));
  mounted.push(() => {
    act(() => root.unmount());
    el.remove();
  });
}
const buttons = () => Array.from(document.querySelectorAll('button'));
const byName = (re: RegExp | string) =>
  buttons().filter((b) => {
    const n = (b.getAttribute('aria-label') ?? b.textContent ?? '').trim();
    return typeof re === 'string' ? n === re : re.test(n);
  });
const click = (el: Element) => act(() => { (el as HTMLElement).click(); });
import ErrorCard from '../ErrorCard';
import type { ErrorEvent } from '@/lib/agent/types';

afterEach(() => { while (mounted.length) mounted.pop()!(); });

const MSG =
  'API credit balance too low — top up at https://platform.claude.com/settings/billing, then Retry.';
const mk = (o: Record<string, unknown>) =>
  ({ type: 'error', message: 'boom', retryable: true, ...o }) as unknown as ErrorEvent;

describe('ErrorCard', () => {
  it('titles billing_error as "Credit balance too low" with message and Retry', () => {
    render(<ErrorCard event={mk({ code: 'billing_error', message: MSG })} featureId="f" />);
    expect(document.body.textContent).toContain('Credit balance too low');
    expect(document.body.textContent).toContain('API credit balance too low');
    expect(byName('Retry')).toHaveLength(1);
  });
  it('hides Retry when retryable is false', () => {
    render(<ErrorCard event={mk({ code: 'billing_error', retryable: false })} featureId="f" />);
    expect(byName('Retry')).toHaveLength(0);
  });
  it('keeps "SDK error" title when no code', () => {
    render(<ErrorCard event={mk({})} featureId="f" />);
    expect(document.body.textContent).toContain('SDK error');
  });
});
