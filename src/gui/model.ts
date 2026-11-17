// Pure logic of the desktop app companion (X28–X30): what the composer pill, the side panel tree and
// the finish notice show, computed from the shared client state (src/client/tree.ts). No Solid, no
// DOM and no host calls: src/gui/window.tsx and src/gui/panel.tsx render these values and call the
// host, and tests/parity/gui.test.ts checks them without a renderer.

import type { ComposerPillTone, IconName, NotifyOptions, ToastOptions } from "@opencode/plugin/gui"
import { formatDuration, formatTokens, activityText } from "../plugin/format.ts"
import type { FinishedEvent, RunView } from "../plugin/live.ts"
import {
  actionFor,
  finishMessage,
  footerParts,
  isActive,
  messagesText,
  progressText,
  STATUS_ICON,
  targetFor,
  type Action,
  type Row,
  type SessionLike,
  type TreeStore,
} from "../client/tree.ts"
import en from "./i18n/en.ts"

/** The panel's id; its host key is `${plugin id}:tree`. */
export const PANEL_ID = "tree"

export function panelKey(pluginID: string): string {
  return `${pluginID}:${PANEL_ID}`
}

// ---- copy ----------------------------------------------------------------------------------------

export type Params = Record<string, string | number | boolean>
export type Translate = (key: string, params?: Params) => string

/** `ctx.t` for tests and as a fallback: `{{name}}` interpolation, the key itself when it is missing. */
export function translator(messages: Readonly<Record<string, string>> = en): Translate {
  return (key, params) => {
    const template = messages[key]
    if (template === undefined) return key
    return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, name: string) => (params && name in params ? String(params[name]) : m))
  }
}

// ---- targets and the per-Location syncs ----------------------------------------------------------

/** Where a session's tree lives: its server, and the session and Location the runs belong to. */
export interface SessionTarget {
  serverID: string
  sessionID: string | null
  directory: string
}

/**
 * The target of a session shown in a tab: itself and its directory, or, for a workflow child (its
 * metadata names the run and the parent), the parent session and the parent's Location (design §B.6).
 * `getSession` reads the server's synced session data; one it does not know (or that throws) counts as
 * unknown.
 */
export function sessionTarget(
  s: { serverID: string; sessionID: string; directory: string },
  getSession: (id: string) => SessionLike | undefined,
): SessionTarget {
  const safe = (id: string): SessionLike | undefined => {
    try {
      return getSession(id) ?? undefined
    } catch {
      return undefined
    }
  }
  const t = targetFor({ type: "session", sessionID: s.sessionID }, safe, s.directory)
  return { serverID: s.serverID, sessionID: t.sessionID, directory: t.directory }
}

/** One TreeSync per server and Location (every run there; views filter by session). */
export function entryKey(serverID: string, directory: string): string {
  return `${serverID}\n${directory}`
}

/** The server/Location pairs the open sessions need, by entryKey (a target without a directory yet is skipped). */
export function wantedEntries(targets: Iterable<SessionTarget>): Map<string, { serverID: string; directory: string }> {
  const out = new Map<string, { serverID: string; directory: string }>()
  for (const t of targets) {
    if (!t.serverID || !t.directory) continue
    const key = entryKey(t.serverID, t.directory)
    if (!out.has(key)) out.set(key, { serverID: t.serverID, directory: t.directory })
  }
  return out
}

/** Which syncs to start and which to dispose so the map matches the open sessions. */
export function reconcilePlan(existing: Iterable<string>, wanted: Map<string, unknown>): { create: string[]; dispose: string[] } {
  const have = new Set(existing)
  return {
    create: [...wanted.keys()].filter((k) => !have.has(k)),
    dispose: [...have].filter((k) => !wanted.has(k)),
  }
}

// ---- composer pill (X28) -------------------------------------------------------------------------

export interface PillRow {
  /** The run id. */
  id: string
  label: string
  detail: string
  icon: IconName
  tone?: ComposerPillTone
}

export interface PillView {
  label: string
  title: string
  icon: IconName
  tone?: ComposerPillTone
  rows: PillRow[]
}

function runTone(tree: TreeStore, r: RunView): ComposerPillTone | undefined {
  if (r.error || tree.agentsOf(r.runId).some((a) => a.status === "failed")) return "danger"
  if (r.status === "paused" || (r.warnings ?? 0) > 0) return "warning"
  return undefined
}

/** A run as the client may receive it from an older server plugin: missing fields read as defaults. */
function normalized(r: RunView): RunView {
  return {
    ...r,
    agents: { total: 0, done: 0, running: 0, queued: 0, ...((r.agents as Partial<RunView["agents"]> | undefined) ?? {}) },
    tokens: Number(r.tokens) || 0,
    cost: Number(r.cost) || 0,
    startedAt: Number(r.startedAt) || 0,
    workflowName: r.workflowName || r.runId,
  }
}

