/**
 * Server-only agent mode resolution (DASHBOARD_AGENT=auto|on|off).
 *
 * Deliberately lives outside `lib/agent/` so it can be imported without
 * loading the gated tree (session-manager / Agent SDK).
 *
 * Security: the API key is only ever sent in the `x-api-key` header of the
 * validation request. It is never logged, returned or put in error text.
 */

// `server-only` is not installed (no new deps); use a runtime guard instead.
if (typeof window !== 'undefined') {
  throw new Error('lib/agent-mode is server-only and must not be bundled for the client');
}

export type AgentMode = 'auto' | 'on' | 'off';
export type AgentReason =
  | 'off-by-config'
  | 'forced-on'
  | 'no-api-key'
  | 'invalid-key'
  | 'key-verified'
  | 'key-unverified';
export interface AgentStatus {
  enabled: boolean;
  mode: AgentMode;
  reason: AgentReason;
}

const DEFAULT_TIMEOUT_MS = 3000;

export function parseAgentMode(raw: string | undefined): AgentMode {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === '') return 'auto';
  if (v === 'auto' || v === 'on' || v === 'off') return v;
  console.warn(`[agent] unknown DASHBOARD_AGENT value "${v}", using auto`);
  return 'auto';
}

export async function resolveAgentStatus(
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<AgentStatus> {
  const mode = parseAgentMode(env.DASHBOARD_AGENT);
  if (mode === 'off') return { enabled: false, mode, reason: 'off-by-config' };
  if (mode === 'on') return { enabled: true, mode, reason: 'forced-on' };

  const key = (env.ANTHROPIC_API_KEY ?? '').trim();
  if (!key) return { enabled: false, mode, reason: 'no-api-key' };

  const base = (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(
    /\/+$/,
    '',
  );
  try {
    const res = await fetchImpl(`${base}/v1/models?limit=1`, {
      method: 'GET',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(Math.min(timeoutMs, DEFAULT_TIMEOUT_MS)),
    });
    if (res.status >= 200 && res.status < 300) {
      return { enabled: true, mode, reason: 'key-verified' };
    }
    if (res.status === 401 || res.status === 403) {
      return { enabled: false, mode, reason: 'invalid-key' };
    }
    return { enabled: true, mode, reason: 'key-unverified' };
  } catch {
    // Never log or rethrow: the error/request could carry the key.
    return { enabled: true, mode, reason: 'key-unverified' };
  }
}

const G = globalThis as unknown as {
  __agentStatusPromise?: Promise<AgentStatus>;
};

export function getAgentStatus(): Promise<AgentStatus> {
  if (!G.__agentStatusPromise) {
    G.__agentStatusPromise = resolveAgentStatus(process.env).then((s) => {
      console.log(
        `[agent] mode=${s.mode} enabled=${s.enabled} reason=${s.reason}`,
      );
      return s;
    });
  }
  return G.__agentStatusPromise;
}

/** null = agent enabled; otherwise a bare 404 to return immediately. */
export async function agentGate(): Promise<Response | null> {
  const s = await getAgentStatus();
  return s.enabled ? null : new Response(null, { status: 404 });
}

export function __resetAgentStatusForTests(): void {
  G.__agentStatusPromise = undefined;
}
