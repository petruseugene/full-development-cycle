import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { TaskCard } from '../TaskCard';
import type { Feature, Task } from '@/lib/types';

const feature = { slug: 'abc-feat', id: 'f1', derived: { activeAgents: [] } } as unknown as Feature;
function render(el: React.ReactElement) {
  const container = document.createElement('div');
  container.innerHTML = renderToStaticMarkup(el);
  return { container };
}
const mk = (o: Partial<Task>): Task =>
  ({ id: 't1', index: 1, title: 'T', tag: 'mixed', owner: false, content: false, status: 'TODO', ...o }) as Task;

describe('TaskCard owner/content chips (AC34)', () => {
  it('owner-only task: chip owner, no stack chip', () => {
    const { container } = render(
      <TaskCard task={mk({ owner: true, stackless: true })} feature={feature} onOpen={() => {}} />,
    );
    expect(container.querySelector('.chip.owner')?.textContent).toBe('Owner');
    for (const t of ['frontend', 'backend', 'mixed', 'infra']) {
      expect(container.querySelector(`.chip.${t}`)).toBeNull();
    }
  });
  it('(backend, content): backend and content chips', () => {
    const { container } = render(
      <TaskCard task={mk({ tag: 'backend', content: true })} feature={feature} onOpen={() => {}} />,
    );
    expect(container.querySelector('.chip.backend')).not.toBeNull();
    expect(container.querySelector('.chip.content')?.textContent).toBe('Content');
    expect(container.querySelector('.chip.owner')).toBeNull();
  });
});

describe('globals.css new chip rules', () => {
  const css = readFileSync(path.resolve(__dirname, '../../app/globals.css'), 'utf8');
  for (const name of ['owner', 'content']) {
    it(`.chip.${name} uses only var() colours`, () => {
      const m = new RegExp(`\\.chip\\.${name}\\s*\\{([^}]*)\\}`).exec(css);
      expect(m).not.toBeNull();
      expect(m![1]).toContain('var(--');
      expect(m![1]).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    });
  }
});
