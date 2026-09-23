// Extensions beyond Claude Code (docs/PARITY.md "Extensions", X14–X16): the TUI progress tree's
// pure logic (src/tui/store.ts), tested without a renderer: the package's TUI entry, the footer text,
// the tree rows, the key → action mapping, the Location/session filter and the finish notification.

import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { AgentView, RunView } from "../../src/plugin/live.ts"
import {
  acceptRun,
  actionFor,
  fitSegments,
  footerParts,
  footerText,
  helpText,
  homeFooterText,
  isOpen,
  notifyFinished,
  rowsFor,
  rowText,
  targetFor,
  TreeStore,
  type Row,
} from "../../src/tui/store.ts"

const root = join(import.meta.dir, "..", "..")
const DIR = "C:\\work\\proj"
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
    agents: { total: 12, done: 7, running: 3, queued: 2 },
    tokens: 81_234,
    cost: 0.4213,
    phases: [
      { title: "Research", model: "openai/gpt-5.4", agents: 3, done: 1, running: 1, tokens: 60_000, elapsedMs: 220_000 },
      { title: "Judge", model: "strong", agents: 0, done: 0, running: 0, tokens: 0, elapsedMs: null },
    ],
    ungrouped: { title: "(no phase)", model: null, agents: 1, done: 1, running: 0, tokens: 21_000, elapsedMs: 12_000 },
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
    phase: "Research",
    status: "running",
    sessionID: `ses_c${index}`,
    model: null,
    tokens: 7400,
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

function store(runs: RunView[] = [run()], agents: AgentView[] = []): TreeStore {
  const s = new TreeStore()
  s.replace({ seq: 1, runs, agents })
  return s
}

describe("X14 package entry and footer", () => {
  test("X14 the package exposes a TUI entry: exports['./tui'] → dist/tui.js (shipped in files) and a root tui.tsx for directory installs", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
    const tui = pkg.exports["./tui"]
    expect(tui).toBeDefined()
    expect(tui.import).toBe("./dist/tui.js")
    expect(pkg.files).toContain("dist")
    expect(existsSync(join(root, "tui.tsx"))).toBe(true)
    expect(readFileSync(join(root, "tui.tsx"), "utf8")).toMatch(/from "\.\/src\/tui\/index\.tsx"/)
    // No new runtime dependency: the TUI modules come from the host.
    for (const dep of ["solid-js", "@opentui/core", "@opentui/solid"]) expect(pkg.dependencies[dep]).toBeUndefined()
    // The server entry never imports the TUI (it must load without the TUI peers).
    expect(readFileSync(join(root, "src", "index.ts"), "utf8")).not.toMatch(/tui/)
  })

  test("X14 footer: `wf <name> <done>/<total> · <tokens> · $<cost>` for the newest active run of the session, +n for more", () => {
    const a = run({ runId: "wf_a", startedAt: 10 })
    const b = run({ runId: "wf_b", workflowName: "review", startedAt: 20, agents: { total: 4, done: 1, running: 3, queued: 0 }, tokens: 900, cost: 0 })
    const done = run({ runId: "wf_c", status: "completed", startedAt: 30 })
    const other = run({ runId: "wf_d", parentSessionID: "ses_other", startedAt: 40 })
    expect(footerText([a], S)).toBe("wf deep-research 7/12 · 81.2k · $0.42")
    expect(footerText([a, b, done, other], S)).toBe("wf review 1/4 · 900 · $0 +1")
    expect(footerText([done, other], S)).toBe("")
    expect(footerText([run({ status: "paused" })], S)).toBe("wf deep-research ‖ 7/12 · 81.2k · $0.42")
    expect(homeFooterText([a, b, done, other])).toBe("wf 3 running")
    expect(homeFooterText([done])).toBe("")
  })
})

