// Agent cache keys and resume replay (P41, P42).

import { createHash } from "node:crypto"
import type { RunStore } from "./store.ts"
import type { AgentOptions, JournalEntry, RunSummary } from "./types.ts"

/** JSON with object keys sorted recursively; undefined-valued properties dropped. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? "null"
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : sortKeys(x)))
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v).sort()) {
      const x = (v as Record<string, unknown>)[k]
      if (x !== undefined) out[k] = sortKeys(x)
    }
    return out
  }
  return v
}

/**
 * Stable identity of an agent() call for resume: sha256 over the prompt and the options that
 * change what the agent does. `label` and `phase` are presentation only and excluded.
 */
export function agentKey(prompt: string, opts: AgentOptions = {}): string {
  const o = opts ?? {}
  const material = canonicalJson({
    prompt,
    opts: {
      schema: o.schema,
      model: o.model,
      effort: o.effort,
      isolation: o.isolation,
      agentType: o.agentType,
    },
  })
  return createHash("sha256").update(material).digest("hex")
}

/**
 * Replays a prior run's journal in agent START order (P41). A call is served from cache only
 * while no divergence has happened yet and the prior entry at that index exists, completed, and
 * has the same key. The first miss makes every later call run live. An agent that was steered
 * (X06: in `steered`, or its entry flagged `steered`) is always a miss: its result depended on
 * messages that are not part of its key and are not replayed.
 */
export class ReplayCursor {
  private byIndex = new Map<number, JournalEntry>()
  private expected = 0
  private _hits = 0
  private _diverged = false

  constructor(
    entries: readonly JournalEntry[],
    private readonly steered: ReadonlySet<number> = new Set(),
  ) {
    for (const e of entries) this.byIndex.set(e.index, e) // last line for an index wins
  }

  get hits(): number {
    return this._hits
  }

  get diverged(): boolean {
    return this._diverged
  }

  take(index: number, key: string): JournalEntry | undefined {
    if (this._diverged) return undefined
    const e = this.byIndex.get(index)
    if (index !== this.expected || !e || e.status !== "completed" || e.key !== key || e.steered || this.steered.has(index)) {
      this._diverged = true
      return undefined
    }
    this.expected++
    this._hits++
    return e
  }
}

export interface ResumeState {
  runId: string
  summary?: RunSummary
  entries: JournalEntry[]
  /** Agent indices that received steering messages (X06). */
  steered: Set<number>
  cursor: ReplayCursor
}

/** Loads a prior run for resume. Throws `nothing to resume` when it or its journal is missing/empty (P42). */
export async function loadForResume(store: RunStore, runId: string): Promise<ResumeState> {
  const loc = await store.findRun(runId)
  if (!loc) throw new Error(`nothing to resume: run ${runId} was not found`)
  const entries = await store.readJournal(runId)
  if (entries.length === 0) throw new Error(`nothing to resume: run ${runId} has no saved agent results`)
  const summary = await store.readSummary(runId)
  const steered = new Set((await store.readJournalMessages(runId)).map((m) => m.index))
  // X18: journals written before the model was journaled take it from the run's agent records.
  for (const e of entries) {
    if (e.model !== undefined || e.status !== "completed") continue
    const rec = await store.readAgentRecord(runId, e.index).catch(() => undefined)
    if (rec && rec.key === e.key && typeof rec.model === "string" && rec.model) e.model = rec.model
  }
  return { runId, summary, entries, steered, cursor: new ReplayCursor(entries, steered) }
}
