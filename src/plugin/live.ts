// Live views of workflow runs for the progress tree (X10–X13): the RunView / AgentView shapes the
// `dynamic-workflows` RPC returns and emits, strict-JSON conversion, and the LiveBus that coalesces
// engine and activity changes into at most one `delta` event per 250 ms (4 Hz).
//
// Every view carries `directory` (the plugin instance's Location) and `parentSessionID`, so a TUI
// can filter opencode's single global event stream without a round trip (design §B.6).

import { totalTokens, type AgentRecord, type AgentStatus, type Json, type PhaseSummary, type RunStatus, type RunSummary } from "../types.ts"
import type { ActivityKind, AgentActivity } from "./activity.ts"
import { shownModel } from "./format.ts"

export interface PhaseView {
  title: string
  /**
   * meta.phases[].model when declared (X10); otherwise the distinct models its agents run on (X19: one
   * shared model, or the first two and +n); null when unknown.
   */
  model: string | null
  agents: number
  done: number
  running: number
  tokens: number
  elapsedMs: number | null
}

export interface RunView {
  runId: string
  workflowName: string
  description: string
  status: RunStatus
  parentSessionID: string | null
  /** The plugin instance's Location directory (client-side filtering). */
  directory: string
  startedAt: number
  endedAt: number | null
  agents: { total: number; done: number; running: number; queued: number }
  /** Recorded usage plus the live overlay of running agents. */
  tokens: number
  cost: number
  phases: PhaseView[]
  ungrouped: PhaseView | null
  steeredAgents: number
  warnings: number
  error: string | null
}

export interface AgentView {
  runId: string
  index: number
  label: string
  phase: string | null
  status: AgentStatus
  sessionID: string | null
  /**
   * The model it runs on, `provider/model#variant` (X18, X19): the recorded one, unless its live step
   * runs on another model (then that one); else the one its options name; null when unknown.
   */
  model: string | null
  tokens: number
  cost: number
  startedAt: number | null
  endedAt: number | null
  activity: { kind: ActivityKind; text: string; at: number } | null
  messages: { sent: number; delivered: number; held: number }
  worktree: string | null
  error: string | null
}

export interface FinishedEvent {
  runId: string
  parentSessionID: string | null
  directory: string
  workflowName: string
  status: RunStatus
  agents: number
  tokens: number
  cost: number
  durationMs: number
}

/** A value the RPC layer accepts: undefined dropped (null in arrays), non-finite numbers → null. */
export function toJson(value: unknown): Json {
  if (value === null || value === undefined) return null
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (typeof value === "string" || typeof value === "boolean") return value
  if (Array.isArray(value)) return value.map((v) => (v === undefined || typeof v === "function" ? null : toJson(v)))
  if (typeof value === "object") {
    const out: Record<string, Json> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined || typeof v === "function") continue
      out[k] = toJson(v)
    }
    return out
  }
  return null
}

/**
 * C0/C1 control characters (ESC, BEL, …; tab and newline are kept) and bidi overrides/isolates. Model
 * output, tool inputs, labels and error strings can contain them; the views never pass them on, so a
 * client that draws them into a terminal (the TUI tree, notification titles) cannot be steered by them.
 */
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g

/** Text with the unsafe characters removed (line breaks kept). */
export function safeText(s: string): string {
  return s.replace(UNSAFE, "")
}

/** One line of safe text (tabs and line breaks become spaces). */
export function safeLine(s: string): string {
  return safeText(s).replace(/[\t\n]+/g, " ")
}

const optLine = (s: string | null | undefined): string | null => (typeof s === "string" ? safeLine(s) : null)
const optText = (s: string | null | undefined): string | null => (typeof s === "string" ? safeText(s) : null)

function isLive(status: AgentStatus): boolean {
  return status === "running"
}

function messageCounts(r: AgentRecord): AgentView["messages"] {
  const out = { sent: 0, delivered: 0, held: 0 }
  for (const m of r.messages ?? []) {
    if (m.status === "held") out.held++
    else if (m.status === "delivered") out.delivered++
    else if (m.status === "sent") out.sent++
  }
  return out
}

