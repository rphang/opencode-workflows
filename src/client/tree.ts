// Host-agnostic client logic of the live progress tree (X14–X16), shared by the TUI (src/tui/) and
// any other companion (a GUI). No Solid, opentui, node builtins or `process`: it runs in a browser.
//
// Data flow: `list` (resync) → TreeStore.beginSync + replace; RPC `delta` events → TreeStore.apply (a seq
// gap, or a new server-instance epoch, asks for a resync); `finished` → TreeStore.finished (+ a finish
// notification once per run). Deltas and finished events that arrive while a `list` call is in flight
// are replayed over its (possibly older) result. src/client/sync.ts drives this against the RPC; a view
// renders rowsFor(...) and dispatches keys through actionFor(...).

import { formatCost, formatDuration, formatTokens } from "../plugin/format.ts"
import type { AgentView, FinishedEvent, PhaseView, RunView } from "../plugin/live.ts"

/** Which runs the tree shows: one Location, and one session's runs (null = every run there). */
export interface Filter {
  directory: string
  sessionID: string | null
}

/** Input of the RPC `control` method. */
export interface ControlRequest {
  runId: string
  action: "stop" | "stop_agent" | "pause" | "resume" | "message"
  agentIndex?: number
  phase?: string
  all?: boolean
  text?: string
  urgent?: boolean
}

export interface ListResult {
  seq: number
  /** The server plugin instance that numbered `seq` (a restarted instance starts over at 1). */
  epoch?: string | null
  runs: RunView[]
  agents: AgentView[]
}

type Buffered = { kind: "delta"; delta: ListResult } | { kind: "finished"; event: FinishedEvent }

/** Status glyphs of runs and agents (narrow ones only: emoji-capable glyphs render double-width). */
export const STATUS_ICON: Record<string, string> = {
  running: "●",
  paused: "‖",
  completed: "✓",
  failed: "✗",
  stopped: "■",
  queued: "◌",
  cached: "↺",
}

export function isActive(r: Pick<RunView, "status">): boolean {
  return r.status === "running" || r.status === "paused"
}

/** A Windows drive path (`C:\…`, `c:/…`): compared case-insensitively. */
const DRIVE_PATH = /^[a-z]:[\\/]/i

function normDir(d: string, caseInsensitive: boolean): string {
  const s = d.replaceAll("\\", "/").replace(/\/+$/, "")
  return caseInsensitive ? s.toLowerCase() : s
}

/**
 * True when a run belongs to the filter's Location and (unless null) session. Directories are
 * compared case-insensitively when either is a Windows drive path (decided from the path, so it
 * works in a browser too), unless `caseInsensitive` says otherwise.
 */
export function acceptRun(
  r: Pick<RunView, "directory" | "parentSessionID">,
  f: Filter,
  caseInsensitive: boolean = DRIVE_PATH.test(r.directory) || DRIVE_PATH.test(f.directory),
): boolean {
  if (normDir(r.directory, caseInsensitive) !== normDir(f.directory, caseInsensitive)) return false
  return f.sessionID === null || r.parentSessionID === f.sessionID
}

/** Runs and agents as the client knows them, merged from list/status results and delta events. */
export class TreeStore {
  readonly runs = new Map<string, RunView>()
  readonly agents = new Map<string, Map<number, AgentView>>()
  seq = 0
  /** Epoch of the server instance `seq` belongs to (null until known). */
  epoch: string | null = null
  /** Runs already known as finished (their `finished` event must not notify again). */
  private readonly finishedSeen = new Set<string>()
  /** Events received while a `list` call is in flight (null when no sync is running). */
  private buffered: Buffered[] | null = null

  /** A `list` call starts: events from now on are replayed over its result (see replace). */
  beginSync(): void {
    this.buffered = []
  }

  /** The `list` call failed: stop buffering. */
  endSync(): void {
    this.buffered = null
  }

