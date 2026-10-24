export type TaskStatus = 'TODO' | 'IN_PROGRESS' | 'IN_TESTING' | 'BLOCKED' | 'DONE';
export type TaskTag = 'frontend' | 'backend' | 'mixed' | 'infra';

export type AgentName =
  | 'discovery'
  | 'spec-writer'
  | 'wireframer'
  | 'plan-writer'
  | 'frontend-dev'
  | 'backend-dev'
  | 'auto-tester'
  | 'code-reviewer'
  | 'visual-tester'
  | 'git-agent'
  | 'orchestrator'
  | 'architector'
  | 'db-migrator'
  | 'static-checker'
  | 'security-reviewer'
  | 'release-manager'
  | 'dependency-auditor'
  | 'a11y-auditor'
  | 'cli-fallback';

export interface AgentRow {
  name: string;
  description: string;
  calls: number;
  approved: number | null;
  retried: number;
  time_s: number;
  tokens_k: number;
  last_used: string | null;
}

export interface Task {
  id: string;
  index: number;
  title: string;
  tag: TaskTag;
  owner: boolean;
  content: boolean;
  stackless?: boolean;
  status: TaskStatus;
  description?: string;
  files?: string[];
  acceptance?: string;
  steps?: string[];
  stepItems?: { text: string; done: boolean }[];
  /** Untruncated prose (inline markdown kept) for the task modal. */
  fullDescription?: string;
  reviewCycles?: number;
  blockerReason?: string;
  activeAgents?: AgentName[];
}

export interface TokenBreakdown {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

export interface HistoryEvent {
  ts: string;
  phase: string;
  subagent: AgentName | string;
  status: string;
  duration_s?: number;
  tokens_k?: number;
  task_id?: string;
  message?: string;
  model?: string;
  tokens?: TokenBreakdown | string;
  estimated?: boolean;
  usd_est?: number;
  executor?: string;
  started_at?: string;
  ended_at?: string;
  agent_id?: string;
}

export interface FeatureJson {
  feature_slug: string;
  created: string;
  flow: 'feature' | 'bugfix' | 'hotfix';
  has_ui: boolean;
  has_backend: boolean;
  design_source: string | null;
  auto_tests: boolean;
  visual_tests: boolean;
  current_phase:
    | 'discovery'
    | 'spec'
    | 'wireframe'
    | 'plan'
    | 'implement'
    | 'review'
    | 'test'
    | 'git'
    | 'done';
  current_task_idx: number;
  task_count: number;
  branch: string;
  history: HistoryEvent[];
  models?: Record<string, string>;
  discovery?: 'full' | 'internal' | 'skip';
  track?: 'full' | 'lite' | 'quick' | 'polish';
  started_at?: string;
  sessions?: { id?: string; started_at?: string; ended_at?: string; [k: string]: unknown }[];
  areas?: { name: string; touches: string[] }[];
  totals?: {
    by_subagent: Record<
      string,
      { calls: number; approved: number; retried: number; time_s: number; tokens_k: number }
    >;
    by_model?: Record<string, { calls: number; time_s: number; tokens_k: number }>;
    measured?: {
      input: number;
      output: number;
      cache_read: number;
      cache_write: number;
      billable_k: number;
      usd_est: number;
      measured_entries: number;
      estimated_entries: number;
    };
    orchestrator?: Partial<TokenBreakdown> & { billable_k?: number; usd_est?: number };
  };
}

export interface ReviewVerdict {
  taskId: string;
  cycle: number;
  status: 'APPROVED' | 'CHANGES_REQUIRED';
  findings: { line?: string; comment: string }[];
  ts?: string;
}

export interface TestReport {
  status: 'PASSED' | 'FAILED';
  failures_count: number;
  cases?: { name: string; status: 'pass' | 'fail' | 'running' }[];
  failureMessage?: string;
  visualDiffs?: { name: string; status: 'pass' | 'diff' | 'fail' }[];
}

export interface Feature {
  id: string;            // folder name
  slug: string;
  title: string;
  folderPath: string;
  meta: FeatureJson | null;
  tasks: Task[];
  reviews: ReviewVerdict[];
  testReport: TestReport | null;
  hasSpec: boolean;
  /** Definitions from spec.md for the ids referenced by this feature's tasks. */
  specIds?: Record<string, { text: string; done?: boolean }>;
  hasDiscovery: boolean;
  hasWireframes: boolean;
  hasPlan: boolean;
  specStatus: string | null;
  wireframeFiles: string[];
  updatedAt: string;
  pinned?: boolean;
  derived: {
    overallStatus: TaskStatus;
    progress: { done: number; total: number };
    activeAgents: AgentName[];
  };
}

export interface KPIs {
  activeFeatures: number;
  tasksInFlight: number;
  blocked: number;
  avgCycleHours: number | null;
  agentSpend: {
    dollars: number;
    tokens: number;
    budget: number;
    featureCount?: number;
    costPerKtok?: number;
  };
  trends: {
    activeFeatures: number[];
    blocked: number[];
    cycleHours: number[];
  };
}

export interface DashboardSnapshot {
  features: Feature[];
  kpis: KPIs;
  ticker: HistoryEvent[];
  agents: AgentRow[];
  generatedAt: string;
}

export interface PinnedChangedEvent {
  kind: 'pinned-changed';
  slugs: string[];
  origin: string;
  ts: string;
}
