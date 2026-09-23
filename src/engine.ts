// Host-agnostic workflow engine: runs one workflow script body in the codemode sandbox and backs
// the script API (agent / phase / log / budget / workflow) with an AgentRunner.
//
// Semantics (see docs/PARITY.md):
//  - agent(prompt, opts) (P20–P28): the options are normalized (unknown keys dropped). A schema is
//    preflighted and throws before any agent starts (P22). The agent-count cap applies, and the
//    1001st call throws (P37). The call gets the next START index (the order agent() was called
//    in, which is deterministic for resume) and a key from agentKey(). On resume the ReplayCursor
//    is consulted first: a hit returns the cached value without running anything (P41). The budget
//    hard ceiling applies next: once spent() >= total, agent() throws before starting (P34). Then
//    the agent waits on the shared concurrency semaphore (P36) and runs through the AgentRunner.
//    Outcome mapping: completed → value; stopped/failed → null (P23); schema_failed → throws
//    (P21); a runner that rejects counts as failed.
//  - Every finished agent is journaled (P40). A whole-run stop journals running agents as
//    "stopped", never "failed" (P44), so a resume runs them again. A single-agent stop
//    (stopAgent) counts as failed (P51).
//  - budget.spent() = the output + reasoning tokens spent by agents of THIS run, nested
//    workflow() agents included. Agents replayed from the journal cost nothing this turn, so they
//    count 0 (like RunSummary.usage and the phase token totals). DEGRADED vs Claude Code (P34): the
//    total comes from the tool input, the pool is per run (not per turn), and the parent
//    session's own tokens are not counted.
//  - workflow(nameOrRef, args) (P35): runs the resolved body in its own sandbox execution. It
//    shares this run's semaphore, agent counter/indices (and so the journal and resume cursor),
//    budget and abort signal. Only one level of nesting is allowed. A nested workflow starts in
//    the caller's current phase, and its log lines are prefixed with "[<name>] ".
//  - When the script settles, agents it started but never awaited are stopped (codemode also
//    interrupts pending interpreter work when the program returns).
//  - The run stays registered as active until every agent runner call has settled, even after
//    stop(). isRunActive() lets the tool layer refuse a resume while old agents are still
//    exiting (P43).

import { availableParallelism, cpus } from "node:os"
import { join } from "node:path"
import { agentKey, type ReplayCursor } from "./journal.ts"
import { buildProgram, executeProgram } from "./sandbox.ts"
import { preflightSchema } from "./schema.ts"
import { SCRIPT_FILE, type RunStore } from "./store.ts"
import {
  addUsage,
  totalTokens,
  ZERO_USAGE,
  type AgentOptions,
  type AgentOutcome,
  type AgentRecord,
  type AgentRunner,
  type Effort,
  type JournalEntry,
  type Json,
  type PhaseSummary,
  type RunStatus,
  type RunSummary,
  type TokenUsage,
  type WorkflowMeta,
} from "./types.ts"

export const DEFAULT_MAX_AGENTS = 1000
export const LARGE_WORKFLOW_AGENT_THRESHOLD = 25
export const MAX_CONCURRENT_ENV = "OPENCODE_WORKFLOW_MAX_CONCURRENT_AGENTS"
const MAX_CONCURRENT_CEILING = 256
const DEFAULT_SUMMARY_THROTTLE_MS = 500
const DEFAULT_FINISH_GRACE_MS = 2000
const FINAL_SUMMARY_WRITE_ATTEMPTS = 3
const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"]

/** A reference passed to workflow(): a saved workflow name, or `{scriptPath}`. */
export type WorkflowRef = string | { scriptPath: string }

export interface ResolvedWorkflow {
  meta: WorkflowMeta
  /** Script body with the meta statement blanked (ParsedScript.body). */
  body: string
}

export type WorkflowEvent =
  | { type: "run_started"; runId: string; summary: RunSummary }
  | { type: "phase"; runId: string; title: string }
  | { type: "log"; runId: string; message: string }
  | { type: "warning"; runId: string; message: string }
  /** Any agent status change or streamed update. `record` is a snapshot copy. */
  | { type: "agent"; runId: string; record: AgentRecord }
  | { type: "run_paused"; runId: string }
  | { type: "run_resumed"; runId: string }
  | { type: "run_finished"; runId: string; summary: RunSummary }