  /**
   * Replaces everything with a `list` result (resync). The events received since beginSync() are
   * applied again on top when they are newer (same epoch, higher seq), so a list computed before them
   * never rewinds the tree.
   */
  replace(list: ListResult): void {
    const buffered = this.buffered ?? []
    this.buffered = null
    this.runs.clear()
    this.agents.clear()
    this.merge(list.runs, list.agents)
    this.seq = list.seq
    this.epoch = list.epoch ?? null
    for (const r of list.runs) if (r?.runId && !isActive(r)) this.finishedSeen.add(r.runId)
    for (const b of buffered) {
      if (b.kind === "finished") {
        this.applyFinished(b.event)
        continue
      }
      const d = b.delta
      if ((d.epoch ?? null) !== this.epoch || d.seq <= this.seq) continue
      this.merge(d.runs ?? [], d.agents ?? [])
      this.seq = d.seq
    }
  }

  /** Merges a `status` result (one run and all its agents). */
  mergeStatus(run: RunView, agents: AgentView[]): void {
    this.agents.delete(run.runId)
    this.merge([run], agents)
  }

  /**
   * Applies a `delta` event. `gap` means events were missed: call `list` again. A delta from another
   * server instance (a new epoch: the plugin restarted and its seq started over) is applied and asks
   * for a resync; within one epoch a repeated seq is ignored and a lower one asks for a resync.
   */
  apply(delta: ListResult): { gap: boolean } {
    this.buffered?.push({ kind: "delta", delta })
    const epoch = delta.epoch ?? null
    if (epoch !== null && this.epoch !== null && epoch !== this.epoch) {
      this.merge(delta.runs ?? [], delta.agents ?? [])
      this.epoch = epoch
      this.seq = delta.seq
      return { gap: true }
    }
    if (epoch !== null && this.epoch === null) this.epoch = epoch
    if (delta.seq === this.seq) return { gap: false }
    if (delta.seq < this.seq) return { gap: true }
    const gap = this.seq > 0 && delta.seq !== this.seq + 1
    this.merge(delta.runs ?? [], delta.agents ?? [])
    this.seq = delta.seq
    return { gap }
  }

  /**
   * Applies a `finished` event (its totals are final). True the first time for a run the tree shows
   * and did not already know as finished: only then should the view notify.
   */
  finished(e: FinishedEvent): boolean {
    this.buffered?.push({ kind: "finished", event: e })
    if (!this.runs.has(e.runId) || this.finishedSeen.has(e.runId)) {
      this.applyFinished(e)
      return false
    }
    this.finishedSeen.add(e.runId)
    this.applyFinished(e)
    return true
  }

  private applyFinished(e: FinishedEvent): void {
    const r = this.runs.get(e.runId)
    if (!r) return
    this.runs.set(e.runId, {
      ...r,
      status: e.status,
      endedAt: typeof e.durationMs === "number" ? r.startedAt + e.durationMs : r.endedAt,
      tokens: typeof e.tokens === "number" ? e.tokens : r.tokens,
      cost: typeof e.cost === "number" ? e.cost : r.cost,
    })
  }

  /** Runs passing the filter: active first (newest first), then finished ones (newest first). */
  visibleRuns(f: Filter): RunView[] {
    const all = [...this.runs.values()].filter((r) => acceptRun(r, f))
    const byNew = (a: RunView, b: RunView) => b.startedAt - a.startedAt || (a.runId < b.runId ? 1 : -1)
    return [...all.filter(isActive).sort(byNew), ...all.filter((r) => !isActive(r)).sort(byNew)]
  }

  agentsOf(runId: string): AgentView[] {
    return [...(this.agents.get(runId)?.values() ?? [])].sort((a, b) => a.index - b.index)
  }

  private merge(runs: RunView[], agents: AgentView[]): void {
    for (const r of runs) if (r?.runId) this.runs.set(r.runId, r)
    for (const a of agents) {
      if (!a?.runId) continue
      let m = this.agents.get(a.runId)
      if (!m) this.agents.set(a.runId, (m = new Map()))
      m.set(a.index, a)
    }
  }
}

// ---- footer ------------------------------------------------------------------------------------

