import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let dir = '';
vi.mock('@/lib/features', () => ({
  loadFeatures: async () => [{ id: 'f1', folderPath: dir }],
}));

import { POST } from '@/app/api/features/[id]/tasks/route';

const req = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('http://127.0.0.1:3737/api', {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: '127.0.0.1:3737', ...headers },
    body: JSON.stringify(body),
  });

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tasks-route-'));
  await fs.writeFile(path.join(dir, 'plan.md'), '## Tasks\n\n- [TODO] **Task 1** (backend): A\n');
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('POST tasks owner/content (AC35)', () => {
  it('tag owner writes (owner) line', async () => {
    const res = await POST(req({ title: 'Do it', tag: 'owner' }), { params: { id: 'f1' } });
    expect(res.status).toBe(200);
    const plan = await fs.readFile(path.join(dir, 'plan.md'), 'utf8');
    expect(plan).toContain('- [TODO] **Task 2** (owner): Do it');
  });
  it('tag content writes (content) line', async () => {
    const res = await POST(req({ title: 'Doc', tag: 'content' }), { params: { id: 'f1' } });
    expect(res.status).toBe(200);
    expect(await fs.readFile(path.join(dir, 'plan.md'), 'utf8')).toContain('(content): Doc');
  });
  it('banana is 400 and message lists new tags', async () => {
    const res = await POST(req({ title: 'x', tag: 'banana' }), { params: { id: 'f1' } });
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.error).toContain('owner');
    expect(j.error).toContain('content');
  });
});

describe('POST tasks CSRF guard', () => {
  const ok = { title: 'T', tag: 'backend' };
  const ctx = { params: { id: 'f1' } };
  it('accepts same-origin with Origin + Sec-Fetch-Site', async () => {
    const res = await POST(
      req(ok, { origin: 'http://127.0.0.1:3737', 'sec-fetch-site': 'same-origin' }),
      ctx,
    );
    expect(res.status).toBe(200);
  });
  it('accepts requests with no Origin (non-browser)', async () => {
    expect((await POST(req(ok), ctx)).status).toBe(200);
  });
  it('rejects cross-origin Origin', async () => {
    const res = await POST(req(ok, { origin: 'https://evil.example' }), ctx);
    expect(res.status).toBe(403);
  });
  it('rejects another localhost port', async () => {
    const res = await POST(req(ok, { origin: 'http://127.0.0.1:9999' }), ctx);
    expect(res.status).toBe(403);
  });
  it('rejects Sec-Fetch-Site cross-site', async () => {
    const res = await POST(req(ok, { 'sec-fetch-site': 'cross-site' }), ctx);
    expect(res.status).toBe(403);
  });
  it('rejects text/plain simple-request body', async () => {
    const res = await POST(req(ok, { 'content-type': 'text/plain' }), ctx);
    expect(res.status).toBe(415);
  });
  it('rejects newline in title', async () => {
    const res = await POST(req({ title: 'a\nb', tag: 'backend' }), ctx);
    expect(res.status).toBe(400);
  });
  it('did not write plan on rejection', async () => {
    await POST(req(ok, { origin: 'https://evil.example' }), ctx);
    expect(await fs.readFile(path.join(dir, 'plan.md'), 'utf8')).not.toContain('Task 2');
  });
});
