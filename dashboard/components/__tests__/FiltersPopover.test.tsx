import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FiltersPopover } from '../FiltersPopover';
import { EMPTY_FILTERS, applyFilters } from '@/lib/board-filters';
import type { Feature, Task } from '@/lib/types';

describe('FiltersPopover Owner/Content (AC35)', () => {
  it('lists Owner and Content options', () => {
    const html = renderToStaticMarkup(
      <FiltersPopover filters={EMPTY_FILTERS} onFiltersChange={() => {}} features={[]} onClose={() => {}} />,
    );
    expect(html).toContain('>Owner<');
    expect(html).toContain('>Content<');
  });
  it('checks Owner when flags include it', () => {
    const html = renderToStaticMarkup(
      <FiltersPopover filters={{ ...EMPTY_FILTERS, flags: ['owner'] }} onFiltersChange={() => {}} features={[]} onClose={() => {}} />,
    );
    expect(html).toMatch(/checked=""[^>]*\/><span class="truncate">Owner/);
  });
  it('selecting Owner keeps only owner tasks', () => {
    const t = (id: string, owner: boolean) => ({ id, index: 1, title: id, tag: 'mixed', owner, content: false, status: 'TODO' }) as Task;
    const f = { id: 'f', title: 'F', tasks: [t('a', true), t('b', false)] } as unknown as Feature;
    const out = applyFilters([f], { ...EMPTY_FILTERS, flags: ['owner'] });
    expect(out[0].tasks.map((x) => x.id)).toEqual(['a']);
  });
});