export interface StartRunOptions {
  runId: string
  taskId: string
  /** Session directory key under the store root (usually the parent session id). */
  sessionKey: string
  parentSessionID?: string
  meta: WorkflowMeta
  body: string
  /** Exposed to the script as the global `args` (undefined when omitted). */
  args?: unknown
  runner: AgentRunner
  store: RunStore
  /** Replay cursor from loadForResume() (P41). */
  resume?: ReplayCursor
  /** Token target for `budget.total`; null/undefined → no target. */
  budgetTotal?: number | null
  /** Concurrent agent cap. Default defaultMaxConcurrent(). */
  maxConcurrent?: number
  /** Total agents per run (P37). Default 1000. */
  maxAgents?: number
  /** Scheduled-agent count above which the Large-workflow warning fires (P55, P70). Default 25. */
  largeWorkflowThreshold?: number
  /** Resolves workflow(nameOrRef). Must throw for unknown names (P35). */
  resolveWorkflow?: (ref: WorkflowRef) => Promise<ResolvedWorkflow>
  onEvent?: (event: WorkflowEvent) => void
  /** Clock for timestamps (host side). Default Date.now. */
  now?: () => number
  /** Full script source; written to <runDir>/script.js when scriptPath is not given. */
  source?: string
  /** Where the script lives, if the caller already persisted it. */
  scriptPath?: string
  /** Warnings known before the run starts (e.g. from parseScript). */
  warnings?: string[]
  /** Minimum interval between run.json snapshot writes. Default 500 ms. */
  summaryThrottleMs?: number
  /** Optional wall-clock limit for the script (codemode timeout). Default none. */
  timeoutMs?: number
  /**
   * How long finish() waits for the agents it just aborted (unawaited, or all of them on
   * stop/failure) to settle before building the summary that result() delivers. Bounded so an
   * agent that ignores its abort cannot hold back the task notification. Default 2000 ms.
   */
  finishGraceMs?: number
}

/**
 * Default concurrent-agent cap (P36): env OPENCODE_WORKFLOW_MAX_CONCURRENT_AGENTS when it is an
 * integer (clamped to 1..256), else min(16, max(1, cpuCount - 2)).
 */
export function defaultMaxConcurrent(
  env: Record<string, string | undefined> = process.env,
  cpuCount: number = typeof availableParallelism === "function" ? availableParallelism() : cpus().length,
): number {
  const raw = env[MAX_CONCURRENT_ENV]
  if (raw !== undefined && raw.trim() !== "") {
    const n = Number.parseInt(raw, 10)
    if (Number.isFinite(n)) return Math.min(MAX_CONCURRENT_CEILING, Math.max(1, n))
  }
  return Math.min(16, Math.max(1, cpuCount - 2))
}

// ---------------------------------------------------------------------------------------------
// Live-run registry (P43)

const activeRuns = new Map<string, WorkflowRun>()

/** True while the run's script executes or any of its agents has not exited yet. */
export function isRunActive(runId: string): boolean {
  return activeRuns.has(runId)
}

export function getActiveRun(runId: string): WorkflowRun | undefined {
  return activeRuns.get(runId)
}

export function listActiveRuns(): WorkflowRun[] {
  return [...activeRuns.values()]
}

// ---------------------------------------------------------------------------------------------

class Semaphore {
  private active = 0
  private queue: { grant: () => void }[] = []
  paused = false

  constructor(private readonly max: number) {}

  /** Resolves true when a slot is granted, false if `signal` aborts first. */
  acquire(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false)
    if (!this.paused && this.active < this.max && this.queue.length === 0) {
      this.active++
      return Promise.resolve(true)
    }
    return new Promise<boolean>((resolve) => {
      const entry = {
        grant: () => {
          signal.removeEventListener("abort", onAbort)
          resolve(true)
        },
      }
      const onAbort = () => {
        this.queue = this.queue.filter((q) => q !== entry)
        resolve(false)
      }
      signal.addEventListener("abort", onAbort, { once: true })
      this.queue.push(entry)
    })
  }

  release() {
    this.active--
    this.pump()
  }

  pump() {
    while (!this.paused && this.active < this.max && this.queue.length > 0) {
      const next = this.queue.shift()!
      this.active++
      next.grant()
    }
  }
}

