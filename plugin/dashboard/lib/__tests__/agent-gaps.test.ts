import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dash = resolve(__dirname, '..', '..');
const root = resolve(dash, '..'); // plugin/
const repo = resolve(root, '..');
const read = (p: string) => readFileSync(p, 'utf8');

function walk(d: string): string[] {
  return readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe('AC11 static contract', () => {
  it('shell layout is a server component importing getAgentStatus from @/lib/agent-mode', () => {
    const src = read(join(dash, 'app/(shell)/layout.tsx'));
    expect(src).not.toMatch(/['"]use client['"]/);
    expect(src).toMatch(/import\s*\{[^}]*getAgentStatus[^}]*\}\s*from\s*'@\/lib\/agent-mode'/);
  });
  it('SnapshotContextValue declares agentEnabled: boolean', () => {
    expect(read(join(dash, 'lib/snapshot-context.tsx'))).toMatch(/agentEnabled:\s*boolean/);
  });
});

describe('R6/R7 gate structure', () => {
  const routes = walk(join(dash, 'app/api/agent')).filter((f) => f.endsWith('route.ts'));
  it('every route handler calls agentGate before any dynamic import', () => {
    expect(routes.length).toBe(9);
    for (const f of routes) {
      const src = read(f);
      const gate = src.indexOf('agentGate()');
      const dyn = src.indexOf('await import(');
      expect(gate, f).toBeGreaterThan(-1);
      if (dyn !== -1) expect(gate, f).toBeLessThan(dyn);
    }
  });
  it('agent-status route does not reference lib/agent or the SDK', () => {
    const src = read(join(dash, 'app/api/agent-status/route.ts'));
    expect(src).not.toMatch(/@\/lib\/agent\//);
    expect(src).not.toMatch(/claude-agent-sdk/);
    expect(src).toMatch(/runtime\s*=\s*'nodejs'/);
    expect(src).toMatch(/dynamic\s*=\s*'force-dynamic'/);
  });
});

describe('AC13 docs', () => {
  for (const f of [join(repo, 'README.md'), join(root, 'dashboard/README.md')]) {
    it(`${f} documents billing, flags and hidden-without-key`, () => {
      const s = read(f);
      expect(s).toContain('API rates');
      expect(s).toContain('DASHBOARD_AGENT');
      expect(s).toContain('--agent=');
      expect(s).toMatch(/hidden[^.]*ANTHROPIC_API_KEY|ANTHROPIC_API_KEY[^.]*hidden/i);
    });
  }
  it('.env.example has DASHBOARD_AGENT', () => {
    expect(read(join(dash, '.env.example'))).toContain('DASHBOARD_AGENT');
  });
  it('commands/dashboard.md keeps $ARGUMENTS inside quoted heredocs, passes DASH_ARGS, and documents flags', () => {
    const s = read(join(root, 'commands/dashboard.md'));
    // Every $ARGUMENTS occurrence must sit inside a quoted heredoc body (<<'TAG' ... TAG).
    const heredocs = [...s.matchAll(/<<'(\w+)'\n([\s\S]*?)\n\1\b/g)];
    expect(heredocs.length).toBeGreaterThan(0);
    const total = s.split('$ARGUMENTS').length - 1;
    const inside = heredocs.reduce((n, m) => n + (m[2].split('$ARGUMENTS').length - 1), 0);
    expect(total).toBeGreaterThan(0);
    expect(inside).toBe(total);
    const lines = s.split('\n').filter((l) => l.trim().startsWith('bash ') && l.includes('run-dashboard.sh'));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l).toContain('"${DASH_ARGS[@]}"');
    expect(s).toContain('--agent=on|off|auto');
    expect(s).toContain('--no-agent');
  });
  it('CHANGELOG records the DASHBOARD_AGENT entry (Added) and credit-balance fix (Fixed) in some section', () => {
    const s = read(join(repo, 'CHANGELOG.md'));
    const sections = s.split(/^(?=## \[)/m).filter((x) => /^## \[(Unreleased|\d+\.\d+\.\d+)\]/.test(x));
    const hit = sections.find((x) => x.includes('DASHBOARD_AGENT=auto|on|off'));
    expect(hit).toBeDefined();
    expect(hit).toContain('### Added');
    expect(hit).toContain('### Fixed');
    expect(hit).toContain('Credit balance too low');
  });
});