describe("X15 tree, actions and filtering", () => {
  test("X15 rows: run → phases (model label, counts) → agents (status, tokens, activity, messages); older finished runs start collapsed", () => {
    const s = store(
      [run(), run({ runId: "wf_old", status: "completed", startedAt: -5, endedAt: 100 })],
      [
        agent(0, { status: "completed", tokens: 9100, startedAt: 0, endedAt: 41_000 }),
        agent(3, { activity: { kind: "tool", text: "webfetch https://docs.example.com", at: 0 }, messages: { sent: 0, delivered: 1, held: 0 } }),
        agent(6, { status: "queued", startedAt: null, tokens: 0, messages: { sent: 0, delivered: 0, held: 1 } }),
        agent(9, { phase: null, status: "completed", tokens: 21_000 }),
      ],
    )
    const rows = rowsFor(s, new Map(), { directory: DIR, sessionID: S })
    const texts = rows.map((r) => rowText(r, 62_000))
    expect(rows.map((r) => r.kind)).toEqual(["run", "phase", "agent", "agent", "agent", "phase", "phase", "agent", "run"])
    expect(texts[0]).toMatch(/^deep-research\s+● running\s+7\/12 · 81\.2k · \$0\.42 · 1m02s\s+wf_ab12$/)
    expect(texts[1]).toMatch(/^├ Research \(openai\/gpt-5\.4\)\s+1\/3 · 1 running · 60\.0k · 3m40s$/)
    expect(texts[2]).toMatch(/^│ ├ #0 agent 0\s+✓ 9\.1k 41\.0s$/)
    expect(texts[3]).toMatch(/^│ ├ #3 agent 3\s+● 7\.4k 1m02s\s+» webfetch https:\/\/docs\.example\.com\s+msg 1$/)
    expect(texts[4]).toMatch(/^│ └ #6 agent 6\s+◌ queued\s+msg 1 held$/)
    // Only narrow glyphs: emoji-capable ones (✉ ⚙ ✎) render double-width in some terminals and shift the row.
    for (const t of texts) expect(t).not.toMatch(/[✉⚙✎]/)
    expect(texts[5]).toMatch(/^├ Judge \(strong\)\s+0\/0$/)
    expect(texts[6]).toMatch(/^└ \(no phase\)\s+1\/1 · 21\.0k · 12\.0s$/)
    expect(texts[7]).toMatch(/^  └ #9 agent 9\s+✓ 21\.0k/)
    expect(texts[8]).toMatch(/^deep-research\s+✓ completed/)
    // The newest run stays open when it finishes (the user is watching it); older finished runs are closed.
    const justDone = rowsFor(
      store([run({ status: "completed", endedAt: 50 }), run({ runId: "wf_old", status: "completed", startedAt: -5 })]),
      new Map(),
      { directory: DIR, sessionID: S },
    )
    expect(justDone.map((r) => r.kind)).toEqual(["run", "phase", "phase", "run"])
    // Collapsing a run hides its phases; expanding the finished run shows them.
    const collapsed = rowsFor(s, new Map([["run:wf_ab12", false], ["run:wf_old", true]]), { directory: DIR, sessionID: S })
    expect(collapsed.map((r) => r.kind)).toEqual(["run", "run", "phase", "phase"])
  })

  test("X15 keys map to actions: Enter opens, x stops after a confirm, p pauses/resumes, m/M message, arrows expand", () => {
    const s = store([run()], [agent(3), agent(4, { status: "completed" }), agent(5, { status: "queued", sessionID: null })])
    const rows = rowsFor(s, new Map(), { directory: DIR, sessionID: S })
    const find = (pred: (r: Row) => boolean) => rows.find(pred)!
    const runRow = find((r) => r.kind === "run")
    const phaseRow = find((r) => r.kind === "phase" && r.title === "Research")
    const a3 = find((r) => r.kind === "agent" && r.agent.index === 3)
    const a4 = find((r) => r.kind === "agent" && r.agent.index === 4)
    const a5 = find((r) => r.kind === "agent" && r.agent.index === 5)
    expect(actionFor(a3, "return")).toEqual({ type: "open", sessionID: "ses_c3" })
    expect(actionFor(runRow, "return")).toEqual({ type: "open", sessionID: S })
    expect(actionFor(a5, "return")).toEqual({ type: "toast", message: "#5 has no session yet (it is queued)", variant: "info" })
    expect(actionFor(a3, "x")).toMatchObject({ type: "confirm", control: { runId: "wf_ab12", action: "stop_agent", agentIndex: 3 } })
    expect(actionFor(runRow, "x")).toMatchObject({ type: "confirm", control: { runId: "wf_ab12", action: "stop" } })
    expect(actionFor(a4, "x")).toMatchObject({ type: "toast" })
    expect(actionFor(phaseRow, "x")).toBeNull()
    expect(actionFor(a3, "p")).toEqual({ type: "control", control: { runId: "wf_ab12", action: "pause" } })
    expect(actionFor(rowsFor(store([run({ status: "paused" })]), new Map(), { directory: DIR, sessionID: S })[0], "p")).toEqual({
      type: "control",
      control: { runId: "wf_ab12", action: "resume" },
    })
    expect(actionFor(a3, "m")).toMatchObject({ type: "prompt", control: { runId: "wf_ab12", action: "message", agentIndex: 3, urgent: false } })
    expect(actionFor(a3, "M")).toMatchObject({ type: "prompt", control: { agentIndex: 3, urgent: true } })
    expect(actionFor(phaseRow, "m")).toMatchObject({ type: "prompt", control: { action: "message", phase: "Research" } })
    expect(actionFor(runRow, "m")).toMatchObject({ type: "prompt", control: { action: "message", all: true } })
    expect(actionFor(runRow, "left")).toEqual({ type: "expand", key: "run:wf_ab12", open: false })
    expect(actionFor(phaseRow, "right")).toEqual({ type: "expand", key: "phase:wf_ab12:Research", open: true })
    expect(actionFor(runRow, "a")).toEqual({ type: "filter" })
    expect(actionFor(phaseRow, "return")).toEqual({ type: "toggle", key: "phase:wf_ab12:Research" })
    expect(isOpen(rows, "run:wf_ab12")).toBe(true)
    expect(isOpen(rows, "phase:wf_ab12:Research")).toBe(true)
    expect(isOpen(rows, "agent:wf_ab12:3")).toBe(false)
    // A finished run takes no control actions.
    const fin = rowsFor(store([run({ status: "completed" })]), new Map([["run:wf_ab12", true]]), { directory: DIR, sessionID: S })[0]!
    expect(actionFor(fin, "p")).toMatchObject({ type: "toast" })
    expect(actionFor(fin, "m")).toMatchObject({ type: "toast" })
  })

  test("X15 events are filtered by Location and session; seq gaps ask for a resync; the target Location is the parent's", () => {
    const f = { directory: "C:\\Work\\Proj\\", sessionID: S }
    expect(acceptRun(run(), f, true)).toBe(true) // same directory, spelled differently (Windows)
    expect(acceptRun(run({ directory: "C:\\other" }), f, true)).toBe(false)
    expect(acceptRun(run({ parentSessionID: "ses_x" }), f, true)).toBe(false)
    expect(acceptRun(run({ parentSessionID: "ses_x" }), { ...f, sessionID: null }, true)).toBe(true)

    const s = store([run()])
    expect(s.apply({ seq: 2, runs: [run({ tokens: 1 })], agents: [agent(0)] })).toEqual({ gap: false })
    expect(s.runs.get("wf_ab12")!.tokens).toBe(1)
    expect(s.agents.get("wf_ab12")!.get(0)!.status).toBe("running")
    expect(s.apply({ seq: 5, runs: [], agents: [] })).toEqual({ gap: true })
    s.finished({ runId: "wf_ab12", status: "completed" } as any)
    expect(s.runs.get("wf_ab12")!.status).toBe("completed")

    // Viewing a workflow child: calls go to its parent session's Location.
    const sessions: Record<string, any> = {
      ses_child: { id: "ses_child", location: { directory: "C:\\wt\\one" }, metadata: { workflowRunId: "wf_ab12", parentSessionID: S } },
      [S]: { id: S, location: { directory: DIR } },
    }
    const get = (id: string) => sessions[id]
    expect(targetFor({ type: "session", sessionID: "ses_child" }, get, "C:\\default")).toEqual({ sessionID: S, directory: DIR })
    expect(targetFor({ type: "session", sessionID: S }, get, "C:\\default")).toEqual({ sessionID: S, directory: DIR })
    expect(targetFor({ type: "home" }, get, "C:\\default")).toEqual({ sessionID: null, directory: "C:\\default" })
  })
})

describe("X15 resync after a server restart and during a sync", () => {
  test("X15 a delta from a restarted plugin instance (new epoch, seq back to 1) is applied and asks for a resync", () => {
    const s = new TreeStore()
    s.replace({ seq: 40, epoch: "old", runs: [run({ runId: "wf_old", status: "stopped" })], agents: [] })
    const res = s.apply({ seq: 1, epoch: "new", runs: [run({ runId: "wf_new" })], agents: [agent(0, { runId: "wf_new" })] })
    expect(res).toEqual({ gap: true })
    expect(s.runs.get("wf_new")?.status).toBe("running")
    expect(s.agents.get("wf_new")?.get(0)?.status).toBe("running")
    expect(s.epoch).toBe("new")
    // The new instance's next delta follows on.
    expect(s.apply({ seq: 2, epoch: "new", runs: [run({ runId: "wf_new", tokens: 5 })], agents: [] })).toEqual({ gap: false })
    expect(s.runs.get("wf_new")?.tokens).toBe(5)
    // Same epoch: a repeated delta is ignored, an older one (seq went back) asks for a resync.
    expect(s.apply({ seq: 2, epoch: "new", runs: [run({ runId: "wf_new", tokens: 1 })], agents: [] })).toEqual({ gap: false })
    expect(s.runs.get("wf_new")?.tokens).toBe(5)
    expect(s.apply({ seq: 1, epoch: "new", runs: [], agents: [] })).toEqual({ gap: true })
  })

  test("X15 a list result older than the deltas that arrived while it was in flight does not rewind the tree", () => {
    const s = new TreeStore()
    s.replace({ seq: 3, epoch: "e", runs: [run()], agents: [agent(0)] })
    s.beginSync()
    // While `list` is in flight: the final delta and the finished event of the run arrive.
    s.apply({ seq: 4, epoch: "e", runs: [run({ status: "completed", endedAt: 10 })], agents: [agent(0, { status: "completed" })] })
    expect(s.finished({ runId: "wf_ab12", status: "completed", durationMs: 10, tokens: 9, cost: 0 } as any)).toBe(true)
    // The list response was computed before them (seq 3): it still says running.
    s.replace({ seq: 3, epoch: "e", runs: [run()], agents: [agent(0)] })
    expect(s.runs.get("wf_ab12")?.status).toBe("completed")
    expect(s.agents.get("wf_ab12")?.get(0)?.status).toBe("completed")
    expect(s.seq).toBe(4)
    // A list that is newer than the buffered deltas wins.
    s.beginSync()
    s.apply({ seq: 5, epoch: "e", runs: [run({ runId: "wf_x", tokens: 1 })], agents: [] })
    s.replace({ seq: 6, epoch: "e", runs: [run({ runId: "wf_x", tokens: 2 })], agents: [] })
    expect(s.runs.get("wf_x")?.tokens).toBe(2)
    expect(s.seq).toBe(6)
    // Buffered deltas of another instance are dropped (the list's instance is authoritative).
    s.beginSync()
    s.apply({ seq: 99, epoch: "gone", runs: [run({ runId: "wf_ghost" })], agents: [] })
    s.replace({ seq: 1, epoch: "e2", runs: [], agents: [] })
    expect(s.runs.has("wf_ghost")).toBe(false)
    expect(s.epoch).toBe("e2")
  })

  test("X15 X16 finished() is true once per run the tree shows and did not already know as finished (only those notify)", () => {
    const s = store([run(), run({ runId: "wf_done", status: "completed" })])
    expect(s.finished({ runId: "wf_ab12", status: "completed" } as any)).toBe(true)
    expect(s.finished({ runId: "wf_ab12", status: "completed" } as any)).toBe(false) // already finished
    expect(s.finished({ runId: "wf_done", status: "completed" } as any)).toBe(false)
    expect(s.finished({ runId: "wf_unknown", status: "failed" } as any)).toBe(false)
  })
})

describe("X14 X15 widths", () => {
  const W = (t: string) => [...t].length

  test("X15 a run row that is too wide drops the runId first and keeps status, progress, tokens, cost and elapsed", () => {
    const row = rowsFor(store([run({ runId: "wf_0muehptf90000_d3038d11", workflowName: "verify-steer", steeredAgents: 2 })]), new Map(), {
      directory: DIR,
      sessionID: S,
    })[0]!
    const full = rowText(row, 18_500)
    expect(full).toMatch(/wf_0muehptf90000_d3038d11$/)
    const fitted = rowText(row, 18_500, 70)
    expect(W(fitted)).toBeLessThanOrEqual(70)
    expect(fitted).toBe("verify-steer  ● running  7/12 · 81.2k · $0.42 · 18.5s · 2 steered")
    // Narrower: the steered count goes, then the name is shortened; the numbers stay.
    const narrow = rowText(row, 18_500, 50)
    expect(W(narrow)).toBeLessThanOrEqual(50)
    expect(narrow).toMatch(/● running  7\/12 · 81\.2k · \$0\.42 · 18\.5s$/)
    expect(narrow.startsWith("verif")).toBe(true)
  })

  test("X15 agent and phase rows shorten the activity, then the label or model, never the counts", () => {
    const s = store(
      [run()],
      [
        agent(3, {
          label: "a rather long agent label here",
          activity: { kind: "tool", text: "webfetch https://docs.example.com/a/very/long/path", at: 0 },
          messages: { sent: 1, delivered: 0, held: 0 },
        }),
      ],
    )
    const rows = rowsFor(s, new Map(), { directory: DIR, sessionID: S })
    const a = rows.find((r) => r.kind === "agent")!
    const t60 = rowText(a, 62_000, 60)
    expect(W(t60)).toBeLessThanOrEqual(60)
    expect(t60).toMatch(/● 7\.4k 1m02s/)
    expect(t60).toMatch(/msg 1$/)
    const t40 = rowText(a, 62_000, 40)
    expect(W(t40)).toBeLessThanOrEqual(40)
    expect(t40).toMatch(/#3 .*● 7\.4k 1m02s  msg 1$/)
    const p = rows.find((r) => r.kind === "phase")!
    const tp = rowText(p, 0, 36)
    expect(W(tp)).toBeLessThanOrEqual(36)
    expect(tp).toMatch(/1\/3 · 1 running · 60\.0k · 3m40s$/)
    // Moderately narrow: a provider/model label loses its provider (X19), then the title is shortened
    // before the label (X10's label stays).
    const tp50 = rowText(p, 0, 50)
    expect(W(tp50)).toBeLessThanOrEqual(50)
    expect(tp50).toBe("├ Rese… (gpt-5.4)  1/3 · 1 running · 60.0k · 3m40s")
    // A long label is shortened before the live activity is dropped.
    const long = rowsFor(
      store([run()], [agent(1, { label: "alpha: a slow agent with a long label", activity: { kind: "tool", text: 'slow_step {"n":6}', at: 0 } })]),
      new Map(),
      { directory: DIR, sessionID: S },
    ).find((r) => r.kind === "agent")!
    const t58 = rowText(long, 28_800, 58)
    expect(W(t58)).toBeLessThanOrEqual(58)
    expect(t58).toMatch(/#1 alpha: a slow.*… {2}● 7\.4k 28\.8s {2}» slow_st/)
  })

  test("X14 footer: the workflow name is shortened before the counts; parts keep the counts separate", () => {
    const r = run({ workflowName: "verify-urgent-with-a-long-name", agents: { total: 2, done: 1, running: 1, queued: 0 }, tokens: 94_100, cost: 0.01 })
    expect(footerText([r], S)).toBe("wf verify-urgent-with-a-long-name 1/2 · 94.1k · $0.01")
    const fitted = footerText([r], S, 30)
    expect(W(fitted)).toBeLessThanOrEqual(30)
    expect(fitted).toMatch(/^wf ver.*… 1\/2 · 94\.1k · \$0\.01$/)
    expect(footerParts([r], S)).toEqual({ name: "wf verify-urgent-with-a-long-name", stats: " 1/2 · 94.1k · $0.01" })
    expect(footerParts([], S)).toBeNull()
  })

  test("X15 the key help line drops whole hints (fold, scope, esc, then move), never cutting one in half", () => {
    expect(helpText()).toBe("↑↓ move · ←→ fold · enter open · x stop · p pause · m/M message · a scope · esc close")
    const mid = helpText(60)
    expect(W(mid)).toBeLessThanOrEqual(60)
    expect(mid).toBe("↑↓ move · enter open · x stop · p pause · m/M message")
    const narrow = helpText(45)
    expect(W(narrow)).toBeLessThanOrEqual(45)
    expect(narrow).toBe("enter open · x stop · p pause · m/M message")
  })

  test("X15 fitSegments drops, then clips by priority, then cuts the end", () => {
    const segs = [{ text: "name", clip: 2, min: 2 }, { text: " keep" }, { text: " id", drop: 0 }]
    expect(fitSegments(segs, 100)).toBe("name keep id")
    expect(fitSegments(segs, 9)).toBe("name keep")
    expect(fitSegments(segs, 7)).toBe("n… keep")
    expect(fitSegments(segs, 4)).toBe("n… …")
  })
})

describe("X16 finish notification", () => {
  test("X16 a finished run notifies through attention.notify (when blurred), falling back to a toast when it is skipped", async () => {
    const evt = { runId: "wf_ab12", workflowName: "deep-research", status: "completed", agents: 12, tokens: 81_234, cost: 0.42, durationMs: 312_000 } as any
    const calls: any[] = []
    const toasts: any[] = []
    const toast = { show: (o: any) => toasts.push(o) }
    const shown = { notify: async (o: any) => (calls.push(o), { ok: true, notification: true, sound: false }) }
    expect(await notifyFinished(evt, { attention: shown, toast })).toBe("notified")
    expect(calls[0]).toMatchObject({ title: "Workflow deep-research completed", notification: { when: "blurred" } })
    expect(calls[0].message).toBe("12 agents · 81.2k tokens · $0.42 · 5m12s")
    expect(toasts).toHaveLength(0)
    const skipped = { notify: async () => ({ ok: false, notification: false, sound: false, skipped: "focus_unknown" }) }
    expect(await notifyFinished({ ...evt, status: "failed" }, { attention: skipped, toast })).toBe("toast")
    expect(toasts[0]).toMatchObject({ title: "Workflow deep-research failed", variant: "warning" })
    const throwing = { notify: async () => Promise.reject(new Error("no renderer")) }
    expect(await notifyFinished(evt, { attention: throwing, toast })).toBe("toast")
    expect(toasts[1]).toMatchObject({ variant: "success" })
  })
})

describe("X19 model on agent and phase rows", () => {
  const W = (t: string) => [...t].length
  const rowsOf = (agents: AgentView[], runs: RunView[] = [run()]) => rowsFor(store(runs, agents), new Map(), { directory: DIR, sessionID: S })

  test("X19 an agent row shows its model: provider and variant go first, then the name is shortened and dropped, never status or counts", () => {
    const a = rowsOf([agent(3, { label: "reviewer", model: "openai/gpt-5.4-mini#high", activity: { kind: "tool", text: "bash npm test", at: 0 } })]).find(
      (r) => r.kind === "agent",
    )!
    const wide = rowText(a, 62_000)
    expect(wide).toMatch(/#3 reviewer {2}● 7\.4k 1m02s {2}openai\/gpt-5\.4-mini#high {2}» bash npm test$/)
    const noProvider = rowText(a, 62_000, 70)
    expect(W(noProvider)).toBeLessThanOrEqual(70)
    expect(noProvider).toMatch(/● 7\.4k 1m02s {2}gpt-5\.4-mini#high {2}» bash/)
    const bare = rowText(a, 62_000, 60)
    expect(W(bare)).toBeLessThanOrEqual(60)
    expect(bare).toMatch(/#3 reviewer {2}● 7\.4k 1m02s {2}gpt-5\.4-mini {2}» bash/)
    const narrow = rowText(a, 62_000, 38)
    expect(W(narrow)).toBeLessThanOrEqual(38)
    expect(narrow).toMatch(/● 7\.4k 1m02s/)
    expect(narrow).not.toMatch(/gpt/)
    // A queued agent without a model shows nothing extra.
    const q = rowsOf([agent(4, { status: "queued", model: null })]).find((r) => r.kind === "agent")!
    expect(rowText(q, 0)).toMatch(/#4 agent 4 {2}◌ queued$/)
  })

  test("X19 a phase without a label shows its agents' shared model in short form when narrow", () => {
    const r = run({ phases: [{ title: "Work", model: "openai/gpt-5.4-mini#high", agents: 2, done: 1, running: 1, tokens: 1000, elapsedMs: 5000 }], ungrouped: null })
    const p = rowsOf([], [r]).find((x) => x.kind === "phase")!
    expect(rowText(p, 0)).toBe("└ Work (openai/gpt-5.4-mini#high)  1/2 · 1 running · 1.0k · 5.0s")
    expect(rowText(p, 0, 58)).toBe("└ Work (gpt-5.4-mini#high)  1/2 · 1 running · 1.0k · 5.0s")
    expect(rowText(p, 0, 52)).toBe("└ Work (gpt-5.4-mini)  1/2 · 1 running · 1.0k · 5.0s")
    // A free-form label or a list of models is only shortened, never re-parsed.
    const list = rowsOf([], [run({ phases: [{ ...r.phases[0]!, model: "a/one, b/two +1" }], ungrouped: null })]).find((x) => x.kind === "phase")!
    expect(rowText(list, 0)).toBe("└ Work (a/one, b/two +1)  1/2 · 1 running · 1.0k · 5.0s")
  })
})
