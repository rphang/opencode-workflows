// The server side of the live progress tree (X11–X13): ties the engine events of this plugin
// instance, the activity tap (opencode's event stream) and the LiveBus to the `dynamic-workflows`
// RPC registration.
//
//   engine onEvent ─┐                      ┌─► delta (≤4 Hz) ─┐
//                   ├─► LiveBus (dirty) ───┤                  ├─► reg.events.emit → /api/event
//   ActivityTap ────┘                      └─► finished ──────┘
//   RPC list/status/control ──► WorkflowHost (snapshots, userControl)
//
// Everything degrades: without ctx.event the views carry the engine status only; without ctx.rpc
// (older opencode) nothing is registered and the text views (/workflows) keep working.

import type { WorkflowEvent } from "../engine.ts"
import type { Json } from "../types.ts"
import { ActivityTap } from "./activity.ts"
import type { LiveActivity } from "./format.ts"
import type { RunSnapshot, UserControlInput, WorkflowHost } from "./host.ts"
import { buildAgentView, buildRunView, finishedEvent, LiveBus, toJson, type AgentView, type RunView } from "./live.ts"
import { definition } from "./rpc-def.ts"

export interface LiveRuntimeOptions {
  /** This plugin instance's Location directory (every view carries it). */
  directory: string
  /** ctx.event.subscribe, when available. */
  subscribe?: (signal: AbortSignal) => AsyncIterable<any>
  /** LiveBus interval (tests). */
  intervalMs?: number
  /**
   * False makes the RPC read-only (X17): `control` is refused, `list`/`status` and the events keep
   * working. Set by OPENCODE_WORKFLOW_RPC_CONTROL=0 or the `rpcControl: false` plugin option.
   */
  control?: boolean
}

interface Registration {
  events: { emit: (name: any, data: any) => Promise<void> }
  dispose?: () => Promise<void>
}

/** Why `control` is refused when the RPC is read-only (X17). */
export const RPC_READ_ONLY =
  "the workflows RPC is read-only here (OPENCODE_WORKFLOW_RPC_CONTROL=0 or rpcControl:false): stop, pause and message runs with /workflows or workflow_control in their session"

export class LiveRuntime {
  readonly tap: ActivityTap
  readonly bus: LiveBus
  private host: WorkflowHost | undefined
  private reg: Registration | undefined

  constructor(private readonly opts: LiveRuntimeOptions) {
    this.tap = new ActivityTap({
      subscribe: opts.subscribe,
      onChange: (runId, index) => this.bus.markAgent(runId, index),
    })
    this.bus = new LiveBus({
      emit: (name, data) => this.reg?.events.emit(name, data),
      views: { run: (id) => this.runView(id), agent: (id, i) => this.agentView(id, i) },
      intervalMs: opts.intervalMs,
    })
  }

  attach(host: WorkflowHost): void {
    this.host = host
  }

  /** Starts the activity tap (needs only ctx.event, so the text views get activity without the RPC). */
  start(): void {
    this.tap.start()
  }

  /** Registers the RPC; resolves false when this opencode has no ctx.rpc or registration fails. */
  async register(rpc: { register?: (def: any, handlers: any) => Promise<Registration> } | undefined): Promise<boolean> {
    if (!rpc || typeof rpc.register !== "function") return false
    try {
      this.reg = await rpc.register(definition, this.handlers())
      return true
    } catch {
      this.reg = undefined
      return false
    }
  }

  async dispose(): Promise<void> {
    this.bus.dispose()
    await this.tap.stop()
    const reg = this.reg
    this.reg = undefined
    try {
      await reg?.dispose?.()
    } catch {}
  }

  /** Engine event handler (HostOptions.onEvent). */
  readonly onEvent = (e: WorkflowEvent): void => {
    switch (e.type) {
      case "agent": {
        const r = e.record
        if (r.sessionID) {
          if (r.status === "running") this.tap.track(r.sessionID, e.runId, r.index)
          else if (r.status !== "queued") this.tap.untrack(r.sessionID)
        }
        this.bus.markAgent(e.runId, r.index)
        return
      }
      case "run_finished":
        this.tap.forgetRun(e.runId)
        this.bus.markRun(e.runId)
        // The final state first, then the (uncoalesced) finished event.
        this.bus.flush()
        this.bus.finished(finishedEvent(e.summary, this.opts.directory))
        return
      default:
        this.bus.markRun(e.runId)
    }
  }

  /** Live activity for the text views (HostOptions.activity). */
  readonly activityFor = (runId: string): Map<number, LiveActivity> => this.tap.forRun(runId)

  runView(runId: string, snap: RunSnapshot | undefined = this.host?.snapshot(runId)): RunView | undefined {
    if (!snap) return undefined
    return buildRunView(snap.summary, snap.agents, this.tap.forRun(runId), this.opts.directory)
  }

  agentView(runId: string, index: number): AgentView | undefined {
    const rec = this.host?.snapshot(runId)?.agents?.[index]
    return rec ? buildAgentView(runId, rec, this.tap.get(runId, index)) : undefined
  }

  private agentViews(snap: RunSnapshot): AgentView[] {
    const runId = snap.summary.runId
    return (snap.agents ?? []).filter(Boolean).map((r) => buildAgentView(runId, r, this.tap.get(runId, r.index)))
  }

  /** RPC handlers. Errors come back as {ok:false, message}; outputs are strict JSON. */
  handlers() {
    const fail = (e: unknown) => toJson({ ok: false, message: e instanceof Error ? e.message : String(e) }) as Record<string, Json>
    return {
      list: async (input: any) => {
        try {
          const host = this.requireHost()
          const snaps = await host.listSnapshots({
            sessionID: typeof input?.sessionID === "string" ? input.sessionID : undefined,
            all: input?.all === true,
            limit: typeof input?.limit === "number" ? input.limit : undefined,
          })
          return toJson({
            ok: true,
            directory: this.opts.directory,
            seq: this.bus.seq,
            epoch: this.bus.epoch,
            runs: snaps.map((s) => this.runView(s.summary.runId, s)!),
            agents: snaps.flatMap((s) => this.agentViews(s)),
          }) as Record<string, Json>
        } catch (e) {
          return fail(e)
        }
      },
      status: async (input: any) => {
        try {
          const runId = typeof input?.runId === "string" ? input.runId.trim() : ""
          if (!runId) return fail("runId is required")
          const snap = await this.requireHost().runSnapshot(runId)
          if (!snap) return fail(`unknown run: ${runId}`)
          return toJson({ ok: true, run: this.runView(runId, snap), agents: this.agentViews(snap) }) as Record<string, Json>
        } catch (e) {
          return fail(e)
        }
      },
      control: async (input: any) => {
        if (this.opts.control === false) return fail(RPC_READ_ONLY)
        try {
          const res = await this.requireHost().userControl((input ?? {}) as UserControlInput)
          if (res.ok && typeof input?.runId === "string") this.bus.markRun(input.runId)
          return toJson(res) as Record<string, Json>
        } catch (e) {
          return fail(e)
        }
      },
    }
  }

  private requireHost(): WorkflowHost {
    if (!this.host) throw new Error("the workflow plugin is not ready")
    return this.host
  }
}
