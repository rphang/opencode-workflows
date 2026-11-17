// The resync driver of the live progress tree (X15, X27): keeps a TreeStore in step with the
// `dynamic-workflows` RPC. Host-agnostic (no Solid, opentui, node builtins or `process`), so the TUI
// and a GUI companion share it; a view calls start(), reads `tree` / `available` / `status` on
// onChange(), and calls checkTarget() when what it views may have changed.
//
//   - One `list` at a time. Events that arrive while it is in flight are replayed over its result
//     (TreeStore.beginSync/replace), and a resync asked for meanwhile runs once more afterwards: the
//     gap it reports may be newer than the list already in flight.
//   - `delta` events of the target Location are applied; a seq gap or a new epoch asks for a resync.
//   - `finished` events notify (onFinished) once per run the tree shows, for the viewed session only.
//   - Cold start (X27): opencode 2.3's `rpc.call` no longer waits for plugins to load, so the first
//     `list` can fail with rpc.unavailable. A failed list is retried after retryDelay(attempt) (250 ms
//     doubling to 4 s, then it gives up), quietly ("loading…") while the RPC is unavailable. Attempts
//     reset on success, on a target change and on refresh() (the TUI calls it on `plugin.updated`); a
//     delta from the target Location while not ready resyncs at once.

import type { FinishedEvent } from "../plugin/live.ts"
import { acceptRun, TreeStore, type Filter, type ListResult } from "./tree.ts"

/** An RPC event as the client delivers it: the emitting instance's Location and the payload. */
export interface RpcEvent {
  location?: { directory?: string }
  data?: unknown
}

/** The part of the `dynamic-workflows` RPC client the driver uses (ctx.client.rpc(definition) in the TUI). */
export interface SyncRpc {
  list(input: { sessionID?: string; all?: boolean }, options: { location: { directory: string } }): Promise<unknown>
  events?: { on(name: "delta" | "finished", handler: (e: RpcEvent) => void): () => void }
}

/** "loading" until a list answers (also while retrying); "unavailable" / "error" once the retries ran out. */
export type SyncState = "loading" | "ready" | "unavailable" | "error"

/** Why a `list` call threw: the RPC is not (yet) registered in that Location, or anything else. */
export type ListErrorKind = "unavailable" | "error"

export function listErrorKind(e: unknown): ListErrorKind {
  if (e && typeof e === "object") {
    const o = e as { type?: unknown; message?: unknown }
    if (o.type === "rpc.unavailable") return "unavailable"
    if (typeof o.message === "string" && /rpc\.unavailable|RPC is unavailable/i.test(o.message)) return "unavailable"
  }
  return "error"
}

/** Delays between list retries, in ms; after the last one the driver gives up. */
export const RETRY_DELAYS_MS: readonly number[] = [250, 500, 1000, 2000, 4000]

/** The delay before retry number `attempt` (0-based), or null when there are no retries left. */
export function retryDelay(attempt: number): number | null {
  return RETRY_DELAYS_MS[Math.max(0, Math.floor(attempt))] ?? null
}

export interface SyncOptions {
  rpc: SyncRpc
  /** What the tree shows: the target Location and session (null = every run there). Read on every sync. */
  target: () => Filter
  /** The store to keep in step (a new one by default). */
  tree?: TreeStore
  /** Something the view shows changed (tree, available, status, state). */
  onChange?: () => void
  /** A run of the viewed session finished, the first time (notify the user). */
  onFinished?: (e: FinishedEvent) => void
  /** Timer used for retries (setTimeout by default); returns a cancel function. */
  schedule?: (fn: () => void, ms: number) => () => void
}

function defaultSchedule(fn: () => void, ms: number): () => void {
  const t = setTimeout(fn, ms)
  ;(t as { unref?: () => void }).unref?.()
  return () => clearTimeout(t)
}

function errText(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message)
  return String(e)
}

export function clip(s: string, n = 400): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

function eventDirectory(e: RpcEvent): string | undefined {
  const data = e?.data as { directory?: unknown; runs?: { directory?: unknown }[] } | undefined
  const dir = e?.location?.directory ?? data?.directory ?? data?.runs?.[0]?.directory
  return typeof dir === "string" ? dir : undefined
}

export class TreeSync {
  readonly tree: TreeStore
  /** The last `list` succeeded or events arrive: the RPC is there. */
  available = false
  /** One line for the view ("" when there is nothing to say). */
  status = ""
  state: SyncState = "loading"
  /** Failed list calls since the last success (or reset). */
  attempt = 0
  private syncing: Promise<void> | undefined
  private again = false
  private lastKey: string | undefined
  private cancelRetry: (() => void) | undefined
  private readonly cleanups: (() => void)[] = []
  private disposed = false

  constructor(private readonly opts: SyncOptions) {
    this.tree = opts.tree ?? new TreeStore()
  }