/** `<done>/<total> · <tokens> · $<cost>` of a run. */
export function progressText(r: RunView): string {
  return `${r.agents.done}/${r.agents.total} · ${formatTokens(r.tokens)} · ${formatCost(r.cost)}`
}

/**
 * The prompt footer in two parts: `name` (`wf <name>`, plus ` ‖` when paused) may be shortened by the
 * view; `stats` (` <done>/<total> · <tokens> · $<cost>`, ` +n` for more active runs) never is. Null
 * when the session has no active run.
 */
export function footerParts(runs: RunView[], sessionID: string | null | undefined): { name: string; stats: string } | null {
  if (!sessionID) return null
  const mine = runs.filter((r) => isActive(r) && r.parentSessionID === sessionID).sort((a, b) => b.startedAt - a.startedAt)
  const top = mine[0]
  if (!top) return null
  const paused = top.status === "paused" ? " ‖" : ""
  return { name: `wf ${top.workflowName}${paused}`, stats: ` ${progressText(top)}${mine.length > 1 ? ` +${mine.length - 1}` : ""}` }
}

/** Home footer: `wf <n> running` for the Location. */
export function homeFooterText(runs: RunView[]): string {
  const n = runs.filter(isActive).length
  return n ? `wf ${n} running` : ""
}

// ---- rows ----------------------------------------------------------------------------------------

export type Row =
  | { kind: "run"; key: string; run: RunView }
  | { kind: "phase"; key: string; run: RunView; title: string; phase: PhaseView; last: boolean; grouped: boolean }
  | { kind: "agent"; key: string; run: RunView; agent: AgentView; last: boolean; phaseLast: boolean }

export const runKey = (runId: string) => `run:${runId}`
export const phaseKey = (runId: string, title: string) => `phase:${runId}:${title}`
export const agentKey = (runId: string, index: number) => `agent:${runId}:${index}`

/** Explicit expand/collapse choices by row key; unset keys use the default (active runs open). */
export type Expanded = Map<string, boolean>

export const NO_PHASE = "(no phase)"

/**
 * The tree as rows: run → phases → agents, honouring the expand choices. By default active runs and
 * the newest run are open (so a run the user is watching does not fold up when it finishes).
 */
export function rowsFor(s: TreeStore, expanded: Expanded, f: Filter): Row[] {
  const rows: Row[] = []
  const runs = s.visibleRuns(f)
  const newest = runs.reduce<RunView | undefined>((a, r) => (!a || r.startedAt > a.startedAt ? r : a), undefined)
  for (const run of runs) {
    const openByDefault = isActive(run) || run === newest
    const runOpen = expanded.get(runKey(run.runId)) ?? openByDefault
    rows.push({ kind: "run", key: runKey(run.runId), run })
    if (!runOpen) continue
    const agents = s.agentsOf(run.runId)
    const titles = new Set(run.phases.map((p) => p.title))
    const groups: { title: string; phase: PhaseView; grouped: boolean; agents: AgentView[] }[] = []
    for (const p of run.phases) {
      if (!(p.agents > 0 || isActive(run))) continue
      groups.push({ title: p.title, phase: p, grouped: true, agents: agents.filter((a) => a.phase === p.title) })
    }
    const loose = agents.filter((a) => a.phase === null || !titles.has(a.phase))
    const ungrouped = run.ungrouped ?? (loose.length ? syntheticGroup(loose) : null)
    if (ungrouped && ungrouped.agents > 0) groups.push({ title: NO_PHASE, phase: ungrouped, grouped: false, agents: loose })
    groups.forEach((g, gi) => {
      const last = gi === groups.length - 1
      const key = phaseKey(run.runId, g.title)
      rows.push({ kind: "phase", key, run, title: g.title, phase: g.phase, last, grouped: g.grouped })
      if (!(expanded.get(key) ?? openByDefault)) return
      g.agents.forEach((a, ai) => {
        rows.push({ kind: "agent", key: agentKey(run.runId, a.index), run, agent: a, last: ai === g.agents.length - 1, phaseLast: last })
      })
    })
  }
  return rows
}

