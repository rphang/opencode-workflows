// Live activity of running workflow agents (X11): a display-only overlay for the progress views,
// built from opencode's global event stream (ctx.event.subscribe()).
//
// Only events whose sessionID belongs to a tracked child session are kept (the host tracks a child
// once the engine reports its session id, and untracks it when the agent settles). The overlay never
// feeds AgentRecord.usage or budget.spent(): the engine still takes the authoritative usage from
// session.get() when the agent settles (P34 is unchanged).
//
// Event shapes (verified live on opencode 2.0.15, docs/design/steering-and-live-tree.md §B.2):
//   session.step.started {model:{id, providerID}}      → model, activity "waiting"
//   session.tool.input.started {id, name}              → activity "tool": name
//   session.tool.called {id, input}                    → activity "tool": name + one-line input summary
//   session.text.started / .delta {delta} / .ended {text}          → activity "text": last 80 chars
//   session.reasoning.started / .delta                  → activity "reasoning"
//   session.usage.updated {cost, tokens} (cumulative)   → live tokens and cost
//   session.inbox.delivered                             → delivered message count
// Anything else (execution.*, step.ended, …) changes nothing: the engine status is authoritative.

import { safeText } from "./live.ts"

export type ActivityKind = "tool" | "text" | "reasoning" | "waiting"

export interface AgentActivity {
  /** "providerID/id" of the model the child's last step ran on. */
  model: string | null
  kind: ActivityKind
  /** One line, at most ACTIVITY_CHARS characters. */
  text: string
  /** Time of the event that set `kind`/`text` (event `created`, ms). */
  at: number
  /** Cumulative session tokens (input + output + reasoning + cache) from session.usage.updated. */
  tokens: number
  cost: number
  /** Inbox items delivered into the session (steering messages and the first prompt). */
  delivered: number
  /** Internal: tool call id → tool name, and the streamed text of the current part. */
  tools: Record<string, string>
  buffer: string
}

export const ACTIVITY_CHARS = 80
const BUFFER_CHARS = 400
const MAX_TOOL_IDS = 32

/** One line, without control characters or bidi overrides (see safeText in live.ts). */
function oneLine(s: string): string {
  return safeText(s).replace(/\s+/g, " ").trim()
}

/** Keeps the END of the text (the part being written right now). */
function tail(s: string, n = ACTIVITY_CHARS): string {
  const t = oneLine(s)
  return t.length > n ? `…${t.slice(t.length - (n - 1))}` : t
}

/** Keeps the START of the text (a path, a command). */
function head(s: string, n = ACTIVITY_CHARS): string {
  const t = oneLine(s)
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

const INPUT_KEYS = ["filePath", "path", "file", "url", "command", "pattern", "query", "prompt", "description"]

/** "webfetch https://…", "bash npm test", "read src/a.ts": the tool name plus its most telling input. */
export function summarizeToolInput(name: string, input: unknown): string {
  let detail = ""
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const rec = input as Record<string, unknown>
    // A pattern is more telling than the directory it searches.
    const order = "pattern" in rec ? ["pattern", ...INPUT_KEYS.filter((k) => k !== "pattern")] : INPUT_KEYS
    const key = order.find((k) => typeof rec[k] === "string" && (rec[k] as string).trim())
    if (key) detail = oneLine(rec[key] as string)
    else {
      try {
        detail = JSON.stringify(input)
      } catch {
        detail = ""
      }
    }
  } else if (typeof input === "string") detail = oneLine(input)
  return head(detail ? `${name} ${detail}` : name)
}

function modelName(m: unknown): string | null {
  if (!m || typeof m !== "object") return null
  const { id, providerID } = m as { id?: unknown; providerID?: unknown }
  if (typeof id !== "string" || !id) return null
  return typeof providerID === "string" && providerID ? `${providerID}/${id}` : id
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0
}

function empty(at: number): AgentActivity {
  return { model: null, kind: "waiting", text: "", at, tokens: 0, cost: 0, delivered: 0, tools: {}, buffer: "" }
}

/**
 * Applies one opencode event to an agent's activity. Returns the new activity, or undefined when the
 * event does not change it (not a kind the overlay uses). Pure: `prev` is never mutated.
 */
