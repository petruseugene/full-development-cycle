import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';

vi.mock('next/navigation', () => ({ usePathname: () => '/' }));
vi.mock('@/lib/snapshot-context', () => ({
  useSnapshot: () => ({ activeFeatureId: null, snapshot: null }),
}));

import { GET } from '@/app/report/[[...file]]/route';
import { Sidebar } from '@/components/Sidebar';

let root = '';
const get = (file?: string[]) => GET(new Request('http://x/report'), { params: { file } });

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'report-route-'));
  await fs.mkdir(path.join(root, 'docs', 'features'), { recursive: true });
  process.env.DASHBOARD_FEATURES_DIR = path.join(root, 'docs', 'features');
});
afterEach(async () => {
  delete process.env.DASHBOARD_FEATURES_DIR;
  await fs.rm(root, { recursive: true, force: true });
});

describe('/report route (AC30)', () => {
  it('redirects /report to /report/index.html (no loop)', async () => {
    const r = await get();
    expect(r.status).toBe(308);
    expect(r.headers.get('location')).toBe('/report/index.html');
  });
  it('404 with hint when no report', async () => {
    const r = await get(['index.html']);
    expect(r.status).toBe(404);
    expect(await r.text()).toContain('No report yet');
  });
  it('serves index.html and foo.html with CSP', async () => {
    const d = path.join(root, '.dev-cycle', 'report');
    await fs.mkdir(d, { recursive: true });
    await fs.writeFile(path.join(d, 'index.html'), '<p>idx</p>');
    await fs.writeFile(path.join(d, 'foo.html'), '<p>foo</p>');
    await fs.writeFile(path.join(d, 'a.json'), '{}');
    const i = await get(['index.html']);
    expect(i.status).toBe(200);
    expect(i.headers.get('x-content-type-options')).toBe('nosniff');
    expect(i.headers.get('content-type')).toContain('text/html');
    expect(i.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(await i.text()).toBe('<p>idx</p>');
    // a feature href from the index resolves to a served route under /report/
    const href = new URL('./foo.html', 'http://h/report/index.html');
    expect(href.pathname).toBe('/report/foo.html');
    expect(await (await get(['foo.html'])).text()).toBe('<p>foo</p>');
    expect((await get(['a.json'])).headers.get('content-type')).toContain('application/json');
  });
  it('rejects traversal and multi-segment', async () => {
    await fs.writeFile(path.join(root, 'package.json'), '{}');
    expect((await get(['..%2F..%2Fpackage.json'])).status).toBe(404);
    expect((await get(['../../package.json'])).status).toBe(404);
    expect((await get(['a', 'b.html'])).status).toBe(404);
  });
  it('Sidebar renders Report link', () => {
    const html = renderToStaticMarkup(
      React.createElement(Sidebar, { features: [], activeId: null, onSelect: () => {}, onSelectAll: () => {} }),
    );
    expect(html).toMatch(/href="\/report\/index.html"[^>]*>[\s\S]*Report/);
  });
});
