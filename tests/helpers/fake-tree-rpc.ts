// A fake `dynamic-workflows` RPC client and fake timers for the client resync driver
// (src/client/sync.ts): every `list` call stays pending until the test resolves or rejects it.

import type { AgentView, RunView } from "../../src/plugin/live.ts"
import { TreeSync, type SyncRpc } from "../../src/client/sync.ts"
import type { Filter } from "../../src/client/tree.ts"

export const DIR = "/work/proj"
export const S = "ses_parent"

export function run(over: Partial<RunView> = {}): RunView {
  return {
    runId: "wf_ab12",
    workflowName: "deep-research",
    description: "d",
    status: "running",
    parentSessionID: S,
    directory: DIR,
    startedAt: 0,
    endedAt: null,
    agents: { total: 2, done: 0, running: 2, queued: 0 },
    tokens: 0,
    cost: 0,
    phases: [],
    ungrouped: null,
    steeredAgents: 0,
    warnings: 0,
    error: null,
    ...over,
  }
}

export function agent(index: number, over: Partial<AgentView> = {}): AgentView {
  return {
    runId: "wf_ab12",
    index,
    label: `agent ${index}`,
    phase: null,
    status: "running",
    sessionID: `ses_c${index}`,
    model: null,
    tokens: 0,
    cost: 0,
    startedAt: 0,
    endedAt: null,
    activity: null,
    messages: { sent: 0, delivered: 0, held: 0 },
    worktree: null,
    error: null,
    ...over,
  }
}

export interface PendingCall {
  input: any
  options: any
  resolve: (v: unknown) => void
  reject: (e: unknown) => void
}

export function fakeRpc() {
  const calls: PendingCall[] = []
  const handlers = new Map<string, (e: any) => void>()
  const rpc: SyncRpc = {
    list: (input: any, options: any) => new Promise((resolve, reject) => calls.push({ input, options, resolve, reject })),
    events: {
      on: (name: string, h: (e: any) => void) => {
        handlers.set(name, h)
        return () => void handlers.delete(name)
      },
    },
  }
  const emit = (name: string, data: unknown, directory = DIR) => handlers.get(name)?.({ location: { directory }, data })
  return { rpc, calls, emit, handlers }
}

export function fakeTimers() {
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = []
  const schedule = (fn: () => void, ms: number) => {
    const t = { fn, ms, cancelled: false }
    timers.push(t)
    return () => void (t.cancelled = true)
  }
  const pending = () => timers.filter((t) => !t.cancelled)
  /** Runs the next pending timer and returns its delay. */
  const fire = () => {
    const t = pending()[0]
    if (!t) throw new Error("no timer pending")
    t.cancelled = true
    t.fn()
    return t.ms
  }
  return { schedule, pending, fire }
}

export const tick = () => new Promise((r) => setTimeout(r, 0))

/** A TreeSync over the fake RPC and timers; `target` is mutable. */
export function driver(target: Filter = { directory: DIR, sessionID: S }) {
  const f = fakeRpc()
  const timers = fakeTimers()
  const finished: unknown[] = []
  let changes = 0
  const t = { ...target }
  const sync = new TreeSync({
    rpc: f.rpc,
    target: () => t,
    onChange: () => void changes++,
    onFinished: (e) => void finished.push(e),
    schedule: timers.schedule,
  })
  return { ...f, sync, timers, finished, target: t, changes: () => changes }
}
