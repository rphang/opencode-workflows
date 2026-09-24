// Client state and pure logic of the TUI progress tree (X14–X16). No Solid or opentui imports, so
// everything here is unit-tested without a renderer; src/tui/index.tsx only maps it to the UI.
//
// Data flow: `list` (resync) → TreeStore.beginSync + replace; RPC `delta` events → TreeStore.apply (a seq
// gap, or a new server-instance epoch, asks for a resync); `finished` → TreeStore.finished (+ notifyFinished
// once per run). Deltas and finished events that arrive while a `list` call is in flight are replayed
// over its (possibly older) result. The view renders rowsFor(...) and dispatches keys through actionFor(...).

import { activityText, formatCost, formatDuration, formatTokens } from "../plugin/format.ts"
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

const STATUS_ICON: Record<string, string> = {
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

function normDir(d: string, caseInsensitive: boolean): string {
  const s = d.replaceAll("\\", "/").replace(/\/+$/, "")
  return caseInsensitive ? s.toLowerCase() : s
}

/** True when a run belongs to the filter's Location and (unless null) session. */
export function acceptRun(
  r: Pick<RunView, "directory" | "parentSessionID">,
  f: Filter,
  caseInsensitive: boolean = process.platform === "win32",
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

// ---- fitting text to a width ---------------------------------------------------------------------

/**
 * One piece of a line. When the line is too wide, pieces with `drop` are removed and pieces with
 * `clip` are shortened (to at least `min` cells, ending in "…"), lowest priority number first; pieces
 * with neither are kept. opentui's own `truncate` cuts the MIDDLE of a line, which hid the numbers
 * users look for, so the view fits every line before it reaches the renderer.
 */
export interface Segment {
  text: string
  drop?: number
  clip?: number
  min?: number
  /** A later, deeper cut of the same piece: at priority `at`, down to `min` cells. */
  clipMore?: { at: number; min: number }
  /** Shorter forms of the same piece: at priority `at`, the text becomes `text` (when that is shorter). */
  alt?: { at: number; text: string }[]
}

/** Terminal cells, counting one per code point (the glyphs used here are all narrow). */
function cells(s: string): number {
  return [...s].length
}

function clipEnd(s: string, n: number): string {
  const chars = [...s]
  if (chars.length <= n) return s
  if (n <= 0) return ""
  if (n === 1) return "…"
  return `${chars.slice(0, n - 1).join("")}…`
}

/** Joins the segments, shortening them (see Segment) until the result fits `width` cells. */
export function fitSegments(segments: Segment[], width: number = Number.POSITIVE_INFINITY): string {
  const segs = segments.map((x) => ({ ...x }))
  const total = () => segs.reduce((n, x) => n + cells(x.text), 0)
  const join = () => segs.map((x) => x.text).join("")
  if (!(width < Number.POSITIVE_INFINITY) || total() <= width) return join()
  const steps: { order: number; kind: "drop" | "clip" | "alt"; min: number; seg: Segment; text?: string }[] = []
  for (const seg of segs) {
    for (const a of seg.alt ?? []) steps.push({ order: a.at, kind: "alt", min: 0, seg, text: a.text })
    if (seg.clip !== undefined) steps.push({ order: seg.clip, kind: "clip", min: seg.min ?? 1, seg })
    if (seg.clipMore) steps.push({ order: seg.clipMore.at, kind: "clip", min: seg.clipMore.min, seg })
    if (seg.drop !== undefined) steps.push({ order: seg.drop, kind: "drop", min: 0, seg })
  }
  steps.sort((a, b) => a.order - b.order)
  for (const step of steps) {
    const excess = total() - width
    if (excess <= 0) break
    if (step.kind === "drop") step.seg.text = ""
    else if (step.kind === "alt") {
      if (cells(step.text!) < cells(step.seg.text)) step.seg.text = step.text!
    } else {
      const len = cells(step.seg.text)
      const target = Math.max(step.min, len - excess)
      if (target < len) step.seg.text = clipEnd(step.seg.text, target)
    }
  }
  return clipEnd(join(), Math.max(0, Math.floor(width)))
}

/** Key hints of the panel, with the order in which they go when the panel is narrow. */
const HELP_HINTS: { text: string; drop?: number }[] = [
  { text: "↑↓ move", drop: 3 },
  { text: "←→ fold", drop: 0 },
  { text: "enter open" },
  { text: "x stop" },
  { text: "p pause" },
  { text: "m/M message" },
  { text: "a scope", drop: 1 },
  { text: "esc close", drop: 2 },
]

/** The panel's key help line; with a `width`, whole hints are dropped (never cut in half). */
export function helpText(width?: number): string {
  let hints = [...HELP_HINTS]
  const join = () => hints.map((h) => h.text).join(" · ")
  if (width === undefined) return join()
  const order = hints.filter((h) => h.drop !== undefined).sort((a, b) => a.drop! - b.drop!)
  for (const h of order) {
    if (cells(join()) <= width) break
    hints = hints.filter((x) => x !== h)
  }
  return clipEnd(join(), Math.max(0, Math.floor(width)))
}

// ---- footer ------------------------------------------------------------------------------------

function progress(r: RunView): string {
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
  return { name: `wf ${top.workflowName}${paused}`, stats: ` ${progress(top)}${mine.length > 1 ? ` +${mine.length - 1}` : ""}` }
}

/**
 * Prompt footer: `wf <name> <done>/<total> · <tokens> · $<cost>` for the session's newest active run,
 * `+n` for more. With a `width`, the workflow name is shortened first so the counts stay whole.
 */
export function footerText(runs: RunView[], sessionID: string | null | undefined, width?: number): string {
  const parts = footerParts(runs, sessionID)
  if (!parts) return ""
  const paused = parts.name.endsWith(" ‖") ? " ‖" : ""
  const name = parts.name.slice(3, parts.name.length - paused.length)
  return fitSegments([{ text: "wf " }, { text: name, clip: 1, min: 3 }, { text: paused }, { text: parts.stats }], width)
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

const NO_PHASE = "(no phase)"

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
function messagesText(m: AgentView["messages"]): string {
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

/**
 * A model as a row piece (X19): the provider goes first, then the variant, then the name is shortened
 * (`clip`, down to `min` cells) and finally dropped (`drop`).
 */
function modelSegment(model: string | null, wrap: (m: string) => string, fit: { clip: number; min: number; drop: number }): Segment {
  if (!model) return { text: "" }
  const [full, ...shorter] = modelForms(model)
  // Without a variant there is one shorter form (no provider); with one, two (then no variant).
  const at = shorter.length > 1 ? [-1, -0.5] : [-1]
  return { text: wrap(full!), alt: shorter.map((m, i) => ({ at: at[i]!, text: wrap(m) })), ...fit }
}

/**
 * One row as text, fitted to `width` cells when given: the runId goes first, then the steered count;
 * a model loses its provider, then its variant (X19); an agent's activity and a phase's model label
 * are shortened, then its label or title and its model, before the activity and then the model go;
 * names are shortened last. Status, counts, tokens, cost and elapsed time are always kept.
 */
export function rowText(row: Row, now: number = Date.now(), width?: number): string {
  return fitSegments(rowSegments(row, now), width)
}

function rowSegments(row: Row, now: number): Segment[] {
  if (row.kind === "run") {
    const r = row.run
    const time = formatDuration((r.endedAt ?? now) - r.startedAt)
    return [
      { text: r.workflowName, clip: 2, min: 4 },
      { text: `  ${STATUS_ICON[r.status] ?? "?"} ${r.status}  ${progress(r)} · ${time}` },
      { text: r.steeredAgents ? ` · ${r.steeredAgents} steered` : "", drop: 1 },
      { text: `  ${r.runId}`, drop: 0 },
    ]
  }
  if (row.kind === "phase") {
    const p = row.phase
    const parts = [`${p.done}/${p.agents}`]
    if (p.running) parts.push(`${p.running} running`)
    if (p.tokens) parts.push(formatTokens(p.tokens))
    if (p.elapsedMs !== null) parts.push(formatDuration(p.elapsedMs))
    return [
      { text: row.last ? "└" : "├" },
      { text: ` ${row.title}`, clip: 1, min: 6, clipMore: { at: 3, min: 2 } },
      modelSegment(p.model, (m) => ` (${m})`, { clip: 1.5, min: 8, drop: 2 }),
      { text: `  ${parts.join(" · ")}` },
    ]
  }
  const a = row.agent
  const prefix = `${row.phaseLast ? " " : "│"} ${row.last ? "└" : "├"} `
  let stats = `  ${STATUS_ICON[a.status] ?? "?"}`
  if (a.status === "queued") stats += " queued"
  else {
    stats += ` ${formatTokens(a.tokens)}`
    if (a.startedAt !== null) stats += ` ${formatDuration((a.endedAt ?? now) - a.startedAt)}`
  }
  let detail = ""
  if (a.status === "running" && a.activity) detail = `  ${activityText(a.activity)}`
  if (a.status === "failed" && a.error) detail = `  ${a.error.split("\n")[0]}`
  const msgs = messagesText(a.messages)
  return [
    { text: `${prefix}#${a.index}` },
    { text: ` ${a.label}`, clip: 1, min: 16, clipMore: { at: 3, min: 6 } },
    { text: stats },
    modelSegment(a.model, (m) => `  ${m}`, { clip: 1.5, min: 10, drop: 2.5 }),
    { text: detail, clip: 0, min: 12, drop: 2 },
    { text: msgs ? `  ${msgs}` : "" },
  ]
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

// ---- Location target -----------------------------------------------------------------------------

export type Route = { type: "home" } | { type: "session"; sessionID: string } | { type: string; [k: string]: unknown }

interface SessionLike {
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

export interface AttentionLike {
  notify(o: { title?: string; message: string; notification?: boolean | { when?: "always" | "focused" | "blurred" }; sound?: boolean }): Promise<{
    notification: boolean
    sound: boolean
  }>
}

export interface ToastLike {
  show(o: { title?: string; message: string; variant?: "info" | "success" | "warning" | "error" }): void
}

/**
 * A run finished: a desktop notification when the terminal is unfocused (attention.notify with
 * when:"blurred"); an in-app toast when that is skipped (focused, attention disabled, focus unknown).
 */
export async function notifyFinished(
  e: Pick<FinishedEvent, "workflowName" | "status" | "agents" | "tokens" | "cost" | "durationMs">,
  ui: { attention?: AttentionLike; toast: ToastLike },
): Promise<"notified" | "toast"> {
  const title = `Workflow ${e.workflowName} ${e.status}`
  const message = `${e.agents} agents · ${formatTokens(e.tokens)} tokens · ${formatCost(e.cost)} · ${formatDuration(e.durationMs)}`
  try {
    const r = await ui.attention?.notify({ title, message, notification: { when: "blurred" }, sound: false })
    if (r?.notification || r?.sound) return "notified"
  } catch {
    // no renderer / attention unsupported: fall back to the toast
  }
  ui.toast.show({ title, message, variant: e.status === "completed" ? "success" : "warning" })
  return "toast"
}