/**
 * The pill above a session's composer: `wf <done>/<total> · <tokens> · $<cost>` of its newest active
 * run (` +n` for more), the name (and `‖ paused`) as its title, one row per active run. Danger tone on a
 * run error or a failed agent, warning while paused or with warnings. Undefined (no pill) when the
 * session has no active run.
 */
export function pillView(tree: TreeStore, sessionID: string | null | undefined, t: Translate = translator()): PillView | undefined {
  if (!sessionID) return undefined
  const runs = [...tree.runs.values()].map(normalized)
  const parts = footerParts(runs, sessionID)
  if (!parts) return undefined
  const mine = runs.filter((r) => isActive(r) && r.parentSessionID === sessionID).sort((a, b) => b.startedAt - a.startedAt)
  const top = mine[0]!
  const rows = mine.map((r): PillRow => {
    const tone = runTone(tree, r)
    return {
      id: r.runId,
      label: r.workflowName,
      detail: progressText(r),
      icon: r.status === "paused" ? "circle-exclamation" : "status-active",
      ...(tone ? { tone } : {}),
    }
  })
  const tones = rows.map((r) => r.tone)
  const tone = tones.includes("danger") ? "danger" : tones.includes("warning") ? "warning" : undefined
  return {
    label: `wf${parts.stats}`,
    title: t(top.status === "paused" ? "pill.titlePaused" : "pill.title", { name: top.workflowName }),
    icon: "branch-out",
    ...(tone ? { tone } : {}),
    rows,
  }
}

// ---- panel rows (X29) ----------------------------------------------------------------------------

export type ButtonID = "fold" | "open" | "pause" | "resume" | "stop" | "message" | "urgent"

export interface RowButton {
  id: ButtonID
  /** The actionFor key the button dispatches. */
  key: string
  icon: IconName
  label: string
}

const BUTTON_ICON: Record<ButtonID, IconName> = {
  fold: "chevron-down",
  open: "square-arrow-top-right",
  pause: "circle-ban-sign",
  resume: "refresh",
  stop: "stop",
  message: "speech-bubble",
  urgent: "outline-steer",
}

/**
 * The buttons of a row: each dispatches `actionFor(row, key)`, the same action as the TUI key, and is
 * shown only when that action applies (not a "not running" toast). Fold on run and phase rows (the one
 * direction that changes something), open (unless it is the session the panel is next to), pause or
 * resume on run rows, stop, message and urgent message.
 */
export function rowButtons(row: Row, opts: { open: boolean; viewedSessionID?: string | null }, t: Translate = translator()): RowButton[] {
  const out: RowButton[] = []
  const add = (id: ButtonID, key: string, label: string, icon: IconName = BUTTON_ICON[id]) => out.push({ id, key, icon, label })
  const applies = (a: Action | null): a is Action => !!a && a.type !== "toast"
  if (row.kind !== "agent") {
    const key = opts.open ? "left" : "right"
    if (applies(actionFor(row, key))) add("fold", key, t(opts.open ? "button.collapse" : "button.expand"), opts.open ? "chevron-down" : "chevron-right")
  }
  if (row.kind !== "phase") {
    const a = actionFor(row, "return")
    if (applies(a) && !(a.type === "open" && opts.viewedSessionID && a.sessionID === opts.viewedSessionID)) add("open", "return", t("button.open"))
  }
  if (row.kind === "run") {
    const a = actionFor(row, "p")
    if (applies(a) && a.type === "control") {
      const resume = a.control.action === "resume"
      add(resume ? "resume" : "pause", "p", t(resume ? "button.resume" : "button.pause"))
    }
  }
  if (applies(actionFor(row, "x"))) add("stop", "x", t("button.stop"))
  if (applies(actionFor(row, "m"))) add("message", "m", t("button.message"))
  if (applies(actionFor(row, "M"))) add("urgent", "M", t("button.urgent"))
  return out
}

export type RowTone = "danger" | "warning" | "success" | "muted"

export interface RowTextView {
  glyph: string
  title: string
  detail: string
  depth: 0 | 1 | 2
  tone?: RowTone
}

const STATUS_TONE: Record<string, RowTone> = { failed: "danger", paused: "warning", completed: "success", stopped: "muted", cached: "muted" }

function firstLine(s: string): string {
  return s.split("\n")[0] ?? ""
}

