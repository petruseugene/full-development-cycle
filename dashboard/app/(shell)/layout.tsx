import type { ReactNode } from 'react';
import { getAgentStatus } from '@/lib/agent-mode';
import { ShellClient } from '@/components/ShellClient';

export const dynamic = 'force-dynamic';

export default async function ShellLayout({ children }: { children: ReactNode }) {
  const agent = await getAgentStatus();
  return <ShellClient agent={agent}>{children}</ShellClient>;
}
