// Shared contracts between modules. The engine is host-agnostic: everything opencode-specific
// lives behind `AgentRunner` (src/opencode/*), so the engine and parity tests run against fakes.

import type { AgentMailbox, MessageFrom, MessageRecord, MessageVia, RefusalReason } from "./mailbox.ts"

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
  /**
   * Steering window for this agent (X01–X04). The runner attaches a sender once the agent has a
   * session, appends held messages to the first prompt, opens the window while a turn runs and
   * closes it (verifying delivery) before it reads the result. Absent for hosts without steering.
   */
  mailbox?: AgentMailbox
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
  /**
   * The model it runs on, `provider/model#variant` (variant only when set; X18): what its child
   * session reports, else what the runner requested. Display only; never part of the agent key.
   */
  model?: string
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
  /** Steering messages this agent received (X01–X04), oldest first. */
  messages?: MessageRecord[]
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
  /** The model the agent ran on (X18), so a cached agent keeps it on resume. Not part of the key. */
  model?: string
  /** The agent received at least one steering message: never served from cache on resume (X06). */
  steered?: boolean
}

/** A steering message accepted for an agent (journal.jsonl line, X06). Older readers skip it. */
export interface JournalMessage {
  type: "message"
  index: number
  id: string
  from: MessageFrom
  via: MessageVia
  urgent: boolean
  at: number
  text: string
}

/** Who a steering message goes to (X05). */
export type MessageTarget =
  | { kind: "index"; index: number }
  | { kind: "label"; label: string }
  | { kind: "phase"; phase: string }
  | { kind: "all" }

/** What happened to a steering message for one targeted agent. */
export interface MessageReport {
  index: number
  label: string
  /** The agent status when the message was posted. */
  status: AgentStatus
  outcome: "sent" | "held" | "refused"
  messageId?: string
  reason?: RefusalReason
  detail?: string
}

export type RunStatus = "running" | "paused" | "completed" | "failed" | "stopped"

/** One progress group of the /workflows view (P50). */
export interface PhaseSummary {
  title: string
  /**
   * The phase's model label from `meta.phases[].model` (X10). Display only, as in Claude Code: agents
   * take their model from `agent(…, {model})`, never from this label.
   */
  model?: string
  /**
   * The one model every agent of this phase with a known model runs on (X19), absent when they differ
   * or none is known. Views show it when the phase has no `model` label.
   */
  agentModel?: string
  agents: number
  done: number
  /** Agents of this phase running right now (X10); 0 once the run is over. */
  running?: number
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
  /** The project directory (opencode Location) whose plugin instance started the run (X12). */
  directory?: string
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
  /** Agents that received at least one steering message (X06); absent when none. */
  steeredAgents?: number
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
