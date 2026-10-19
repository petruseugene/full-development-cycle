import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const APP = path.resolve(__dirname, '../../app');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

/** Top-level (column 0) non-type static imports/re-exports with their specifier. */
function valueImports(src: string): string[] {
  const specs: string[] = [];
  const re = /^(import|export)\s+(?!type\b)([^;]*?)\s*from\s*['"]([^'"]+)['"]|^import\s+['"]([^'"]+)['"]/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) specs.push(m[3] ?? m[4]);
  return specs;
}

describe('agent import guard (AC4)', () => {
  const files = walk(APP);
  it('scans some files', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it('no value import of @/lib/agent/* under app/api, nor session-manager / SDK anywhere under app', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const rel = path.relative(APP, f).split(path.sep).join('/');
      const specs = valueImports(readFileSync(f, 'utf8'));
      for (const s of specs) {
        const underApi = rel.startsWith('api/');
        if (underApi && s.startsWith('@/lib/agent/')) offenders.push(`${rel}: ${s}`);
        if (
          s === '@/lib/agent/session-manager' ||
          s === '@anthropic-ai/claude-agent-sdk'
        ) {
          offenders.push(`${rel}: ${s}`);
        }
      }
    }
    expect([...new Set(offenders)]).toEqual([]);
  });

  it('the scanner itself flags a violating import', () => {
    expect(
      valueImports(`import { x } from '@/lib/agent/loopback';\nimport type { T } from '@/lib/agent/types';`),
    ).toEqual(['@/lib/agent/loopback']);
  });
});
