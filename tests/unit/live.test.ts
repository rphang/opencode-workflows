// Live views for the progress tree (src/plugin/live.ts): RunView/AgentView builders, strict JSON, and
// the LiveBus coalescer that turns engine/activity changes into ≤4 Hz `delta` RPC events (X11–X13).

import { describe, expect, test } from "bun:test"
import type { AgentActivity } from "../../src/plugin/activity.ts"
import { buildAgentView, buildRunView, finishedEvent, LiveBus, toJson, type RunView } from "../../src/plugin/live.ts"
import { ZERO_USAGE, type AgentRecord, type RunSummary } from "../../src/types.ts"

const DIR = "<project>"

function summary(over: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: "wf_1",
    taskId: "task_1",
    workflowName: "deep-research",
    description: "research",
    parentSessionID: "ses_parent",
    status: "running",
    startedAt: 1000,
    agentCount: 3,
    usage: { ...ZERO_USAGE, input: 900, output: 100, cost: 0.2 },
    phases: [
      { title: "Research", model: "openai/gpt-5.4", agents: 2, done: 1, running: 1, tokens: 1000, elapsedMs: 500 },
      { title: "Judge", agents: 0, done: 0, running: 0, tokens: 0 },
    ],
    ungrouped: { title: "(no phase)", agents: 1, done: 0, running: 0, tokens: 0 },
    logs: [],
    warnings: ["w1"],
    scriptPath: "<data-dir>/script.js",
    transcriptDir: "<data-dir>",
    ...over,
  }
}

function rec(index: number, over: Partial<AgentRecord> = {}): AgentRecord {
  return { index, key: `k${index}`, label: `agent ${index}`, prompt: "p", opts: {}, status: "queued", usage: { ...ZERO_USAGE }, ...over }
}

function act(over: Partial<AgentActivity> = {}): AgentActivity {
  return { model: "openai/gpt-5.4-mini", kind: "tool", text: "webfetch https://x", at: 1500, tokens: 700, cost: 0.05, delivered: 0, tools: {}, buffer: "", ...over }
}

describe("X12 views", () => {
  test("X12 toJson drops undefined, turns non-finite numbers into null and keeps plain data", () => {
    expect(toJson({ a: 1, b: undefined, c: [1, undefined, NaN], d: { e: Infinity, f: "x", g: null }, h: () => 1 })).toEqual({
      a: 1,
      c: [1, null, null],
      d: { e: null, f: "x", g: null },
    })
  })

  test("X11 X12 an agent view overlays the live activity, tokens and cost of a running agent", () => {
    const running = rec(0, {
      status: "running",
      phase: "Research",
      sessionID: "ses_c0",
      startedAt: 1100,
      messages: [
        { id: "wm_0_1", from: "user", via: "rpc", urgent: false, at: 1, text: "a", status: "delivered" },
        { id: "wm_0_2", from: "user", via: "rpc", urgent: false, at: 2, text: "b", status: "sent" },
      ],
    })
    const v = buildAgentView("wf_1", running, act())
    expect(v).toMatchObject({
      runId: "wf_1",
      index: 0,
      label: "agent 0",
      phase: "Research",
      status: "running",
      sessionID: "ses_c0",
      model: "openai/gpt-5.4-mini",
      tokens: 700,
      cost: 0.05,
      startedAt: 1100,
      endedAt: null,
      activity: { kind: "tool", text: "webfetch https://x", at: 1500 },
      messages: { sent: 1, delivered: 1, held: 0 },
      worktree: null,
      error: null,
    })
    // A settled agent shows its recorded usage and no activity.
    const done = buildAgentView("wf_1", rec(1, { status: "completed", usage: { ...ZERO_USAGE, output: 42, cost: 0.01 }, opts: { model: "x/y" } }))
    expect(done).toMatchObject({ status: "completed", tokens: 42, cost: 0.01, activity: null, model: "x/y" })
  })

  test("X10 X12 a run view carries the phase model label, counts, the live overlay and the filter keys", () => {
    const agents = [
      rec(0, { status: "completed", phase: "Research", usage: { ...ZERO_USAGE, input: 900, output: 100, cost: 0.2 } }),
      rec(1, { status: "running", phase: "Research", sessionID: "ses_c1", startedAt: 1200 }),
      rec(2, { status: "queued" }),
    ]
    const v = buildRunView(summary(), agents, new Map([[1, act({ tokens: 300, cost: 0.1 })]]), DIR)
    expect(v).toMatchObject({
      runId: "wf_1",
      workflowName: "deep-research",
      status: "running",
      parentSessionID: "ses_parent",
      directory: DIR,
      agents: { total: 3, done: 1, running: 1, queued: 1 },
      tokens: 1300,
      steeredAgents: 0,
      warnings: 1,
      endedAt: null,
    })
    expect(v.cost).toBeCloseTo(0.3)
    expect(v.phases[0]).toMatchObject({ title: "Research", model: "openai/gpt-5.4", agents: 2, done: 1, running: 1, tokens: 1300, elapsedMs: 500 })
    // No declared label: the models seen on its agents (none here).
    expect(v.phases[1]).toMatchObject({ title: "Judge", model: null, elapsedMs: null })
    expect(v.ungrouped).toMatchObject({ title: "(no phase)", agents: 1 })
    expect(JSON.parse(JSON.stringify(v))).toEqual(v as any)
  })

  test("X10 without a declared label, a phase shows the distinct models its agents run on (at most 2, then +n)", () => {
    const s = summary({ phases: [{ title: "Fan", agents: 4, done: 0, running: 4, tokens: 0 }], ungrouped: undefined, agentCount: 4 })
    const agents = [0, 1, 2, 3].map((i) => rec(i, { status: "running", phase: "Fan" }))
    const activity = new Map<number, AgentActivity>([
      [0, act({ model: "a/one" })],
      [1, act({ model: "b/two" })],
      [2, act({ model: "a/one" })],
      [3, act({ model: "c/three" })],
    ])
    expect(buildRunView(s, agents, activity, DIR).phases[0]!.model).toBe("a/one, b/two +1")
  })

  test("X13 finishedEvent summarizes a finished run with its filter keys", () => {
    const e = finishedEvent(summary({ status: "completed", endedAt: 4000 }), DIR)
    expect(e).toEqual({
      runId: "wf_1",
      parentSessionID: "ses_parent",
      directory: DIR,
      workflowName: "deep-research",
      status: "completed",
      agents: 3,
      tokens: 1000,
      cost: 0.2,
      durationMs: 3000,
    })
  })
})