interface ExecContext {
  depth: number
  phase?: string
  /** Name of the nested workflow (log prefix); undefined for the top-level script. */
  name?: string
}

interface LiveAgent {
  record: AgentRecord
  controller: AbortController
  userStopped: boolean
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message)
  return String(e)
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

/** Keeps only the known agent() options, validating their types. */
export function normalizeAgentOptions(raw: unknown): AgentOptions {
  if (raw === undefined || raw === null) return {}
  if (!isPlainObject(raw)) throw new TypeError("agent() options must be an object")
  const out: AgentOptions = {}
  const str = (k: string): string | undefined => {
    const v = raw[k]
    if (v === undefined || v === null) return undefined
    if (typeof v !== "string") throw new TypeError(`agent() option ${k} must be a string`)
    return v
  }
  const label = raw.label
  if (label !== undefined && label !== null) out.label = String(label)
  const phase = raw.phase
  if (phase !== undefined && phase !== null) out.phase = String(phase)
  if (raw.schema !== undefined && raw.schema !== null) {
    if (!isPlainObject(raw.schema)) throw new TypeError("agent() option schema must be a JSON Schema object")
    out.schema = raw.schema
  }
  const model = str("model")
  if (model !== undefined) out.model = model
  const effort = str("effort")
  if (effort !== undefined) {
    if (!EFFORTS.includes(effort as Effort)) throw new TypeError(`agent() option effort must be one of ${EFFORTS.join(", ")}`)
    out.effort = effort as Effort
  }
  const isolation = str("isolation")
  if (isolation !== undefined) {
    if (isolation !== "worktree") throw new TypeError(`agent() option isolation must be "worktree"`)
    out.isolation = "worktree"
  }
  const agentType = str("agentType")
  if (agentType !== undefined) out.agentType = agentType
  return out
}

function defaultLabel(prompt: string, index: number): string {
  const line = prompt.trim().split("\n")[0]?.trim() ?? ""
  if (!line) return `agent ${index + 1}`
  return line.length > 60 ? line.slice(0, 59) + "…" : line
}

function budgetTokens(u: TokenUsage): number {
  return u.output + u.reasoning
}

export class WorkflowRun {
  readonly runId: string
  readonly taskId: string
  private readonly opts: StartRunOptions
  private readonly now: () => number
  private readonly controller = new AbortController()
  private readonly sem: Semaphore
  private readonly maxAgents: number
  private readonly budgetTotal: number | null
  private readonly throttleMs: number

  private _status: RunStatus = "running"
  private stopRequested = false
  private finished = false
  private readonly startedAt: number
  private endedAt?: number
  private resultValue?: Json
  private error?: string
  private readonly warnings: string[]
  private readonly logs: string[] = []
  private readonly phaseOrder: string[] = []
  private readonly records: AgentRecord[] = []
  private readonly live = new Map<number, LiveAgent>()
  private nextIndex = 0
  private largeWarned = false
  private dir = ""
  private scriptPath = ""

  private readonly agentTasks = new Set<Promise<unknown>>()
  private readonly ioTasks = new Set<Promise<unknown>>()
  private ready!: Promise<void>
  private summaryTimer?: ReturnType<typeof setTimeout>
  private lastSummaryWrite = 0
  private started = false

  private resolveResult!: (s: RunSummary) => void
  private readonly resultPromise: Promise<RunSummary>
  private settledPromise?: Promise<void>

  constructor(opts: StartRunOptions) {
    this.opts = opts
    this.runId = opts.runId
    this.taskId = opts.taskId
    this.now = opts.now ?? Date.now
    this.startedAt = this.now()
    this.sem = new Semaphore(Math.max(1, Math.floor(opts.maxConcurrent ?? defaultMaxConcurrent())))
    this.maxAgents = opts.maxAgents ?? DEFAULT_MAX_AGENTS
    this.budgetTotal = typeof opts.budgetTotal === "number" && Number.isFinite(opts.budgetTotal) ? opts.budgetTotal : null
    this.throttleMs = opts.summaryThrottleMs ?? DEFAULT_SUMMARY_THROTTLE_MS
    this.warnings = [...(opts.warnings ?? [])]
    for (const p of opts.meta.phases ?? []) this.addPhase(p.title)
    this.resultPromise = new Promise((r) => (this.resolveResult = r))
  }

