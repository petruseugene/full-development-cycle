import type { ReactNode } from 'react';
import { getAgentStatus } from '@/lib/agent-mode';
import { getProjectLabel } from '@/lib/project-label';
import { ShellClient } from '@/components/ShellClient';

export const dynamic = 'force-dynamic';

export default async function ShellLayout({ children }: { children: ReactNode }) {
  const agent = await getAgentStatus();
  const projectLabel = await getProjectLabel();
  return (
    <ShellClient agent={agent} projectLabel={projectLabel}>
      {children}
    </ShellClient>
  );
}