/** True when the run or phase row `key` currently shows its children in `rows`. */
export function isOpen(rows: Row[], key: string): boolean {
  const i = rows.findIndex((r) => r.key === key)
  const cur = rows[i]
  const next = rows[i + 1]
  if (!cur || !next || next.run.runId !== cur.run.runId) return false
  if (cur.kind === "run") return next.kind === "phase"
  if (cur.kind === "phase") return next.kind === "agent"
  return false
}

function syntheticGroup(agents: AgentView[]): PhaseView {
  const done = agents.filter((a) => a.status !== "running" && a.status !== "queued").length
  return {
    title: NO_PHASE,
    model: null,
    agents: agents.length,
    done,
    running: agents.filter((a) => a.status === "running").length,
    tokens: agents.reduce((n, a) => n + a.tokens, 0),
    elapsedMs: null,
  }
}

/** "msg 2", "msg 1 held", "msg 2 +1 held" (plain text: ✉ renders double-width in some terminals). */
export function messagesText(m: AgentView["messages"]): string {
  const sent = m.sent + m.delivered
  if (sent && m.held) return `msg ${sent} +${m.held} held`
  if (sent) return `msg ${sent}`
  if (m.held) return `msg ${m.held} held`
  return ""
}

/**
 * The forms of a model shown in a row, longest first: `openai/gpt-5.4-mini#high`, `gpt-5.4-mini#high`,
 * `gpt-5.4-mini`. Text that is not a single `provider/model[#variant]` ref (a free-form phase label, a
 * list of models) has only itself.
 */
export function modelForms(model: string): string[] {
  const slash = model.indexOf("/")
  if (/[\s,]/.test(model) || slash <= 0 || slash === model.length - 1) return [model]
  const rest = model.slice(slash + 1)
  const hash = rest.indexOf("#")
  const bare = hash < 0 ? rest : rest.slice(0, hash)
  return [...new Set([model, rest, bare].filter(Boolean))]
}

// ---- actions -------------------------------------------------------------------------------------

export type Action =
  | { type: "open"; sessionID: string }
  | { type: "confirm"; title: string; message: string; control: ControlRequest }
  | { type: "control"; control: ControlRequest }
  | { type: "prompt"; title: string; description: string; control: ControlRequest }
  | { type: "expand"; key: string; open: boolean }
  | { type: "toggle"; key: string }
  | { type: "filter" }
  | { type: "toast"; message: string; variant: "info" | "warning" }

const notRunning = (r: RunView): Action => ({ type: "toast", message: `run ${r.runId} is ${r.status}`, variant: "info" })

/**
 * What a key does on a row. Keys: return (open), x (stop, after a confirm), p (pause/resume),
 * m / M (message / urgent message), left/right (collapse/expand), a (this session ↔ whole Location).
 */
