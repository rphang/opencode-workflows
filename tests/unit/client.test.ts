// The host-agnostic client logic (src/client/): the tree store and the resync driver that the TUI
// (and a later GUI companion) share. No renderer, no Solid: src/client must load in a browser.

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { AgentView, RunView } from "../../src/plugin/live.ts"
import * as tree from "../../src/client/tree.ts"
import { TreeSync, type SyncRpc } from "../../src/client/sync.ts"
import * as store from "../../src/tui/store.ts"

const { acceptRun, finishMessage, TreeStore } = tree
const ROOT = join(import.meta.dir, "..", "..")
const DIR = "/work/proj"
const S = "ses_parent"

function run(over: Partial<RunView> = {}): RunView {
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

function agent(index: number, over: Partial<AgentView> = {}): AgentView {
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

describe("src/client/tree.ts", () => {
  test("the TUI store re-exports the shared client logic (same functions, so existing imports keep working)", () => {
    for (const name of ["TreeStore", "acceptRun", "rowsFor", "actionFor", "targetFor", "footerParts", "homeFooterText", "isActive", "isOpen", "runKey", "phaseKey", "agentKey"] as const) {
      expect((store as Record<string, unknown>)[name]).toBe((tree as Record<string, unknown>)[name])
    }
  })

  test("path case-insensitivity comes from the path itself (no process.platform: it must run in a browser)", () => {
    const f = { directory: "C:\\Work\\Proj\\", sessionID: null }
    expect(acceptRun(run({ directory: "c:/work/proj" }), f)).toBe(true)
    expect(acceptRun(run({ directory: "/Work/Proj" }), { directory: "/work/proj", sessionID: null })).toBe(false)
    expect(acceptRun(run({ directory: "/work/proj/" }), { directory: "/work/proj", sessionID: null })).toBe(true)
    // An explicit flag still wins.
    expect(acceptRun(run({ directory: "/Work/Proj" }), { directory: "/work/proj", sessionID: null }, true)).toBe(true)
  })

  test("finishMessage is the text of the finish notification (title, message, variant)", () => {
    const e = { workflowName: "deep-research", status: "completed", agents: 12, tokens: 81_234, cost: 0.42, durationMs: 312_000 } as const
    expect(finishMessage(e)).toEqual({ title: "Workflow deep-research completed", message: "12 agents · 81.2k tokens · $0.42 · 5m12s", variant: "success" })
    expect(finishMessage({ ...e, status: "failed" }).variant).toBe("warning")
  })

  test("src/client imports no UI host module, no node builtin and no process global", () => {
    const dir = join(ROOT, "src", "client")
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"))
    expect(files.sort()).toEqual(["sync.ts", "tree.ts"])
    for (const f of files) {
      const src = readFileSync(join(dir, f), "utf8")
      const specs = [...src.matchAll(/^\s*(?:import|export)\b[^"']*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]!)
      for (const s of specs) expect(s).toMatch(/^\.\.?\//)
      expect(src).not.toMatch(/solid-js|@opentui|@opencode\/|node:|\.\.\/tui\//)
      expect(src).not.toMatch(/\bprocess\./)
    }
  })
})

// ---- the resync driver -----------------------------------------------------------------------------

function fakeRpc() {
  const calls: { input: any; options: any; resolve: (v: unknown) => void; reject: (e: unknown) => void }[] = []
  const handlers = new Map<string, (e: any) => void>()
  const rpc: SyncRpc = {
    list: (input, options) => new Promise((resolve, reject) => calls.push({ input, options, resolve, reject })),
    events: {
      on: (name, h) => {
        handlers.set(name, h)
        return () => void handlers.delete(name)
      },
    },
  }
  const emit = (name: string, data: unknown, directory = DIR) => handlers.get(name)?.({ location: { directory }, data })
  return { rpc, calls, emit, handlers }
}

function fakeTimers() {
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = []
  const schedule = (fn: () => void, ms: number) => {
    const t = { fn, ms, cancelled: false }
    timers.push(t)
    return () => void (t.cancelled = true)
  }
  const pending = () => timers.filter((t) => !t.cancelled)
  const fire = () => {
    const t = pending()[0]
    if (!t) throw new Error("no timer")
    t.cancelled = true
    t.fn()
    return t.ms
  }
  return { schedule, pending, fire }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

function driver(target = { directory: DIR, sessionID: S as string | null }) {
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

describe("src/client/sync.ts", () => {
  test("one list at a time: deltas that arrive while it is in flight are replayed over its result", async () => {
    const d = driver()
    d.sync.start()
    expect(d.calls).toHaveLength(1)
    expect(d.calls[0]!.input).toEqual({ sessionID: S })
    expect(d.calls[0]!.options).toEqual({ location: { directory: DIR } })
    // A second resync while the first is in flight does not start another call yet.
    void d.sync.resync()
    expect(d.calls).toHaveLength(1)
    d.emit("delta", { seq: 4, epoch: "e", runs: [run({ status: "completed", endedAt: 5 })], agents: [] })
    d.calls[0]!.resolve({ ok: true, seq: 3, epoch: "e", runs: [run()], agents: [] })
    await tick()
    expect(d.sync.tree.runs.get("wf_ab12")?.status).toBe("completed")
    expect(d.sync.available).toBe(true)
    expect(d.sync.state).toBe("ready")
    // The resync asked for meanwhile runs once more afterwards.
    expect(d.calls).toHaveLength(2)
    d.calls[1]!.resolve({ ok: true, seq: 4, epoch: "e", runs: [run({ status: "completed", endedAt: 5 })], agents: [] })
    await tick()
    expect(d.calls).toHaveLength(2)
    expect(d.changes()).toBeGreaterThan(0)
  })

  test("events of another Location are dropped; `all` scope lists every run of the Location", async () => {
    const d = driver({ directory: DIR, sessionID: null })
    d.sync.start()
    expect(d.calls[0]!.input).toEqual({ all: true })
    d.calls[0]!.resolve({ ok: true, seq: 1, epoch: "e", runs: [], agents: [] })
    await tick()
    d.emit("delta", { seq: 2, epoch: "e", runs: [run({ runId: "wf_other" })], agents: [] }, "/elsewhere")
    expect(d.sync.tree.runs.has("wf_other")).toBe(false)
    d.emit("delta", { seq: 2, epoch: "e", runs: [run({ runId: "wf_here" })], agents: [agent(0, { runId: "wf_here" })] })
    expect(d.sync.tree.runs.has("wf_here")).toBe(true)
  })

  test("a seq gap or a new epoch asks for a resync", async () => {
    const d = driver()
    d.sync.start()
    d.calls[0]!.resolve({ ok: true, seq: 1, epoch: "e", runs: [run()], agents: [] })
    await tick()
    d.emit("delta", { seq: 2, epoch: "e", runs: [], agents: [] })
    expect(d.calls).toHaveLength(1)
    d.emit("delta", { seq: 5, epoch: "e", runs: [], agents: [] })
    expect(d.calls).toHaveLength(2)
    d.calls[1]!.resolve({ ok: true, seq: 5, epoch: "e", runs: [run()], agents: [] })
    await tick()
    d.emit("delta", { seq: 1, epoch: "restarted", runs: [run({ runId: "wf_new" })], agents: [] })
    expect(d.sync.tree.runs.has("wf_new")).toBe(true)
    expect(d.calls).toHaveLength(3)
  })

  test("finished: notifies once per run the tree shows, for the viewed session only", async () => {
    const d = driver()
    d.sync.start()
    d.calls[0]!.resolve({ ok: true, seq: 1, epoch: "e", runs: [run(), run({ runId: "wf_x", parentSessionID: "ses_other" })], agents: [] })
    await tick()
    const fin = { runId: "wf_ab12", parentSessionID: S, workflowName: "deep-research", status: "completed", agents: 2, tokens: 0, cost: 0, durationMs: 1 }
    d.emit("finished", fin)
    d.emit("finished", fin)
    d.emit("finished", { ...fin, runId: "wf_x", parentSessionID: "ses_other" })
    expect(d.finished).toEqual([fin])
    expect(d.sync.tree.runs.get("wf_ab12")?.status).toBe("completed")
  })

  test("a target change resyncs against the new target; the same target does not", async () => {
    const d = driver()
    d.sync.start()
    expect(d.sync.checkTarget()).toBe(false)
    d.calls[0]!.resolve({ ok: true, seq: 1, epoch: "e", runs: [], agents: [] })
    await tick()
    d.target.sessionID = "ses_two"
    expect(d.sync.checkTarget()).toBe(true)
    expect(d.calls[1]!.input).toEqual({ sessionID: "ses_two" })
  })

  test("a list that throws (rpc.unavailable) marks the RPC unavailable and points to /workflows", async () => {
    const d = driver()
    d.sync.start()
    d.calls[0]!.reject({ type: "rpc.unavailable", message: "RPC is unavailable: dynamic-workflows" })
    await tick()
    expect(d.sync.available).toBe(false)
    expect(d.sync.state).toBe("unavailable")
    expect(d.sync.status).toBe("workflows RPC unavailable (RPC is unavailable: dynamic-workflows); use /workflows")
  })

  test("a list answered {ok:false} shows its message; dispose unsubscribes and cancels timers", async () => {
    const d = driver()
    d.sync.start()
    d.calls[0]!.resolve({ ok: false, message: "plugin is disabled" })
    await tick()
    expect(d.sync.status).toBe("plugin is disabled")
    d.sync.dispose()
    expect(d.handlers.size).toBe(0)
  })
})