  /** Starts the run (idempotent). startRun() calls this. */
  start(): this {
    if (this.started) return this
    this.started = true
    activeRuns.set(this.runId, this)
    this.ready = this.prepare()
    void this.main()
    return this
  }

  get status(): RunStatus {
    return this._status
  }

  /** Aborted when the run is stopped or its script has settled. */
  get signal(): AbortSignal {
    return this.controller.signal
  }

  /** Resolves with the final RunSummary once the script settles (result = script return value). */
  result(): Promise<RunSummary> {
    return this.resultPromise
  }

  /** Resolves once the run finished AND every agent runner call has settled and all writes are flushed. */
  settled(): Promise<void> {
    if (!this.settledPromise) {
      this.settledPromise = (async () => {
        await this.resultPromise
        await this.drain()
        this.cancelSummaryTimer()
        // The final run.json must not be lost: the store already retries transient Windows
        // sharing errors, and this retries the whole write a few more times on top.
        for (let i = 0; i < FINAL_SUMMARY_WRITE_ATTEMPTS; i++) {
          if (await this.io(() => this.opts.store.writeSummary(this.summary()))) break
        }
        await this.drain()
        activeRuns.delete(this.runId)
      })()
    }
    return this.settledPromise
  }

  /** Current RunSummary snapshot. */
  summary(): RunSummary {
    type Group = PhaseSummary & { from?: number; to?: number }
    const group = (title: string): Group => ({ title, agents: 0, done: 0, tokens: 0 })
    const phases = this.phaseOrder.map(group)
    const byTitle = new Map(phases.map((p) => [p.title, p]))
    const ungrouped = group("(no phase)")
    const now = this.endedAt ?? this.now()
    let usage = ZERO_USAGE
    for (const r of this.records) {
      if (!r) continue
      const live = r.status !== "cached"
      if (live) usage = addUsage(usage, r.usage)
      const g = (r.phase !== undefined ? byTitle.get(r.phase) : undefined) ?? ungrouped
      g.agents++
      if (r.status !== "queued" && r.status !== "running") g.done++
      if (live) g.tokens += totalTokens(r.usage)
      if (r.startedAt !== undefined) {
        const end = r.endedAt ?? now
        g.from = g.from === undefined ? r.startedAt : Math.min(g.from, r.startedAt)
        g.to = g.to === undefined ? end : Math.max(g.to, end)
      }
    }
    const finish = (g: Group): PhaseSummary => {
      const out: PhaseSummary = { title: g.title, agents: g.agents, done: g.done, tokens: g.tokens }
      if (g.from !== undefined && g.to !== undefined) out.elapsedMs = Math.max(0, g.to - g.from)
      return out
    }
    const s: RunSummary = {
      runId: this.runId,
      taskId: this.taskId,
      workflowName: this.opts.meta.name,
      description: this.opts.meta.description,
      status: this._status,
      startedAt: this.startedAt,
      agentCount: this.records.length,
      usage,
      phases: phases.map(finish),
      logs: [...this.logs],
      warnings: [...this.warnings],
      scriptPath: this.scriptPath,
      transcriptDir: this.dir,
    }
    if (ungrouped.agents) s.ungrouped = finish(ungrouped)
    if (this.opts.parentSessionID !== undefined) s.parentSessionID = this.opts.parentSessionID
    if (this.endedAt !== undefined) s.endedAt = this.endedAt
    if (this.resultValue !== undefined) s.result = this.resultValue
    if (this.error !== undefined) s.error = this.error
    return s
  }

  /** Snapshot copies of all agent records, in index (start) order. */
  agents(): AgentRecord[] {
    return this.records.map((r) => ({ ...r }))
  }

  /**
   * Stops the whole run: aborts the script and every agent (P44). No-op once finished. `reason`
   * (e.g. the plugin being unloaded) is recorded as a warning, so the notification explains it.
   */
  stop(reason?: string): void {
    if (this.finished || this.stopRequested) return
    if (reason) this.warn(reason)
    this.stopRequested = true
    this._status = "stopped"
    this.sem.paused = false
    this.controller.abort()
    this.markDirty()
  }