/** Manual clock + timers for the bus. */
function clock() {
  let now = 0
  let next = 1
  const timers = new Map<number, { at: number; fn: () => void }>()
  return {
    now: () => now,
    set: (fn: () => void, ms: number) => {
      const id = next++
      timers.set(id, { at: now + ms, fn })
      return id
    },
    clear: (id: unknown) => void timers.delete(id as number),
    pending: () => timers.size,
    advance(ms: number) {
      now += ms
      for (const [id, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at <= now) {
          timers.delete(id)
          t.fn()
        }
      }
    },
  }
}

function bus() {
  const c = clock()
  const emitted: { name: string; data: any }[] = []
  const run = (runId: string) => ({ runId, directory: DIR, parentSessionID: "ses_parent" }) as unknown as RunView
  const b = new LiveBus({
    emit: (name, data) => void emitted.push({ name, data }),
    views: { run, agent: (runId, index) => ({ runId, index }) as any },
    now: c.now,
    timers: { set: c.set, clear: c.clear },
  })
  return { b, c, emitted }
}

describe("X13 LiveBus", () => {
  test("X13 a burst of changes within 250 ms becomes one delta; seq increases", () => {
    const { b, c, emitted } = bus()
    for (let i = 0; i < 20; i++) b.markAgent("wf_1", i % 3)
    b.markRun("wf_1")
    c.advance(0)
    expect(emitted).toHaveLength(1)
    expect(emitted[0]!.name).toBe("delta")
    expect(emitted[0]!.data.seq).toBe(1)
    expect(emitted[0]!.data.runs.map((r: any) => r.runId)).toEqual(["wf_1"])
    expect(emitted[0]!.data.agents.map((a: any) => a.index).sort()).toEqual([0, 1, 2])
    // Changes right after a flush wait for the rest of the 250 ms window.
    b.markAgent("wf_1", 0)
    c.advance(100)
    expect(emitted).toHaveLength(1)
    b.markAgent("wf_1", 1)
    c.advance(150)
    expect(emitted).toHaveLength(2)
    expect(emitted[1]!.data.seq).toBe(2)
    // An agent change also refreshes its run (tokens, counts), so a client can filter by run.
    expect(emitted[1]!.data.runs.map((r: any) => r.runId)).toEqual(["wf_1"])
  })

  test("X13 at most 4 deltas per second under a steady stream of changes", () => {
    const { b, c, emitted } = bus()
    for (let t = 0; t < 1000; t += 10) {
      b.markAgent("wf_1", 0)
      c.advance(10)
    }
    expect(emitted.length).toBeLessThanOrEqual(5)
    expect(emitted.length).toBeGreaterThanOrEqual(4)
  })

  test("X13 no timer runs while nothing is dirty; finished is emitted at once", () => {
    const { b, c, emitted } = bus()
    expect(c.pending()).toBe(0)
    b.markRun("wf_1")
    expect(c.pending()).toBe(1)
    c.advance(0)
    expect(c.pending()).toBe(0)
    b.finished({ runId: "wf_1", status: "completed" } as any)
    expect(emitted.at(-1)).toEqual({ name: "finished", data: { runId: "wf_1", status: "completed" } })
    expect(c.pending()).toBe(0)
  })

  test("X13 dispose cancels a pending flush and later marks do nothing", () => {
    const { b, c, emitted } = bus()
    b.markRun("wf_1")
    b.dispose()
    c.advance(1000)
    b.markRun("wf_1")
    c.advance(1000)
    expect(emitted).toHaveLength(0)
    expect(c.pending()).toBe(0)
  })

  test("X13 a view that no longer exists is left out; an emit that throws does not break the bus", () => {
    const c = clock()
    const emitted: any[] = []
    let fail = true
    const b = new LiveBus({
      emit: (_n, data) => {
        if (fail) {
          fail = false
          throw new Error("rpc gone")
        }
        emitted.push(data)
      },
      views: { run: (id) => (id === "wf_gone" ? undefined : ({ runId: id } as any)), agent: () => undefined },
      now: c.now,
      timers: { set: c.set, clear: c.clear },
    })
    b.markRun("wf_1")
    c.advance(0) // this emit throws
    b.markRun("wf_gone")
    c.advance(300) // nothing left to send: no empty delta
    expect(emitted).toHaveLength(0)
    b.markRun("wf_gone")
    b.markRun("wf_1")
    b.markAgent("wf_gone", 3)
    c.advance(300)
    expect(emitted).toHaveLength(1)
    expect(emitted[0].runs.map((r: any) => r.runId)).toEqual(["wf_1"])
    expect(emitted[0].agents).toEqual([])
    expect(emitted[0].seq).toBe(2)
  })
})

