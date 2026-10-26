import type { AgentName } from '@/lib/types';

const AGENTS: Record<AgentName, { mono: string; color: string; title: string }> = {
  discovery:      { mono: 'DI', color: '#475569', title: 'discovery' },
  'spec-writer':  { mono: 'SP', color: '#4F46E5', title: 'spec-writer' },
  wireframer:     { mono: 'WF', color: '#7C3AED', title: 'wireframer' },
  'plan-writer':  { mono: 'PL', color: '#C026D3', title: 'plan-writer' },
  'frontend-dev': { mono: 'FD', color: '#2563EB', title: 'frontend-dev' },
  'backend-dev':  { mono: 'BD', color: '#0D9488', title: 'backend-dev' },
  'auto-tester':  { mono: 'AT', color: '#D97706', title: 'auto-tester' },
  'code-reviewer':{ mono: 'CR', color: '#EA580C', title: 'code-reviewer' },
  'visual-tester':{ mono: 'VT', color: '#DB2777', title: 'visual-tester' },
  'git-agent':    { mono: 'GA', color: '#059669', title: 'git-agent' },
  orchestrator:   { mono: 'OR', color: '#1F2937', title: 'orchestrator' },
  architector:           { mono: 'AR', color: '#0EA5E9', title: 'architector' },
  'db-migrator':         { mono: 'DB', color: '#A16207', title: 'db-migrator' },
  'static-checker':      { mono: 'SC', color: '#65A30D', title: 'static-checker' },
  'security-reviewer':   { mono: 'SR', color: '#B91C1C', title: 'security-reviewer' },
  'release-manager':     { mono: 'RM', color: '#9333EA', title: 'release-manager' },
  'dependency-auditor':  { mono: 'DA', color: '#0F766E', title: 'dependency-auditor' },
  'a11y-auditor':        { mono: 'AA', color: '#E11D48', title: 'a11y-auditor' },
  'cli-fallback':        { mono: 'CF', color: '#475569', title: 'cli-fallback' },
};

export const AGENT_LIST = Object.keys(AGENTS) as AgentName[];
export function agentInfo(name: AgentName) {
  return AGENTS[name] ?? { mono: name.slice(0, 2).toUpperCase(), color: '#64748B', title: name };
}

export function AgentBadge({
  name,
  size = 'md',
  dim = false,
}: {
  name: AgentName;
  size?: 'sm' | 'md' | 'lg';
  dim?: boolean;
}) {
  const info = agentInfo(name);
  const cls = size === 'lg' ? 'mono-tile lg' : 'mono-tile';
  const style = dim
    ? { background: '#E2E8F0', color: '#94A3B8' }
    : { background: info.color };
  return (
    <span className={cls} style={style} title={info.title}>
      {info.mono}
    </span>
  );
}