  /** Stops one queued or running agent; it counts as failed and its agent() resolves null (P51). */
  stopAgent(index: number): boolean {
    const a = this.live.get(index)
    if (!a || (a.record.status !== "queued" && a.record.status !== "running")) return false
    a.userStopped = true
    a.controller.abort()
    return true
  }

  /** Stops scheduling new agents; running ones continue. */
  pause(): boolean {
    if (this._status !== "running" || this.finished) return false
    this._status = "paused"
    this.sem.paused = true
    this.emit({ type: "run_paused", runId: this.runId })
    this.markDirty()
    return true
  }

  resume(): boolean {
    if (this._status !== "paused" || this.finished) return false
    this._status = "running"
    this.sem.paused = false
    this.sem.pump()
    this.emit({ type: "run_resumed", runId: this.runId })
    this.markDirty()
    return true
  }

  // -------------------------------------------------------------------------------------------

  private async prepare(): Promise<void> {
    const { store } = this.opts
    const loc = (await store.findRun(this.runId)) ?? (await store.createRun(this.opts.sessionKey, this.runId))
    this.dir = loc.dir
    if (this.opts.scriptPath) this.scriptPath = this.opts.scriptPath
    else if (this.opts.source !== undefined) this.scriptPath = await store.writeScript(this.runId, this.opts.source)
    else this.scriptPath = join(loc.dir, SCRIPT_FILE)
  }

  private async main(): Promise<void> {
    try {
      await this.ready
    } catch (e) {
      this.error = `could not prepare run directory: ${errorMessage(e)}`
      await this.finish("failed")
      return
    }
    this.emit({ type: "run_started", runId: this.runId, summary: this.summary() })
    this.markDirty()

    let res: Awaited<ReturnType<typeof executeProgram>>
    try {
      const program = buildProgram(this.opts.body, this.opts.args)
      res = await executeProgram(program, this.globals({ depth: 0 }), {
        signal: this.controller.signal,
        timeoutMs: this.opts.timeoutMs,
      })
    } catch (e) {
      res = { ok: false, kind: "ExecutionFailure", error: errorMessage(e) }
    }
    for (const line of res.logs ?? []) this.logs.push(line)

    if (this.stopRequested) await this.finish("stopped")
    else if (res.ok) {
      this.resultValue = (res.value ?? null) as Json
      await this.finish("completed")
    } else {
      this.error = res.error
      await this.finish("failed")
    }
  }

  private async finish(status: RunStatus): Promise<void> {
    this.finished = true
    this._status = status
    this.endedAt = this.now()
    // Stop agents the script started but never awaited (or all of them, on stop/failure).
    this.sem.paused = false
    if (!this.controller.signal.aborted) this.controller.abort()
    this.cancelSummaryTimer()
    // Let the aborted agents record their final status and usage first, so the summary that
    // result() (the task notification) delivers is not stale. Bounded by finishGraceMs.
    await this.drainAgents(this.opts.finishGraceMs ?? DEFAULT_FINISH_GRACE_MS)
    this.cancelSummaryTimer()
    await this.drainIo()
    const summary = this.summary()
    await this.io(() => this.opts.store.writeSummary(summary))
    this.emit({ type: "run_finished", runId: this.runId, summary })
    this.resolveResult(summary)
    void this.settled()
  }

  private globals(ctx: ExecContext): Record<string, Function> {
    return {
      __agent: (prompt: unknown, opts: unknown) => this.callAgent(ctx, prompt, opts),
      __phase: (title: unknown) => this.setPhase(ctx, String(title)),
      __log: (message: unknown) => this.log(ctx, String(message)),
      __workflow: (ref: unknown, args: unknown, hasArgs: unknown) => this.callWorkflow(ctx, ref, args, hasArgs !== false),
      __budget_total: () => this.budgetTotal,
      __budget_spent: () => this.budgetSpent(),
    }
  }

  private budgetSpent(): number {
    let n = 0
    // Cached (replayed) agents cost nothing this turn (P34).
    for (const r of this.records) if (r && r.status !== "cached") n += budgetTokens(r.usage)
    return n
  }