export function actionFor(row: Row | undefined, key: string): Action | null {
  if (key === "a") return { type: "filter" }
  if (!row) return null
  const r = row.run
  const live = isActive(r)
  switch (key) {
    case "return":
      if (row.kind === "agent") {
        const a = row.agent
        return a.sessionID
          ? { type: "open", sessionID: a.sessionID }
          : { type: "toast", message: `#${a.index} has no session yet (it is ${a.status})`, variant: "info" }
      }
      if (row.kind === "run") {
        return r.parentSessionID
          ? { type: "open", sessionID: r.parentSessionID }
          : { type: "toast", message: `run ${r.runId} has no parent session`, variant: "info" }
      }
      return { type: "toggle", key: row.key }
    case "left":
    case "right":
      return row.kind === "agent" ? null : { type: "expand", key: row.key, open: key === "right" }
    case "x":
      if (row.kind === "phase") return null
      if (!live) return notRunning(r)
      if (row.kind === "run") {
        return {
          type: "confirm",
          title: "Stop workflow run",
          message: `Stop ${r.workflowName} (${r.runId})? Running agents are interrupted and are not counted as failed; the parent can resume the run later.`,
          control: { runId: r.runId, action: "stop" },
        }
      }
      if (row.agent.status !== "running" && row.agent.status !== "queued") {
        return { type: "toast", message: `#${row.agent.index} is ${row.agent.status}`, variant: "info" }
      }
      return {
        type: "confirm",
        title: "Stop agent",
        message: `Stop #${row.agent.index} ${row.agent.label}? It counts as failed and its agent() call returns null.`,
        control: { runId: r.runId, action: "stop_agent", agentIndex: row.agent.index },
      }
    case "p":
      if (r.status === "running") return { type: "control", control: { runId: r.runId, action: "pause" } }
      if (r.status === "paused") return { type: "control", control: { runId: r.runId, action: "resume" } }
      return notRunning(r)
    case "m":
    case "M": {
      if (!live) return notRunning(r)
      const urgent = key === "M"
      const description = urgent
        ? "Urgent: interrupts the agent's current step (that step's tokens are lost)."
        : "Read at the agent's next step boundary, without restarting it."
      const base = { runId: r.runId, action: "message" as const, urgent }
      if (row.kind === "agent") {
        const a = row.agent
        if (a.status !== "running" && a.status !== "queued") {
          return { type: "toast", message: `#${a.index} is ${a.status}; only running or queued agents get messages`, variant: "info" }
        }
        return { type: "prompt", title: `Message #${a.index} ${a.label}`, description, control: { ...base, agentIndex: a.index } }
      }
      if (row.kind === "phase") {
        if (!row.grouped) return { type: "toast", message: "agents outside a phase: message them one by one (select an agent)", variant: "info" }
        return { type: "prompt", title: `Message every running agent of ${row.title}`, description, control: { ...base, phase: row.title } }
      }
      return { type: "prompt", title: `Message every running agent of ${r.workflowName}`, description, control: { ...base, all: true } }
    }
    default:
      return null
  }
}

// ---- agent dialog (X25) --------------------------------------------------------------------------

/** Which agent a dialog option stands for (compared by value: a fresh object matches). */
export interface PickerValue {
  runId: string
  index: number
}

/** One option of the agent dialog: the host's select-option fields plus what search looks at. */
export interface PickerOption {
  title: string
  value: PickerValue
  description: string
  category: string
  label: string
  phase: string | null
  workflow: string
  runId: string
}

/** What the dialog can do with the highlighted agent: Enter steers, the footer actions do the rest. */
export type PickerKey = "steer" | "urgent" | "stop" | "open"

/** Footer actions of the agent dialog (ctrl+n / ctrl+p stay free: the list uses them to move). */
export const PICKER_ACTIONS: readonly { key: Exclude<PickerKey, "steer">; bind: string; title: string }[] = [
  { key: "urgent", bind: "ctrl+u", title: "urgent steer" },
  { key: "stop", bind: "ctrl+d", title: "stop" },
  { key: "open", bind: "ctrl+o", title: "open" },
]

const isLiveAgent = (a: AgentView) => a.status === "running" || a.status === "queued"

/** The running and queued agents of the active runs the filter shows (newest run first, then by index). */
export function pickerOptions(s: TreeStore, f: Filter): PickerOption[] {
  const out: PickerOption[] = []
  for (const r of s.visibleRuns(f)) {
    if (!isActive(r)) continue
    for (const a of s.agentsOf(r.runId)) {
      if (!isLiveAgent(a)) continue
      out.push({
        title: `#${a.index} ${a.label}`,
        value: { runId: r.runId, index: a.index },
        description: [a.status, a.phase, a.model].filter(Boolean).join(" · "),
        category: r.workflowName || r.runId,
        label: a.label,
        phase: a.phase,
        workflow: r.workflowName,
        runId: r.runId,
      })
    }
  }
  return out
}

/** The option of the row selected in the panel (an agent row), if the dialog lists it. */
export function pickerCurrent(options: readonly PickerOption[], rowKey: string | null | undefined): PickerValue | undefined {
  if (!rowKey) return undefined
  return options.find((o) => agentKey(o.value.runId, o.value.index) === rowKey)?.value
}

