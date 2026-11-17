// Extensions beyond Claude Code (docs/PARITY.md "Extensions", X25–X27): the TUI's agent dialog, its
// sidebar summary and the cold-start resync, tested through the pure client logic (src/client/,
// src/tui/store.ts) without a renderer.

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { listErrorKind, retryDelay } from "../../src/client/sync.ts"
import { agentKey, PICKER_ACTIONS, pickerAction, pickerCurrent, pickerOptions, pickerSearch, runKey, sidebarSummary, TreeStore, viewedSession } from "../../src/tui/store.ts"
import { agent, DIR, driver, run, S, tick } from "../helpers/fake-tree-rpc.ts"

const root = join(import.meta.dir, "..", "..")
const UNAVAILABLE = { type: "rpc.unavailable", message: "RPC is unavailable: dynamic-workflows" }

function treeOf(runs = [run()], agents = [agent(0)]) {
  const s = new TreeStore()
  s.replace({ seq: 1, runs, agents })
  return s
}

describe("X25 agent dialog", () => {
  const runs = [
    run({ runId: "wf_old", workflowName: "review", startedAt: 1 }),
    run({ runId: "wf_new", workflowName: "deep-research", startedAt: 5 }),
    run({ runId: "wf_done", status: "completed", startedAt: 9 }),
    run({ runId: "wf_other", parentSessionID: "ses_other", startedAt: 7 }),
  ]
  const agents = [
    agent(3, { runId: "wf_new", label: "payments api", phase: "Research", model: "openai/gpt-5.4-mini" }),
    agent(1, { runId: "wf_new", label: "auth flows", phase: "Research", status: "queued", sessionID: null }),
    agent(2, { runId: "wf_new", label: "done one", status: "completed" }),
    agent(0, { runId: "wf_old", label: "lint", phase: null }),
    agent(0, { runId: "wf_done", label: "finished run agent", status: "running" }),
    agent(0, { runId: "wf_other", label: "someone else" }),
  ]
  const s = treeOf(runs, agents)
  const f = { directory: DIR, sessionID: S }

  test("X25 options: the running and queued agents of the visible active runs (newest run first), `#i label`, `status · phase`, by workflow", () => {
    const options = pickerOptions(s, f)
    expect(options.map((o) => o.value)).toEqual([
      { runId: "wf_new", index: 1 },
      { runId: "wf_new", index: 3 },
      { runId: "wf_old", index: 0 },
    ])
    expect(options[1]).toMatchObject({
      title: "#3 payments api",
      description: "running · Research",
      category: "deep-research",
    })
    expect(options[0]!.description).toBe("queued · Research")
    expect(options[2]!.description).toBe("running")
    // No model: opencode's dialog cuts the description at a fixed width without an ellipsis, so a
    // provider/model id came out as "open" (seen live on 2.3.0). The tree rows show the model.
    for (const o of options) expect(o.description).not.toContain("gpt-5.4-mini")
    // The whole Location (the `a` scope) adds the other session's run.
    expect(pickerOptions(s, { directory: DIR, sessionID: null }).map((o) => o.value.runId)).toContain("wf_other")
    expect(pickerOptions(treeOf([run({ status: "completed" })]), f)).toEqual([])
  })

  test("X25 the panel's selected agent is the dialog's current option; other rows select nothing", () => {
    const options = pickerOptions(s, f)
    expect(pickerCurrent(options, agentKey("wf_new", 3))).toEqual({ runId: "wf_new", index: 3 })
    expect(pickerCurrent(options, agentKey("wf_new", 2))).toBeUndefined()
    expect(pickerCurrent(options, runKey("wf_new"))).toBeUndefined()
    expect(pickerCurrent(options, null)).toBeUndefined()
  })

  test("X25 search: `#3` or `3` matches that index first, then label prefixes, then substrings of label, phase, workflow and run id", () => {
    const many = treeOf(
      [run({ runId: "wf_x3", workflowName: "audit" })],
      [
        agent(0, { runId: "wf_x3", label: "agent three", phase: "Scan" }),
        agent(3, { runId: "wf_x3", label: "payments", phase: "Scan" }),
        agent(5, { runId: "wf_x3", label: "3d renderer", phase: "Build" }),
        agent(13, { runId: "wf_x3", label: "routes", phase: "Build" }),
      ],
    )
    const options = pickerOptions(many, f)
    const idx = (q: string) => pickerSearch(q, options).map((o) => o.value.index)
    expect(idx("")).toEqual([0, 3, 5, 13])
    expect(idx("#3")).toEqual([3])
    // `3`: index 3, then the label starting with 3, then every option whose run id contains 3.
    expect(idx("3")).toEqual([3, 5, 0, 13])
    expect(idx("PAY")).toEqual([3])
    expect(idx("ag")).toEqual([0])
    expect(idx("build")).toEqual([5, 13])
    expect(idx("audit")).toEqual([0, 3, 5, 13])
    expect(idx("nothing")).toEqual([])
  })

  test("X25 Enter steers, ctrl+u steers urgently, ctrl+d stops after a confirm, ctrl+o opens; each re-reads the agent's current row", () => {
    const t = treeOf([run()], [agent(3, { label: "payments api" }), agent(4, { status: "queued", sessionID: null })])
    const v = { runId: "wf_ab12", index: 3 }
    expect(pickerAction(t, v, "steer")).toMatchObject({ type: "prompt", title: "Message #3 payments api", control: { action: "message", agentIndex: 3, urgent: false } })
    expect(pickerAction(t, v, "urgent")).toMatchObject({ type: "prompt", control: { agentIndex: 3, urgent: true } })
    expect(pickerAction(t, v, "stop")).toMatchObject({ type: "confirm", control: { action: "stop_agent", agentIndex: 3 } })
    expect(pickerAction(t, v, "open")).toEqual({ type: "open", sessionID: "ses_c3" })
    expect(pickerAction(t, { runId: "wf_ab12", index: 4 }, "open")).toEqual({ type: "toast", message: "#4 has no session yet (it is queued)", variant: "info" })
    // The agent finished while the dialog was open: the existing toast, no prompt.
    t.apply({ seq: 2, runs: [], agents: [agent(3, { label: "payments api", status: "completed" })] })
    expect(pickerAction(t, v, "steer")).toMatchObject({ type: "toast", message: "#3 is completed; only running or queued agents get messages" })
    expect(pickerAction(t, v, "stop")).toMatchObject({ type: "toast", message: "#3 is completed" })
    // Gone from the tree (another scope, resync): a toast.
    expect(pickerAction(t, { runId: "wf_gone", index: 0 }, "steer")).toMatchObject({ type: "toast", message: "#0 of wf_gone is no longer listed" })
  })

  test("X25 the footer actions are ctrl+u (urgent), ctrl+d (stop) and ctrl+o (open), never ctrl+n / ctrl+p (list navigation)", () => {
    expect(PICKER_ACTIONS.map((a) => [a.key, a.bind])).toEqual([
      ["urgent", "ctrl+u"],
      ["stop", "ctrl+d"],
      ["open", "ctrl+o"],
    ])
    for (const a of PICKER_ACTIONS) expect(a.bind).not.toMatch(/ctrl\+[np]\b/)
    const src = readFileSync(join(root, "src", "tui", "index.tsx"), "utf8")
    expect(src).toMatch(/search: pickerSearch/)
    expect(src).toMatch(/PICKER_ACTIONS\.map/)
  })
})