  private addPhase(title: string) {
    if (!this.phaseOrder.includes(title)) this.phaseOrder.push(title)
  }

  private setPhase(ctx: ExecContext, title: string) {
    ctx.phase = title
    this.addPhase(title)
    this.emit({ type: "phase", runId: this.runId, title })
    this.markDirty()
  }

  private log(ctx: ExecContext, message: string) {
    const line = ctx.name ? `[${ctx.name}] ${message}` : message
    this.logs.push(line)
    this.emit({ type: "log", runId: this.runId, message: line })
    this.markDirty()
  }

  private warn(message: string) {
    this.warnings.push(message)
    this.emit({ type: "warning", runId: this.runId, message })
    this.markDirty()
  }

  // ---- agent() ------------------------------------------------------------------------------

  private callAgent(ctx: ExecContext, prompt: unknown, rawOpts: unknown): Promise<Json> {
    // Everything up to index assignment is synchronous, so indices follow call order.
    if (this.finished || this.controller.signal.aborted) return Promise.reject(new Error("the workflow run is no longer running"))
    if (typeof prompt !== "string") return Promise.reject(new TypeError("agent() expects a prompt string as its first argument"))
    let opts: AgentOptions
    try {
      opts = normalizeAgentOptions(rawOpts)
    } catch (e) {
      return Promise.reject(e)
    }
    if (opts.schema) {
      const problem = preflightSchema(opts.schema)
      if (problem) return Promise.reject(new Error(`agent() schema rejected before the agent started: ${problem}`))
    }
    if (this.records.length >= this.maxAgents) {
      return Promise.reject(new Error(`agent limit reached: a workflow run can start at most ${this.maxAgents} agents`))
    }

    const index = this.nextIndex
    const key = agentKey(prompt, opts)
    const phase = opts.phase ?? ctx.phase
    const label = opts.label ?? defaultLabel(prompt, index)
    if (phase !== undefined) this.addPhase(phase)

    const cached = this.opts.resume?.take(index, key)
    if (cached) {
      this.nextIndex++
      const t = this.now()
      const record: AgentRecord = { index, key, label, phase, prompt, opts, status: "cached", usage: { ...cached.usage }, startedAt: t, endedAt: t }
      if (cached.sessionID) record.sessionID = cached.sessionID
      record.result = cached.value === undefined ? null : cached.value
      this.records[index] = record
      this.afterSchedule()
      this.emitAgent(record)
      // Re-journal so this run can itself be resumed.
      const entry: JournalEntry = { ...cached }
      this.io(() => this.opts.store.appendJournal(this.runId, entry))
      this.io(() => this.opts.store.writeAgentRecord(this.runId, { ...record }))
      this.markDirty()
      return Promise.resolve(cached.value === undefined ? null : cached.value)
    }

    if (this.budgetTotal !== null) {
      const spent = this.budgetSpent()
      if (spent >= this.budgetTotal) {
        return Promise.reject(
          new Error(`budget exhausted: ${spent} of ${this.budgetTotal} tokens spent; agent() cannot start more agents`),
        )
      }
    }

    this.nextIndex++
    const record: AgentRecord = { index, key, label, phase, prompt, opts, status: "queued", usage: { ...ZERO_USAGE } }
    this.records[index] = record
    const liveAgent: LiveAgent = { record, controller: new AbortController(), userStopped: false }
    this.live.set(index, liveAgent)
    this.afterSchedule()
    this.emitAgent(record)
    this.markDirty()

    const task = this.runAgent(liveAgent)
    const tracked = task.then(
      () => {},
      () => {},
    )
    this.agentTasks.add(tracked)
    void tracked.then(() => this.agentTasks.delete(tracked))
    return task
  }

  private afterSchedule() {
    const n = this.records.length
    const threshold = this.opts.largeWorkflowThreshold ?? LARGE_WORKFLOW_AGENT_THRESHOLD
    if (!this.largeWarned && n > threshold) {
      this.largeWarned = true
      this.warn(`Large workflow: more than ${threshold} agents scheduled; watch it with /workflows and stop it there if needed`)
    }
  }

