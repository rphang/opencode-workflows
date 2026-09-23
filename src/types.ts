// Shared contracts between modules. The engine is host-agnostic: everything opencode-specific
// lives behind `AgentRunner` (src/opencode/*), so the engine and parity tests run against fakes.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

export type Effort = "low" | "medium" | "high" | "xhigh" | "max"

export interface AgentOptions {
  label?: string
  phase?: string
  schema?: Record<string, unknown>
  model?: string
  effort?: Effort
  isolation?: "worktree"
  agentType?: string
}

export interface MetaPhase {
  title: string
  detail?: string
  model?: string
}

export interface WorkflowMeta {
  name: string
  description: string
  whenToUse?: string
  phases?: MetaPhase[]
}

/** Result of statically checking a workflow script (src/meta.ts). */
export type ParsedScript =
  | { ok: true; meta: WorkflowMeta; body: string; warnings: string[] }
  | { ok: false; error: string }

export interface TokenUsage {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  cost: number
}

/** One subagent execution request, as handed to the host runner. */
export interface AgentRequest {
  runId: string
  /** Index in agent START order within the run (0-based). */
  index: number
  prompt: string
  opts: AgentOptions
  /** Resolved phase title this agent is grouped under (may be undefined). */
  phase?: string
  signal: AbortSignal
  /** Streams interim status for the progress view (e.g. child session id once known). */
  onUpdate?: (update: Partial<AgentRecord>) => void
}

export type AgentOutcome =
  | { status: "completed"; value: Json; usage: TokenUsage; sessionID?: string }
  | { status: "stopped"; usage: TokenUsage; sessionID?: string }
  /** Terminal error (API failure etc.): agent() resolves to null. */
  | { status: "failed"; error: string; usage: TokenUsage; sessionID?: string }
  /** Structured output never validated: agent() THROWS this message. */
  | { status: "schema_failed"; error: string; usage: TokenUsage; sessionID?: string }

/** Host adapter that actually runs one subagent (opencode child session, or a fake in tests). */
export interface AgentRunner {
  run(request: AgentRequest): Promise<AgentOutcome>
}

export type AgentStatus = "queued" | "running" | "completed" | "failed" | "stopped" | "cached"

export interface AgentRecord {
  index: number
  key: string
  label: string
  phase?: string
  prompt: string
  opts: AgentOptions
  status: AgentStatus
  sessionID?: string
  usage: TokenUsage
  startedAt?: number
  endedAt?: number
  error?: string
  /** Non-fatal notes from the host runner (e.g. effort ignored: model has no matching variant, P26). */
  warnings?: string[]
  /** Kept worktree directory when an isolation:'worktree' agent left changes (P28). */
  worktree?: string
  /** What agent() returned (completed or cached agents only); shown in the agent detail (P50). */
  result?: Json
}

/** One line of journal.jsonl. */
export interface JournalEntry {
  type: "result"
  index: number
  key: string
  status: "completed" | "failed" | "stopped"
  value?: Json
  error?: string
  usage: TokenUsage
  sessionID?: string
}

export type RunStatus = "running" | "paused" | "completed" | "failed" | "stopped"

/** One progress group of the /workflows view (P50). */
export interface PhaseSummary {
  title: string
  agents: number
  done: number
  tokens: number
  /** First agent start to last agent end (now, while one is running); absent when none started. */
  elapsedMs?: number
}

export interface RunSummary {
  runId: string
  taskId: string
  workflowName: string
  description: string
  parentSessionID?: string
  status: RunStatus
  startedAt: number
  endedAt?: number
  agentCount: number
  usage: TokenUsage
  phases: PhaseSummary[]
  /** Agents outside every phase group (run before the first phase() and without opts.phase), P50. */
  ungrouped?: PhaseSummary
  logs: string[]
  result?: Json
  error?: string
  warnings: string[]
  scriptPath: string
  transcriptDir: string
}

/** Input of the `workflow` tool — mirrors Claude Code's WorkflowInput. */
export interface WorkflowInput {
  script?: string
  name?: string
  scriptPath?: string
  args?: Json
  resumeFromRunId?: string
  title?: string
  description?: string
}

/** Output of the `workflow` tool — mirrors Claude Code's WorkflowOutput. */
export interface WorkflowOutput {
  status: "async_launched"
  taskId: string
  taskType: "local_workflow"
  workflowName?: string
  runId?: string
  summary?: string
  transcriptDir?: string
  scriptPath?: string
  warning?: string
  error?: string
}

export const ZERO_USAGE: TokenUsage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }

export function totalTokens(u: TokenUsage): number {
  return u.input + u.output + u.reasoning + u.cacheRead + u.cacheWrite
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cost: a.cost + b.cost,
  }
}