describe("X15 X25 TUI entry on opencode 2.3", () => {
  test("X15 X25 the global commands are a setup-time keymap layer (no `app` slot render), setup is typed against the TUI plugin definition, and the target is watched reactively", () => {
    const src = readFileSync(join(root, "src", "tui", "index.tsx"), "utf8")
    expect(src).not.toMatch(/append: "app"/)
    expect(src).toMatch(/import type \{ Plugin \} from "@opencode\/plugin\/tui"/)
    expect(src).toMatch(/satisfies Plugin\.Definition/)
    expect(src).not.toMatch(/setup\(ctx: any\)/)
    // The keymap layer is created in setup itself, before any slot.
    const layer = src.indexOf("ctx.keymap.layer(")
    expect(layer).toBeGreaterThan(0)
    expect(layer).toBeLessThan(src.indexOf("ctx.ui.slot("))
    // The 500 ms poll of the route is gone: a Solid effect on the (reactive) router and session data.
    expect(src).not.toMatch(/setInterval\(\(\) => sync\.checkTarget\(\), 500\)/)
    expect(src).toMatch(/createEffect\(/)
  })
})

describe("X26 sidebar summary", () => {
  const research = { title: "Research", model: null, agents: 8, done: 5, running: 3, tokens: 60_000, elapsedMs: 1000 }
  const judge = { title: "Judge", model: null, agents: 4, done: 0, running: 0, tokens: 0, elapsedMs: null }
  const runs = [
    run({ runId: "wf_a", startedAt: 10, agents: { total: 12, done: 7, running: 3, queued: 2 }, tokens: 81_234, cost: 0.42, phases: [research, judge] }),
    run({ runId: "wf_b", workflowName: "review", status: "completed", startedAt: 20, agents: { total: 4, done: 4, running: 0, queued: 0 }, tokens: 900, cost: 0.1 }),
    run({ runId: "wf_c", workflowName: "audit", status: "failed", startedAt: 5, agents: { total: 2, done: 2, running: 0, queued: 0 } }),
    run({ runId: "wf_d", workflowName: "old", status: "stopped", startedAt: 1 }),
    run({ runId: "wf_e", parentSessionID: "ses_other", startedAt: 30 }),
  ]

  test("X26 header hint and up to 3 runs of the session: active newest first, then the newest finished, then `+n more`", () => {
    const sum = sidebarSummary(runs, S)!
    expect(sum.hint).toBe("1 running · $0.52")
    expect(sum.total).toBe(4)
    expect(sum.more).toBe(1)
    expect(sum.collapsible).toBe(true)
    expect(sum.items).toEqual([
      { runId: "wf_a", name: "deep-research", progress: "7/12", detail: "Research · 3 running · 81.2k · $0.42", tone: "running" },
      { runId: "wf_b", name: "review", progress: "4/4", detail: "completed · 900 · $0.10", tone: "success" },
      { runId: "wf_c", name: "audit", progress: "2/2", detail: "failed · 0 · $0", tone: "error" },
    ])
  })

  test("X26 hidden without runs; no toggle up to 2 runs; paused and finished-only hints; long names are shortened", () => {
    expect(sidebarSummary(runs, "ses_none")).toBeNull()
    expect(sidebarSummary([], S)).toBeNull()
    expect(sidebarSummary([], null)).toBeNull()
    const two = sidebarSummary([runs[1]!, runs[2]!], S)!
    expect(two).toMatchObject({ hint: "2 runs · $0.10", collapsible: false, more: 0 })
    const paused = sidebarSummary([run({ status: "paused", cost: 0.004, phases: [{ ...research, running: 0 }, judge] })], S)!
    expect(paused.hint).toBe("1 paused · $0.0040")
    // No phase is running: the first unfinished one is shown.
    expect(paused.items[0]).toMatchObject({ tone: "paused", detail: "paused · Research · 2 running · 0 · $0.0040" })
    expect(sidebarSummary([runs[3]!], S)!.items[0]!.tone).toBe("muted")
    const long = sidebarSummary([run({ workflowName: "a-really-long-workflow-name-for-the-sidebar" })], S)!.items[0]!
    expect([...long.name].length).toBeLessThanOrEqual(24)
    expect(long.name.endsWith("…")).toBe(true)
  })

  test("X26 a workflow child session shows its parent's runs (the sidebar maps its sessionID like the footer)", () => {
    const sessions: Record<string, any> = {
      ses_child: { id: "ses_child", metadata: { workflowRunId: "wf_a", parentSessionID: S } },
      [S]: { id: S },
    }
    expect(viewedSession("ses_child", (id) => sessions[id])).toBe(S)
    expect(viewedSession(S, (id) => sessions[id])).toBe(S)
    expect(viewedSession(undefined, (id) => sessions[id])).toBeNull()
    const src = readFileSync(join(root, "src", "tui", "index.tsx"), "utf8")
    expect(src).toMatch(/append: "sidebar\.content"/)
    expect(readFileSync(join(root, "src", "tui", "sidebar.tsx"), "utf8")).toMatch(/sidebarSummary\(/)
  })
})

describe("X27 cold-start resync", () => {
  test("X27 retryDelay: 250, 500, 1000, 2000, 4000 ms, then null (give up)", () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(retryDelay)).toEqual([250, 500, 1000, 2000, 4000, null, null])
    expect(retryDelay(-1)).toBe(250)
  })

  test("X27 listErrorKind: rpc.unavailable (as thrown by the client, an RpcError or its message) vs any other error", () => {
    expect(listErrorKind(UNAVAILABLE)).toBe("unavailable")
    expect(listErrorKind({ _tag: "RpcError", type: "rpc.unavailable", message: "x" })).toBe("unavailable")
    expect(listErrorKind(new Error("RPC is unavailable: dynamic-workflows"))).toBe("unavailable")
    expect(listErrorKind({ type: "rpc.invalid_input", message: "Expected object" })).toBe("error")
    expect(listErrorKind(new TypeError("fetch failed"))).toBe("error")
    expect(listErrorKind(undefined)).toBe("error")
  })

  test("X27 a first list that fails with rpc.unavailable (plugins still loading) is retried quietly until it succeeds", async () => {
    const d = driver()
    d.sync.start()
    d.calls[0]!.reject(UNAVAILABLE)
    await tick()
    expect(d.sync.status).toBe("loading…")
    expect(d.sync.state).toBe("loading")
    expect(d.sync.available).toBe(false)
    expect(d.timers.fire()).toBe(250)
    expect(d.calls).toHaveLength(2)
    d.calls[1]!.reject(UNAVAILABLE)
    await tick()
    expect(d.sync.status).toBe("loading…")
    expect(d.timers.fire()).toBe(500)
    d.calls[2]!.resolve({ ok: true, seq: 1, epoch: "e", runs: [run()], agents: [] })
    await tick()
    expect(d.sync.state).toBe("ready")
    expect(d.sync.status).toBe("")
    expect(d.sync.available).toBe(true)
    expect(d.sync.tree.runs.has("wf_ab12")).toBe(true)
    expect(d.timers.pending()).toHaveLength(0)
    // Attempts were reset by the success: a later failure starts over at 250 ms.
    void d.sync.resync()
    d.calls[3]!.reject(UNAVAILABLE)
    await tick()
    expect(d.timers.fire()).toBe(250)
  })

  test("X27 after 5 retries it gives up and says so; a target change or a refresh (plugin.updated) starts over", async () => {
    const d = driver()
    d.sync.start()
    const delays: number[] = []
    for (let i = 0; i < 6; i++) {
      d.calls[i]!.reject(UNAVAILABLE)
      await tick()
      if (i < 5) delays.push(d.timers.fire())
    }
    expect(delays).toEqual([250, 500, 1000, 2000, 4000])
    expect(d.calls).toHaveLength(6)
    expect(d.timers.pending()).toHaveLength(0)
    expect(d.sync.state).toBe("unavailable")
    expect(d.sync.status).toBe("workflows RPC unavailable (RPC is unavailable: dynamic-workflows); use /workflows")
    // plugin.updated → refresh(): attempts reset.
    void d.sync.refresh()
    expect(d.calls).toHaveLength(7)
    d.calls[6]!.reject(UNAVAILABLE)
    await tick()
    expect(d.sync.status).toBe("loading…")
    expect(d.timers.fire()).toBe(250)
    d.calls[7]!.reject(UNAVAILABLE)
    await tick()
    // A target change cancels the pending retry and starts over against the new target.
    d.target.sessionID = "ses_two"
    expect(d.sync.checkTarget()).toBe(true)
    expect(d.timers.pending()).toHaveLength(0)
    expect(d.calls[8]!.input).toEqual({ sessionID: "ses_two" })
    d.calls[8]!.reject(UNAVAILABLE)
    await tick()
    expect(d.timers.fire()).toBe(250)
  })

  test("X27 another error is shown while retrying, and once the retries run out", async () => {
    const d = driver()
    d.sync.start()
    d.calls[0]!.reject(new TypeError("fetch failed"))
    await tick()
    expect(d.sync.state).toBe("loading")
    expect(d.sync.status).toBe("workflows: fetch failed (retrying)")
    for (let i = 1; i < 6; i++) {
      d.timers.fire()
      d.calls[i]!.reject(new TypeError("fetch failed"))
      await tick()
    }
    expect(d.sync.state).toBe("error")
    expect(d.sync.status).toBe("workflows list failed (fetch failed); use /workflows")
  })

  test("X27 a delta from the target Location while the list is not ready resyncs right away (the plugin has loaded)", async () => {
    const d = driver()
    d.sync.start()
    d.calls[0]!.reject(UNAVAILABLE)
    await tick()
    expect(d.timers.pending()).toHaveLength(1)
    d.emit("delta", { seq: 3, epoch: "e", runs: [run()], agents: [] })
    expect(d.calls).toHaveLength(2)
    expect(d.timers.pending()).toHaveLength(0)
    expect(d.sync.available).toBe(true)
    d.calls[1]!.resolve({ ok: true, seq: 3, epoch: "e", runs: [run()], agents: [] })
    await tick()
    expect(d.sync.state).toBe("ready")
    // Once ready, deltas in sequence do not list again.
    d.emit("delta", { seq: 4, epoch: "e", runs: [run({ tokens: 9 })], agents: [] })
    expect(d.calls).toHaveLength(2)
  })

  test("X27 the TUI refreshes (attempts reset) when the host reports plugin.updated", () => {
    const src = readFileSync(join(root, "src", "tui", "index.tsx"), "utf8")
    expect(src).toMatch(/\.on(\?\.)?\("plugin\.updated", \(\) => void sync\.refresh\(\)\)/)
  })
})