  private async runAgent(a: LiveAgent): Promise<Json> {
    const { record, controller } = a
    const runSignal = this.controller.signal
    const onRunAbort = () => controller.abort()
    if (runSignal.aborted) controller.abort()
    else runSignal.addEventListener("abort", onRunAbort, { once: true })

    try {
      const granted = await this.sem.acquire(controller.signal)
      if (!granted) {
        // Stopped while queued: never started.
        if (a.userStopped) {
          this.settleAgent(a, { status: "failed", error: "stopped by user before it started", usage: { ...ZERO_USAGE } }, true)
        } else {
          record.status = "stopped"
          record.endedAt = this.now()
          this.emitAgent(record)
          this.markDirty()
        }
        return null
      }

      let outcome: AgentOutcome
      try {
        record.status = "running"
        record.startedAt = this.now()
        this.emitAgent(record)
        this.markDirty()
        this.io(() => this.opts.store.writeAgentRecord(this.runId, { ...record }))
        try {
          outcome = await this.opts.runner.run({
            runId: this.runId,
            index: record.index,
            prompt: record.prompt,
            opts: record.opts,
            phase: record.phase,
            signal: controller.signal,
            onUpdate: (u) => this.onAgentUpdate(record, u),
          })
        } catch (e) {
          outcome = controller.signal.aborted
            ? { status: "stopped", usage: { ...record.usage } }
            : { status: "failed", error: errorMessage(e), usage: { ...record.usage } }
        }
      } finally {
        this.sem.release()
      }
      return this.settleAgent(a, outcome, false)
    } finally {
      runSignal.removeEventListener("abort", onRunAbort)
      this.live.delete(record.index)
    }
  }

  private onAgentUpdate(record: AgentRecord, u: Partial<AgentRecord>) {
    if (record.status !== "running") return
    // A new child session id is persisted right away: after a crash the agent record on disk is the
    // only link from the transcript to that (suspended) session.
    const newSession = typeof u.sessionID === "string" && u.sessionID !== record.sessionID
    if (typeof u.sessionID === "string") record.sessionID = u.sessionID
    if (newSession) this.io(() => this.opts.store.writeAgentRecord(this.runId, { ...record }))
    if (u.usage) record.usage = { ...ZERO_USAGE, ...u.usage }
    // Runner notes (P26 effort ignored) and a kept worktree (P28) belong on the record/status view.
    if (Array.isArray(u.warnings)) record.warnings = u.warnings.map(String)
    if (typeof u.worktree === "string") record.worktree = u.worktree
    this.emitAgent(record)
    this.markDirty()
  }

  /** Records and journals the outcome; returns agent()'s value or throws for schema_failed. */
  private settleAgent(a: LiveAgent, outcome: AgentOutcome, neverStarted: boolean): Json {
    const { record } = a
    record.usage = { ...ZERO_USAGE, ...outcome.usage }
    if (outcome.sessionID) record.sessionID = outcome.sessionID
    record.endedAt = this.now()

    let entry: JournalEntry
    let value: Json = null
    let thrown: Error | undefined
    const base = { type: "result" as const, index: record.index, key: record.key, usage: { ...record.usage } }
    const sid = record.sessionID ? { sessionID: record.sessionID } : {}

    if (outcome.status === "completed") {
      record.status = "completed"
      value = outcome.value === undefined ? null : outcome.value
      record.result = value
      entry = { ...base, status: "completed", value, ...sid }
    } else if (a.userStopped) {
      // P51: stopping one agent counts as failing it.
      record.status = "failed"
      record.error = outcome.status === "stopped" ? "stopped by user" : `stopped by user: ${"error" in outcome ? outcome.error : ""}`
      entry = { ...base, status: "failed", error: record.error, ...sid }
    } else if (this.controller.signal.aborted && outcome.status !== "schema_failed") {
      // P44: a whole-run stop (or the script ending) never counts an agent as failed.
      record.status = "stopped"
      entry = { ...base, status: "stopped", ...sid }
    } else if (outcome.status === "stopped") {
      record.status = "stopped"
      entry = { ...base, status: "stopped", ...sid }
    } else {
      record.status = "failed"
      record.error = outcome.error
      entry = { ...base, status: "failed", error: outcome.error, ...sid }
      if (outcome.status === "schema_failed") thrown = new Error(outcome.error)
    }

    if (!neverStarted || record.status === "failed") {
      this.io(() => this.opts.store.appendJournal(this.runId, entry))
    }
    this.io(() => this.opts.store.writeAgentRecord(this.runId, { ...record }))
    this.emitAgent(record)
    this.markDirty()
    if (thrown) throw thrown
    return value
  }