export function reduceActivity(prev: AgentActivity | undefined, event: any): AgentActivity | undefined {
  const type = typeof event?.type === "string" ? event.type : ""
  const d = event?.data ?? {}
  const at = num(event?.created) || Date.now()
  const base = () => prev ?? empty(at)
  switch (type) {
    case "session.step.started":
      return { ...base(), model: modelName(d.model) ?? base().model, kind: "waiting", text: "", at }
    case "session.tool.input.started": {
      const name = typeof d.name === "string" && d.name ? d.name : "tool"
      const tools = { ...base().tools }
      if (typeof d.id === "string") tools[d.id] = name
      const ids = Object.keys(tools)
      if (ids.length > MAX_TOOL_IDS) for (const id of ids.slice(0, ids.length - MAX_TOOL_IDS)) delete tools[id]
      return { ...base(), tools, kind: "tool", text: head(name), at }
    }
    case "session.tool.called": {
      const b = base()
      const name = (typeof d.id === "string" && b.tools[d.id]) || (typeof d.name === "string" && d.name) || "tool"
      return { ...b, kind: "tool", text: summarizeToolInput(name, d.input), at }
    }
    case "session.text.started":
      return { ...base(), kind: "text", text: "", buffer: "", at }
    case "session.text.delta": {
      const buffer = `${base().buffer}${typeof d.delta === "string" ? d.delta : ""}`.slice(-BUFFER_CHARS)
      return { ...base(), kind: "text", buffer, text: tail(buffer), at }
    }
    case "session.text.ended": {
      const text = typeof d.text === "string" && d.text ? d.text : base().buffer
      return { ...base(), kind: "text", buffer: "", text: tail(text), at }
    }
    case "session.reasoning.started":
      return { ...base(), kind: "reasoning", text: "", buffer: "", at }
    case "session.reasoning.delta": {
      const buffer = `${base().buffer}${typeof d.delta === "string" ? d.delta : ""}`.slice(-BUFFER_CHARS)
      return { ...base(), kind: "reasoning", buffer, text: tail(buffer), at }
    }
    case "session.usage.updated": {
      const t = d.tokens ?? {}
      const tokens = num(t.input) + num(t.output) + num(t.reasoning) + num(t.cache?.read) + num(t.cache?.write)
      return { ...base(), tokens, cost: num(d.cost) }
    }
    case "session.inbox.delivered":
      return { ...base(), delivered: base().delivered + 1 }
    default:
      return undefined
  }
}

export interface ActivityTapOptions {
  /** ctx.event.subscribe; undefined (or throwing) leaves the overlay empty. */
  subscribe?: (signal: AbortSignal) => AsyncIterable<any>
  /** Called after an agent's activity changed. */
  onChange: (runId: string, index: number) => void
}

/** Subscribes once to the event stream and keeps the activity of tracked child sessions. */
export class ActivityTap {
  private readonly sessions = new Map<string, { runId: string; index: number }>()
  private readonly activity = new Map<string, AgentActivity>()
  private readonly abort = new AbortController()
  private iterator: AsyncIterator<any> | undefined
  private running = false

  constructor(private readonly opts: ActivityTapOptions) {}

  start(): void {
    if (this.running || !this.opts.subscribe) return
    let iterable: AsyncIterable<any>
    try {
      iterable = this.opts.subscribe(this.abort.signal)
      this.iterator = iterable[Symbol.asyncIterator]()
    } catch {
      return
    }
    this.running = true
    void (async () => {
      try {
        while (this.running) {
          const r = await this.iterator!.next()
          if (r.done) break
          this.handle(r.value)
        }
      } catch {
        // The stream ended (server shutdown, reconnect failure): the views keep the engine status.
      }
      this.running = false
    })()
  }

  async stop(): Promise<void> {
    this.running = false
    this.abort.abort()
    const it = this.iterator
    this.iterator = undefined
    try {
      await Promise.race([it?.return?.(), new Promise((r) => setTimeout(r, 200))])
    } catch {}
  }

  /** Starts keeping the events of `sessionID` for agent #index of run `runId`. */
  track(sessionID: string, runId: string, index: number): void {
    this.sessions.set(sessionID, { runId, index })
  }

  /** Forgets a child session (its agent settled) and its activity. */
  untrack(sessionID: string): void {
    const who = this.sessions.get(sessionID)
    this.sessions.delete(sessionID)
    if (who) this.activity.delete(`${who.runId}#${who.index}`)
  }

  /** Forgets every session of a run. */
  forgetRun(runId: string): void {
    for (const [sid, who] of this.sessions) if (who.runId === runId) this.untrack(sid)
  }

  get(runId: string, index: number): AgentActivity | undefined {
    return this.activity.get(`${runId}#${index}`)
  }

  /** The activity of every tracked agent of a run, by agent index. */
  forRun(runId: string): Map<number, AgentActivity> {
    const out = new Map<number, AgentActivity>()
    for (const who of this.sessions.values()) {
      if (who.runId !== runId) continue
      const a = this.activity.get(`${who.runId}#${who.index}`)
      if (a) out.set(who.index, a)
    }
    return out
  }

  private handle(event: any): void {
    const sid = event?.data?.sessionID
    if (typeof sid !== "string") return
    const who = this.sessions.get(sid)
    if (!who) return
    const key = `${who.runId}#${who.index}`
    const next = reduceActivity(this.activity.get(key), event)
    if (!next) return
    this.activity.set(key, next)
    try {
      this.opts.onChange(who.runId, who.index)
    } catch {}
  }
}