describe("X13 epoch", () => {
  test("X13 X15 every delta carries the bus epoch; a new bus (plugin restart) has another epoch and starts over at seq 1", () => {
    const one = bus()
    const two = bus()
    expect(one.b.epoch).toMatch(/^[a-z0-9]{8,}$/)
    expect(two.b.epoch).not.toBe(one.b.epoch)
    one.b.markRun("wf_1")
    one.c.advance(0)
    two.b.markRun("wf_2")
    two.c.advance(0)
    expect(one.emitted[0]!.data).toMatchObject({ seq: 1, epoch: one.b.epoch })
    expect(two.emitted[0]!.data).toMatchObject({ seq: 1, epoch: two.b.epoch })
  })
})

describe("X11 X12 terminal-safe text", () => {
  test("X11 X12 views strip control characters and bidi overrides from every text field", () => {
    const esc = "\u001b[31m"
    const nasty = `a${esc}b\u0007c\u202ed\u2066e\u009bf`
    const view = buildAgentView(
      "wf_1",
      rec(0, { status: "running", label: `lbl${esc}x`, phase: `ph\u0007`, error: `boom${esc}\nsecond line` }),
      act({ kind: "text", text: nasty, model: `m${esc}` }),
    )
    expect(view.label).toBe("lbl[31mx")
    expect(view.phase).toBe("ph")
    expect(view.activity?.text).toBe("a[31mbcdef")
    expect(view.model).toBe("m[31m")
    // Errors keep their line breaks (the views show the first line) but lose the control bytes.
    expect(view.error).toBe("boom[31m\nsecond line")
    const run = buildRunView(
      summary({ workflowName: `wf${esc}`, description: `d\u0007`, error: `e${esc}`, phases: [{ title: `T\u202e`, model: `x${esc}`, agents: 0, done: 0, running: 0, tokens: 0 }] }),
      [],
      new Map(),
      DIR,
    )
    expect(run.workflowName).toBe("wf[31m")
    expect(run.description).toBe("d")
    expect(run.error).toBe("e[31m")
    expect(run.phases[0]).toMatchObject({ title: "T", model: "x[31m" })
    expect(finishedEvent(summary({ workflowName: `n${esc}` }), DIR).workflowName).toBe("n[31m")
    for (const s of [JSON.stringify(view), JSON.stringify(run)]) expect(s).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/)
  })
})