/**
 * The dialog's search: `#3` or `3` lists the agents with that index first, then those whose label
 * starts with the query, then those whose label, phase, workflow name or run id contains it
 * (case-insensitive). An empty query lists every option in order.
 */
export function pickerSearch<O extends Pick<PickerOption, "value" | "title"> & Partial<PickerOption>>(query: string, options: readonly O[]): O[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...options]
  const label = (o: O) => (o.label ?? o.title.replace(/^#\d+\s*/, "")).toLowerCase()
  const index = /^#?(\d+)$/.exec(q)
  const out: O[] = []
  const add = (pred: (o: O) => boolean) => {
    for (const o of options) if (!out.includes(o) && pred(o)) out.push(o)
  }
  if (index) add((o) => o.value.index === Number(index[1]))
  add((o) => label(o).startsWith(q))
  add((o) => [label(o), o.phase ?? "", o.workflow ?? o.category ?? "", o.runId ?? o.value.runId].some((t) => t.toLowerCase().includes(q)))
  return out
}

const PICKER_ROW_KEY: Record<PickerKey, string> = { steer: "m", urgent: "M", stop: "x", open: "return" }

/**
 * What a dialog key does for an agent, from its current row in the tree (it may have finished, or
 * gone, since the dialog opened): the same actions as the panel's m / M / x / Enter.
 */
export function pickerAction(s: TreeStore, value: PickerValue, key: PickerKey): Action {
  const run = s.runs.get(value.runId)
  const agent = s.agents.get(value.runId)?.get(value.index)
  if (!run || !agent) return { type: "toast", message: `#${value.index} of ${value.runId} is no longer listed`, variant: "info" }
  const row: Row = { kind: "agent", key: agentKey(run.runId, agent.index), run, agent, last: true, phaseLast: true }
  return actionFor(row, PICKER_ROW_KEY[key]) ?? { type: "toast", message: `#${agent.index} is ${agent.status}`, variant: "info" }
}

// ---- Location target -----------------------------------------------------------------------------

export type Route = { type: "home" } | { type: "session"; sessionID: string } | { type: string; [k: string]: unknown }

export interface SessionLike {
  id?: string
  location?: { directory?: string }
  metadata?: Record<string, unknown>
}

/**
 * Where the tree's RPC calls go and whose runs it shows (design §B.6): the viewed session and its
 * Location; for a workflow child session (worktree children live in other Locations), its parent's.
 */
export function targetFor(
  route: Route,
  getSession: (id: string) => SessionLike | undefined,
  defaultDirectory: string,
): { sessionID: string | null; directory: string } {
  if (route.type !== "session" || typeof (route as { sessionID?: unknown }).sessionID !== "string") {
    return { sessionID: null, directory: defaultDirectory }
  }
  const id = (route as { sessionID: string }).sessionID
  const info = getSession(id)
  const parentID = info?.metadata?.workflowRunId && typeof info.metadata.parentSessionID === "string" ? info.metadata.parentSessionID : undefined
  if (parentID) {
    const parent = getSession(parentID)
    return { sessionID: parentID, directory: parent?.location?.directory ?? info?.location?.directory ?? defaultDirectory }
  }
  return { sessionID: id, directory: info?.location?.directory ?? defaultDirectory }
}

// ---- finish notification (X16) -------------------------------------------------------------------

/** The text of a finish notification: `Workflow <name> <status>`, `<n> agents · <tokens> tokens · $<cost> · <time>`. */
export function finishMessage(e: Pick<FinishedEvent, "workflowName" | "status" | "agents" | "tokens" | "cost" | "durationMs">): {
  title: string
  message: string
  variant: "success" | "warning"
} {
  return {
    title: `Workflow ${e.workflowName} ${e.status}`,
    message: `${e.agents} agents · ${formatTokens(e.tokens)} tokens · ${formatCost(e.cost)} · ${formatDuration(e.durationMs)}`,
    variant: e.status === "completed" ? "success" : "warning",
  }
}
