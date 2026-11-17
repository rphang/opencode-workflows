// Terminal rendering of the live progress tree (X14–X16): fitting rows, the footer and the key help to
// a width in cells, and the finish notification through the TUI's attention API. The host-agnostic
// state and logic (TreeStore, rows, actions, targets) live in src/client/tree.ts and are re-exported
// here, so the TUI imports one module. No Solid or opentui imports: unit-tested without a renderer.

import { activityText, formatDuration, formatTokens } from "../plugin/format.ts"
import type { FinishedEvent, RunView } from "../plugin/live.ts"
import { finishMessage, footerParts, messagesText, modelForms, progressText, STATUS_ICON, type Row } from "../client/tree.ts"

export {
  acceptRun,
  actionFor,
  agentKey,
  finishMessage,
  footerParts,
  homeFooterText,
  isActive,
  isOpen,
  messagesText,
  modelForms,
  NO_PHASE,
  phaseKey,
  PICKER_ACTIONS,
  pickerAction,
  pickerCurrent,
  pickerOptions,
  pickerSearch,
  progressText,
  rowsFor,
  runKey,
  STATUS_ICON,
  targetFor,
  TreeStore,
  type Action,
  type ControlRequest,
  type Expanded,
  type Filter,
  type ListResult,
  type PickerKey,
  type PickerOption,
  type PickerValue,
  type Route,
  type Row,
  type SessionLike,
} from "../client/tree.ts"

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

// ---- rows ----------------------------------------------------------------------------------------

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
      { text: `  ${STATUS_ICON[r.status] ?? "?"} ${r.status}  ${progressText(r)} · ${time}` },
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
  const { title, message, variant } = finishMessage(e)
  try {
    const r = await ui.attention?.notify({ title, message, notification: { when: "blurred" }, sound: false })
    if (r?.notification || r?.sound) return "notified"
  } catch {
    // no renderer / attention unsupported: fall back to the toast
  }
  ui.toast.show({ title, message, variant })
  return "toast"
}