  // ---- workflow() ---------------------------------------------------------------------------

  private async callWorkflow(ctx: ExecContext, rawRef: unknown, args: unknown, hasArgs = true): Promise<unknown> {
    if (ctx.depth >= 1) {
      throw new Error("workflow() cannot be nested: a workflow started by workflow() cannot start another workflow")
    }
    const resolver = this.opts.resolveWorkflow
    if (!resolver) throw new Error("workflow() is not available: this host has no saved-workflow resolver")
    let ref: WorkflowRef
    if (typeof rawRef === "string" && rawRef.trim()) ref = rawRef
    else if (isPlainObject(rawRef) && typeof rawRef.scriptPath === "string" && rawRef.scriptPath) ref = { scriptPath: rawRef.scriptPath }
    else throw new TypeError("workflow() expects a saved workflow name or { scriptPath }")

    const resolved = await resolver(ref)
    const name = resolved.meta?.name || (typeof ref === "string" ? ref : ref.scriptPath)
    const child: ExecContext = { depth: ctx.depth + 1, phase: ctx.phase, name }
    // codemode delivers undefined as null, so the prelude says whether args were given: an
    // omitted (or undefined) argument leaves the child's `args` undefined, an explicit null stays null.
    const program = buildProgram(resolved.body, hasArgs ? args : undefined)
    const res = await executeProgram(program, this.globals(child), { signal: this.controller.signal })
    for (const line of res.logs ?? []) this.logs.push(`[${name}] ${line}`)
    if (!res.ok) throw new Error(`workflow "${name}" failed: ${res.error}`)
    return res.value
  }

  // ---- persistence & events -----------------------------------------------------------------

  private emit(event: WorkflowEvent) {
    const cb = this.opts.onEvent
    if (!cb) return
    try {
      cb(event)
    } catch {
      // listeners must not break the run
    }
  }

  private emitAgent(record: AgentRecord) {
    this.emit({ type: "agent", runId: this.runId, record: { ...record } })
  }

  /** Runs a store write after the run directory exists; failures never break the run. Resolves true on success. */
  private io(fn: () => Promise<unknown>): Promise<boolean> {
    const p = this.ready.then(fn).then(
      () => true,
      () => false,
    )
    this.ioTasks.add(p)
    void p.then(() => this.ioTasks.delete(p))
    return p
  }

  /** Waits until no agent runner call is pending, or graceMs elapsed. */
  private async drainAgents(graceMs: number): Promise<void> {
    if (this.agentTasks.size === 0) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<void>((r) => (timer = setTimeout(r, graceMs)))
    const agents = (async () => {
      while (this.agentTasks.size > 0) await Promise.all([...this.agentTasks])
    })()
    await Promise.race([agents, timeout])
    clearTimeout(timer)
  }

  private async drainIo(): Promise<void> {
    while (this.ioTasks.size > 0) await Promise.all([...this.ioTasks])
  }

  private async drain(): Promise<void> {
    while (this.agentTasks.size > 0 || this.ioTasks.size > 0) {
      await Promise.all([...this.agentTasks, ...this.ioTasks])
    }
  }

  private markDirty() {
    if (this.finished || this.summaryTimer || !this.started) return
    const delay = Math.max(0, this.lastSummaryWrite + this.throttleMs - Date.now())
    this.summaryTimer = setTimeout(() => {
      this.summaryTimer = undefined
      if (this.finished) return
      this.lastSummaryWrite = Date.now()
      const snapshot = this.summary()
      this.io(() => this.opts.store.writeSummary(snapshot))
    }, delay)
  }

  private cancelSummaryTimer() {
    if (this.summaryTimer) clearTimeout(this.summaryTimer)
    this.summaryTimer = undefined
  }
}

/** Creates and starts a workflow run. */
export function startRun(opts: StartRunOptions): WorkflowRun {
  return new WorkflowRun(opts).start()
}