  /** Subscribes to the RPC events and runs the first sync. */
  start(): void {
    const events = this.opts.rpc.events
    if (events?.on) {
      this.cleanups.push(events.on("delta", (e) => this.delta(e)))
      this.cleanups.push(events.on("finished", (e) => this.finished(e)))
    }
    this.checkTarget()
  }

  /** Starts over when the target (Location, session) changed since the last check; true if it did. */
  checkTarget(): boolean {
    const f = this.opts.target()
    const key = `${f.directory}|${f.sessionID}`
    if (key === this.lastKey) return false
    this.lastKey = key
    void this.refresh()
    return true
  }

  /** Starts over: resets the retry attempts and resyncs (target change, plugin reloaded). */
  refresh(): Promise<void> {
    this.attempt = 0
    return this.resync()
  }

  /** Lists the target's runs again (coalesced: one call in flight, at most one more queued). */
  resync(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.syncing) {
      this.again = true
      return this.syncing
    }
    this.clearRetry()
    this.syncing = (async () => {
      let failure: { error: unknown } | null = null
      do {
        this.again = false
        failure = null
        const f = this.opts.target()
        this.tree.beginSync()
        try {
          const res = (await this.opts.rpc.list(f.sessionID ? { sessionID: f.sessionID } : { all: true }, {
            location: { directory: f.directory },
          })) as ({ ok?: boolean; message?: string } & ListResult) | undefined
          // Disposed while the call was in flight: the view is gone, leave the tree as it was.
          if (this.disposed) {
            this.tree.endSync()
            break
          }
          if (res?.ok) {
            this.tree.replace(res)
            this.available = true
            this.status = ""
            this.attempt = 0
          } else {
            // The RPC answered with a refusal: show it, do not retry.
            this.tree.endSync()
            if (res?.message) this.status = clip(res.message, 120)
          }
          this.state = "ready"
          this.changed()
        } catch (e) {
          this.tree.endSync()
          if (this.disposed) break
          failure = { error: e }
        }
      } while (this.again && !this.disposed)
      this.syncing = undefined
      if (failure && !this.disposed) this.failed(failure.error)
    })()
    return this.syncing
  }

  /** A list call threw: retry after a delay, or give up and say so. */
  private failed(e: unknown): void {
    const kind = listErrorKind(e)
    const text = clip(errText(e), 80)
    const delay = retryDelay(this.attempt)
    this.available = false
    if (delay !== null) {
      this.attempt++
      this.state = "loading"
      // Unavailable while the plugins load is expected at startup: stay quiet in the tree.
      this.status = kind === "unavailable" ? "loading…" : `workflows: ${text} (retrying)`
      const schedule = this.opts.schedule ?? defaultSchedule
      this.cancelRetry = schedule(() => {
        this.cancelRetry = undefined
        void this.resync()
      }, delay)
    } else {
      this.state = kind
      this.status =
        kind === "unavailable" ? `workflows RPC unavailable (${text}); use /workflows` : `workflows list failed (${text}); use /workflows`
    }
    this.changed()
  }

  private clearRetry(): void {
    this.cancelRetry?.()
    this.cancelRetry = undefined
  }

  /** True when an RPC event comes from the target Location. */
  private sameLocation(e: RpcEvent): boolean {
    const dir = eventDirectory(e)
    return dir !== undefined && acceptRun({ directory: dir, parentSessionID: null }, { directory: this.opts.target().directory, sessionID: null })
  }

  /** A `delta` event. */
  delta(e: RpcEvent): void {
    if (this.disposed || !this.sameLocation(e)) return
    const d = (e.data ?? {}) as Partial<ListResult>
    const epoch = typeof d.epoch === "string" ? d.epoch : null
    const { gap } = this.tree.apply({ seq: Number(d.seq) || 0, epoch, runs: d.runs ?? [], agents: d.agents ?? [] })
    this.available = true
    this.changed()
    // Not ready (retrying, or given up) while the target's plugin sends deltas: it has loaded.
    if (gap || (this.state !== "ready" && !this.syncing)) void this.resync()
  }

  /** A `finished` event: applied, and notified once per run of the viewed session. */
  finished(e: RpcEvent): void {
    if (this.disposed || !this.sameLocation(e)) return
    const d = (e.data ?? {}) as FinishedEvent
    // Once per run the tree was showing: not for a duplicate, nor for a run it never knew.
    const fresh = this.tree.finished(d)
    this.changed()
    if (!fresh) return
    const f = this.opts.target()
    if (f.sessionID && d.parentSessionID !== f.sessionID) return
    this.opts.onFinished?.(d)
  }

  /** Stops for good: unsubscribes, clears a pending retry, and drops the answer of a list in flight. */
  dispose(): void {
    this.disposed = true
    this.clearRetry()
    for (const c of this.cleanups.splice(0).reverse()) {
      try {
        c()
      } catch {}
    }
  }

  private changed(): void {
    this.opts.onChange?.()
  }
}
