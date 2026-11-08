/**
 * Server-only agent mode resolution (DASHBOARD_AGENT=on|off).
 *
 * Deliberately lives outside `lib/agent/` so it can be imported without
 * loading the gated tree (session-manager / Agent SDK).
 *
 * Chat is opt-in: it is off unless DASHBOARD_AGENT=on. The dashboard never
 * reads or forwards credentials itself; the Claude Agent SDK resolves its
 * own authentication when a session starts.
 */

// `server-only` is not installed (no new deps); use a runtime guard instead.
if (typeof window !== 'undefined') {
  throw new Error('lib/agent-mode is server-only and must not be bundled for the client');
}

export type AgentMode = 'on' | 'off';
export type AgentReason = 'off-by-default' | 'off-by-config' | 'on-by-config';
export interface AgentStatus {
  enabled: boolean;
  mode: AgentMode;
  reason: AgentReason;
}

/**
 * Parses DASHBOARD_AGENT. Unset/empty → off by default. The legacy value
 * `auto` is accepted and treated as the default (off).
 */
export function parseAgentMode(raw: string | undefined): {
  mode: AgentMode;
  explicit: boolean;
} {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'on' || v === 'off') return { mode: v, explicit: true };
  if (v !== '' && v !== 'auto') {
    console.warn(`[agent] unknown DASHBOARD_AGENT value "${v}", using off`);
  }
  return { mode: 'off', explicit: false };
}

export function resolveAgentStatus(
  env: Record<string, string | undefined>,
): AgentStatus {
  const { mode, explicit } = parseAgentMode(env.DASHBOARD_AGENT);
  if (mode === 'on') return { enabled: true, mode, reason: 'on-by-config' };
  return {
    enabled: false,
    mode,
    reason: explicit ? 'off-by-config' : 'off-by-default',
  };
}

const G = globalThis as unknown as {
  __agentStatus?: AgentStatus;
};

export async function getAgentStatus(): Promise<AgentStatus> {
  if (!G.__agentStatus) {
    const s = resolveAgentStatus(process.env);
    console.log(`[agent] mode=${s.mode} enabled=${s.enabled} reason=${s.reason}`);
    G.__agentStatus = s;
  }
  return G.__agentStatus;
}

/** null = agent enabled; otherwise a bare 404 to return immediately. */
export async function agentGate(): Promise<Response | null> {
  const s = await getAgentStatus();
  return s.enabled ? null : new Response(null, { status: 404 });
}

export function __resetAgentStatusForTests(): void {
  G.__agentStatus = undefined;
}