export function buildAgentView(runId: string, r: AgentRecord, activity?: AgentActivity): AgentView {
  const a = isLive(r.status) ? activity : undefined
  const recorded = r.status === "cached" ? 0 : totalTokens(r.usage)
  return {
    runId,
    index: r.index,
    label: safeLine(String(r.label ?? "")),
    phase: optLine(r.phase),
    status: r.status,
    sessionID: r.sessionID ?? null,
    model: optLine(shownModel(r.model, a?.model, r.opts?.model ?? null)),
    tokens: Math.max(recorded, a?.tokens ?? 0),
    cost: Math.max(r.status === "cached" ? 0 : r.usage.cost, a?.cost ?? 0),
    startedAt: r.startedAt ?? null,
    endedAt: r.endedAt ?? null,
    activity: a && (a.text || a.kind === "waiting") ? { kind: a.kind, text: safeLine(a.text), at: a.at } : null,
    messages: messageCounts(r),
    worktree: optLine(r.worktree),
    error: optText(r.error),
  }
}

/** "a/one", "a/one, b/two", "a/one, b/two +1". */
function modelsLabel(models: string[]): string | null {
  const distinct = [...new Set(models.filter(Boolean))]
  if (!distinct.length) return null
  const shown = distinct.slice(0, 2).join(", ")
  return distinct.length > 2 ? `${shown} +${distinct.length - 2}` : shown
}

export function buildRunView(
  s: RunSummary,
  agents: AgentRecord[] | undefined,
  activity: Map<number, AgentActivity> = new Map(),
  directory: string,
): RunView {
  const list = (agents ?? []).filter(Boolean)
  // Live overlay: tokens/cost a running agent has spent so far (recorded usage lands when it settles).
  const extra = new Map<string, { tokens: number; cost: number }>()
  let extraTokens = 0
  let extraCost = 0
  const models = new Map<string, string[]>()
  for (const r of list) {
    const group = r.phase ?? "(no phase)"
    const a = isLive(r.status) ? activity.get(r.index) : undefined
    const m = shownModel(r.model, a?.model, r.opts?.model ?? null)
    if (m) models.set(group, [...(models.get(group) ?? []), m])
    if (!a) continue
    const t = Math.max(0, a.tokens - totalTokens(r.usage))
    const c = Math.max(0, a.cost - r.usage.cost)
    extraTokens += t
    extraCost += c
    const e = extra.get(group) ?? { tokens: 0, cost: 0 }
    extra.set(group, { tokens: e.tokens + t, cost: e.cost + c })
  }
  const phase = (p: PhaseSummary): PhaseView => ({
    title: safeLine(p.title),
    model: optLine(p.model ?? modelsLabel(models.get(p.title) ?? []) ?? p.agentModel),
    agents: p.agents,
    done: p.done,
    running: p.running ?? 0,
    tokens: p.tokens + (extra.get(p.title)?.tokens ?? 0),
    elapsedMs: p.elapsedMs ?? null,
  })
  const counts = { total: s.agentCount, done: 0, running: 0, queued: 0 }
  if (list.length) {
    for (const r of list) {
      if (r.status === "running") counts.running++
      else if (r.status === "queued") counts.queued++
      else counts.done++
    }
  } else {
    for (const p of [...s.phases, ...(s.ungrouped ? [s.ungrouped] : [])]) {
      counts.done += p.done
      counts.running += p.running ?? 0
    }
    counts.queued = Math.max(0, s.agentCount - counts.done - counts.running)
  }
  return {
    runId: s.runId,
    workflowName: safeLine(s.workflowName),
    description: safeLine(s.description ?? ""),
    status: s.status,
    parentSessionID: s.parentSessionID ?? null,
    directory,
    startedAt: s.startedAt,
    endedAt: s.endedAt ?? null,
    agents: counts,
    tokens: totalTokens(s.usage) + extraTokens,
    cost: s.usage.cost + extraCost,
    phases: s.phases.map(phase),
    ungrouped: s.ungrouped ? phase(s.ungrouped) : null,
    steeredAgents: s.steeredAgents ?? 0,
    warnings: s.warnings?.length ?? 0,
    error: optText(s.error),
  }
}

export function finishedEvent(s: RunSummary, directory: string): FinishedEvent {
  return {
    runId: s.runId,
    parentSessionID: s.parentSessionID ?? null,
    directory,
    workflowName: safeLine(s.workflowName),
    status: s.status,
    agents: s.agentCount,
    tokens: totalTokens(s.usage),
    cost: s.usage.cost,
    durationMs: Math.max(0, (s.endedAt ?? s.startedAt) - s.startedAt),
  }
}