/** A row as the panel shows it: a status glyph, a title and a muted detail line. */
export function rowText(row: Row, now: number = Date.now()): RowTextView {
  if (row.kind === "run") {
    const r = normalized(row.run)
    const time = formatDuration((r.endedAt ?? now) - r.startedAt)
    const parts = [r.status, progressText(r), time]
    if (r.steeredAgents) parts.push(`${r.steeredAgents} steered`)
    parts.push(r.runId)
    const tone = r.error ? "danger" : STATUS_TONE[r.status]
    return { glyph: STATUS_ICON[r.status] ?? "?", title: r.workflowName, detail: parts.join(" · "), depth: 0, ...(tone ? { tone } : {}) }
  }
  if (row.kind === "phase") {
    const p = row.phase
    const parts = [`${p.done}/${p.agents}`]
    if (p.running) parts.push(`${p.running} running`)
    if (p.tokens) parts.push(formatTokens(p.tokens))
    if (p.elapsedMs !== null && p.elapsedMs !== undefined) parts.push(formatDuration(p.elapsedMs))
    if (p.model) parts.unshift(p.model)
    return { glyph: p.running ? STATUS_ICON.running! : p.done >= p.agents ? STATUS_ICON.completed! : STATUS_ICON.queued!, title: row.title, detail: parts.join(" · "), depth: 1 }
  }
  const a = row.agent
  const parts: string[] = [a.status]
  if (a.status !== "queued") {
    parts.push(formatTokens(Number(a.tokens) || 0))
    if (a.startedAt !== null && a.startedAt !== undefined) parts.push(formatDuration((a.endedAt ?? now) - a.startedAt))
  }
  if (a.model) parts.push(a.model)
  if (a.status === "running" && a.activity) parts.push(activityText(a.activity))
  if (a.status === "failed" && a.error) parts.push(firstLine(a.error))
  const msgs = a.messages ? messagesText(a.messages) : ""
  if (msgs) parts.push(msgs)
  const tone = STATUS_TONE[a.status]
  return { glyph: STATUS_ICON[a.status] ?? "?", title: `#${a.index} ${a.label}`, detail: parts.join(" · "), depth: 2, ...(tone ? { tone } : {}) }
}

/** The panel's status line: "" when the tree is there, else why not (one line). */
export function panelLine(sync: { available: boolean; status: string } | undefined, t: Translate = translator()): string {
  if (!sync) return t("panel.unavailable")
  if (sync.available) return ""
  return sync.status || t("panel.loading")
}

// ---- toasts --------------------------------------------------------------------------------------

/** The host toast for an action's info message (a row action that does not apply). */
export function actionToast(a: Extract<Action, { type: "toast" }>): ToastOptions {
  return { title: a.message, variant: "default", icon: a.variant === "warning" ? "warning" : "info" }
}

/** The host toast for a `control` answer ({ok, message}). */
export function controlToast(res: unknown, t: Translate = translator()): ToastOptions {
  const r = (res && typeof res === "object" ? res : {}) as { ok?: unknown; message?: unknown }
  return {
    title: t("control.title"),
    description: typeof r.message === "string" && r.message ? r.message : t("control.done"),
    variant: r.ok === true ? "success" : "error",
  }
}

// ---- finish notice (X30) -------------------------------------------------------------------------

export interface NotifyPlan {
  notify: NotifyOptions & { session: { server: string; id: string }; id: string }
  toast: ToastOptions
}

/**
 * The notice for a finished run: a system notification (the user's Agent or Errors notification
 * settings), opening the run's parent session on click and sent at most once across the app's windows
 * (`id`), plus the toast to show instead when it was not shown. Null unless the parent session is
 * open in a tab on that server.
 */
export function notifyPlan(
  e: Pick<FinishedEvent, "runId" | "parentSessionID" | "workflowName" | "status" | "agents" | "tokens" | "cost" | "durationMs">,
  serverID: string,
  open: readonly { serverID: string; sessionID: string }[],
): NotifyPlan | null {
  const parent = e.parentSessionID
  if (!parent || !open.some((s) => s.serverID === serverID && s.sessionID === parent)) return null
  const m = finishMessage({
    workflowName: e.workflowName || e.runId,
    status: e.status,
    agents: Number(e.agents) || 0,
    tokens: Number(e.tokens) || 0,
    cost: Number(e.cost) || 0,
    durationMs: Number(e.durationMs) || 0,
  })
  return {
    notify: {
      title: m.title,
      message: m.message,
      variant: e.status === "failed" ? "error" : "default",
      session: { server: serverID, id: parent },
      id: `dynamic-workflows:${serverID}:${e.runId}`,
    },
    toast: { title: m.title, description: m.message, variant: e.status === "completed" ? "success" : e.status === "failed" ? "error" : "default" },
  }
}

/**
 * Whether a window toasts a finish after `attention.notify` answered: only when no system notification
 * was shown (a window has focus, the user turned it off, or another window sent it first), and only in
 * the focused window or one showing that session, so a toast is not repeated in every window.
 */
export function shouldToast(result: { notification: boolean; sound?: boolean }, where: { showsSession: boolean; focused: boolean }): boolean {
  return !result.notification && (where.showsSession || where.focused)
}