// ---------------------------------------------------------------------------------------------

export const DELTA_INTERVAL_MS = 250

export interface Delta {
  seq: number
  /** The bus (plugin instance) that numbered seq; a restarted plugin starts over at 1 with a new epoch. */
  epoch: string
  runs: RunView[]
  agents: AgentView[]
}

export interface LiveBusOptions {
  /** Emits one RPC event (reg.events.emit). Errors are swallowed. */
  emit: (name: "delta" | "finished", data: Record<string, Json>) => unknown
  /** Current views; undefined when the run (or agent) is gone. */
  views: {
    run: (runId: string) => RunView | undefined
    agent: (runId: string, index: number) => AgentView | undefined
  }
  intervalMs?: number
  now?: () => number
  timers?: { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void }
}

/**
 * Coalesces changes into `delta` events: a change marks its run (and agent) dirty, and dirty state is
 * flushed at most once per interval (the first change after a quiet period flushes on the next tick).
 * No timer runs while nothing is dirty.
 */
export class LiveBus {
  private readonly runs = new Set<string>()
  private readonly agents = new Map<string, { runId: string; index: number }>()
  private timer: unknown
  private lastFlush = Number.NEGATIVE_INFINITY
  private _seq = 0
  /** Random id of this bus: clients tell a restarted plugin instance (seq back to 1) from old events. */
  readonly epoch: string = Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
  private disposed = false
  private readonly interval: number
  private readonly now: () => number
  private readonly timers: NonNullable<LiveBusOptions["timers"]>

  constructor(private readonly opts: LiveBusOptions) {
    this.interval = opts.intervalMs ?? DELTA_INTERVAL_MS
    this.now = opts.now ?? Date.now
    this.timers = opts.timers ?? {
      set: (fn, ms) => {
        const t = setTimeout(fn, ms)
        ;(t as any).unref?.()
        return t
      },
      clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    }
  }

  /** Sequence number of the last delta (0 before the first one). */
  get seq(): number {
    return this._seq
  }

  markRun(runId: string): void {
    if (this.disposed) return
    this.runs.add(runId)
    this.schedule()
  }

  markAgent(runId: string, index: number): void {
    if (this.disposed) return
    this.agents.set(`${runId}#${index}`, { runId, index })
    this.runs.add(runId)
    this.schedule()
  }

  /** Emits a `finished` event right away (never coalesced). */
  finished(data: FinishedEvent): void {
    if (this.disposed) return
    this.send("finished", toJson(data) as Record<string, Json>)
  }

  /** Sends the pending delta now (if anything changed). */
  flush(): void {
    if (this.timer !== undefined) this.timers.clear(this.timer)
    this.timer = undefined
    if (this.disposed) return
    const runs: RunView[] = []
    for (const id of this.runs) {
      const v = safe(() => this.opts.views.run(id))
      if (v) runs.push(v)
    }
    const agents: AgentView[] = []
    for (const { runId, index } of this.agents.values()) {
      const v = safe(() => this.opts.views.agent(runId, index))
      if (v) agents.push(v)
    }
    this.runs.clear()
    this.agents.clear()
    this.lastFlush = this.now()
    if (!runs.length && !agents.length) return
    this.send("delta", toJson({ seq: ++this._seq, epoch: this.epoch, runs, agents }) as Record<string, Json>)
  }

  dispose(): void {
    this.disposed = true
    if (this.timer !== undefined) this.timers.clear(this.timer)
    this.timer = undefined
    this.runs.clear()
    this.agents.clear()
  }

  private schedule(): void {
    if (this.timer !== undefined) return
    const wait = Math.max(0, this.lastFlush + this.interval - this.now())
    this.timer = this.timers.set(() => {
      this.timer = undefined
      this.flush()
    }, wait)
  }

  private send(name: "delta" | "finished", data: Record<string, Json>): void {
    try {
      const r = this.opts.emit(name, data) as Promise<unknown> | undefined
      if (r && typeof (r as Promise<unknown>).catch === "function") (r as Promise<unknown>).catch(() => {})
    } catch {
      // The RPC registration may be gone (plugin reload); the next list() resyncs the client.
    }
  }
}

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn()
  } catch {
    return undefined
  }
}
