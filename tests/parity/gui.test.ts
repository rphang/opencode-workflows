// Extensions beyond Claude Code (docs/PARITY.md "Extensions", X28–X30): the desktop app (GUI)
// companion's composer pill, side panel tree and finish notice, tested through its pure model
// (src/gui/model.ts) over the shared client logic (src/client/). The Solid view itself only renders.

import { describe, expect, test } from "bun:test"
import { actionFor, isOpen, rowsFor, TreeStore, type Row } from "../../src/client/tree.ts"
import en from "../../src/gui/i18n/en.ts"
import {
  actionToast,
  controlToast,
  entryKey,
  notifyPlan,
  panelKey,
  panelLine,
  pillView,
  reconcilePlan,
  rowButtons,
  rowText,
  sessionTarget,
  shouldToast,
  translator,
  wantedEntries,
} from "../../src/gui/model.ts"
import { agent, DIR, run, S } from "../helpers/fake-tree-rpc.ts"

const t = translator(en)

function treeOf(runs = [run()], agents = [agent(0)]) {
  const s = new TreeStore()
  s.replace({ seq: 1, runs, agents })
  return s
}

describe("X28 composer pill", () => {
  test("X28 label `wf <done>/<total> · <tokens> · $<cost>` from the footer parts, the name in the title; hidden without an active run of the session", () => {
    const s = treeOf([run({ agents: { total: 5, done: 3, running: 2, queued: 0 }, tokens: 71_000, cost: 0.05 })])
    const v = pillView(s, S, t)!
    expect(v.label).toBe("wf 3/5 · 71.0k · $0.05")
    expect(v.title).toBe("Workflow deep-research")
    expect(v.tone).toBeUndefined()
    expect(v.icon).toBe("branch-out")
    expect(pillView(s, "ses_other", t)).toBeUndefined()
    expect(pillView(s, null, t)).toBeUndefined()
    expect(pillView(treeOf([run({ status: "completed" })]), S, t)).toBeUndefined()
  })

  test("X28 more active runs add ` +n`; one row per active run (newest first) with its counts as detail", () => {
    const s = treeOf([
      run({ runId: "wf_old", workflowName: "review", startedAt: 1, agents: { total: 2, done: 1, running: 1, queued: 0 } }),
      run({ runId: "wf_new", workflowName: "deep-research", startedAt: 5, tokens: 1200, cost: 0.42 }),
      run({ runId: "wf_done", status: "completed", startedAt: 9 }),
    ])
    const v = pillView(s, S, t)!
    expect(v.label).toBe("wf 0/2 · 1.2k · $0.42 +1")
    expect(v.rows.map((r) => [r.id, r.label, r.detail])).toEqual([
      ["wf_new", "deep-research", "0/2 · 1.2k · $0.42"],
      ["wf_old", "review", "1/2 · 0 · $0"],
    ])
  })

  test("X28 paused: `‖` in the title and warning tone; warnings > 0 warn too", () => {
    const paused = pillView(treeOf([run({ status: "paused" })]), S, t)!
    expect(paused.title).toBe("Workflow deep-research ‖ paused")
    expect(paused.tone).toBe("warning")
    expect(paused.rows[0]!.tone).toBe("warning")
    expect(pillView(treeOf([run({ warnings: 2 })]), S, t)!.tone).toBe("warning")
  })

  test("X28 danger tone on a run error or a failed agent (it wins over warning)", () => {
    expect(pillView(treeOf([run({ error: "boom", status: "paused" })]), S, t)!.tone).toBe("danger")
    const s = treeOf([run({ warnings: 1 })], [agent(0), agent(1, { status: "failed" })])
    const v = pillView(s, S, t)!
    expect(v.tone).toBe("danger")
    expect(v.rows[0]!.tone).toBe("danger")
  })

  test("X28 missing or unknown fields are treated as defaults (an older server plugin)", () => {
    const old = { ...run(), warnings: undefined, error: undefined, phases: undefined } as never
    const v = pillView(treeOf([old], []), S, t)!
    expect(v.label).toBe("wf 0/2 · 0 · $0")
    expect(v.tone).toBeUndefined()
  })

  test("X28 a workflow child tab targets its parent session and the parent's Location (worktree children live elsewhere)", () => {
    const sessions: Record<string, unknown> = {
      ses_child: { id: "ses_child", location: { directory: "/work/wt" }, metadata: { workflowRunId: "wf_ab12", parentSessionID: S } },
      [S]: { id: S, location: { directory: DIR } },
    }
    const get = (id: string) => sessions[id] as never
    expect(sessionTarget({ serverID: "sidecar", sessionID: "ses_child", directory: "/work/wt" }, get)).toEqual({
      serverID: "sidecar",
      sessionID: S,
      directory: DIR,
    })
    expect(sessionTarget({ serverID: "sidecar", sessionID: S, directory: DIR }, get)).toEqual({ serverID: "sidecar", sessionID: S, directory: DIR })
    // Unknown session data (not synced yet, or a getter that throws): its own id and directory.
    const throws = () => {
      throw new Error("missing")
    }
    expect(sessionTarget({ serverID: "s2", sessionID: "ses_x", directory: "/a" }, throws)).toEqual({ serverID: "s2", sessionID: "ses_x", directory: "/a" })
  })

  test("X28 one sync per server and Location: open sessions map to entries, closed ones are pruned, new ones created", () => {
    const wanted = wantedEntries([
      { serverID: "sidecar", sessionID: S, directory: DIR },
      { serverID: "sidecar", sessionID: "ses_b", directory: DIR },
      { serverID: "http://remote", sessionID: "ses_c", directory: DIR },
      { serverID: "sidecar", sessionID: "ses_d", directory: "" },
    ])
    expect([...wanted.keys()]).toEqual([entryKey("sidecar", DIR), entryKey("http://remote", DIR)])
    expect(wanted.get(entryKey("http://remote", DIR))).toEqual({ serverID: "http://remote", directory: DIR })
    const plan = reconcilePlan([entryKey("sidecar", DIR), entryKey("sidecar", "/gone")], wanted)
    expect(plan).toEqual({ create: [entryKey("http://remote", DIR)], dispose: [entryKey("sidecar", "/gone")] })
    expect(reconcilePlan(wanted.keys(), wanted)).toEqual({ create: [], dispose: [] })
  })
})

describe("X29 side panel tree", () => {
  const runs = [
    run({ runId: "wf_ab12", phases: [{ title: "Research", model: null, agents: 3, done: 1, running: 1, tokens: 900, elapsedMs: 4000 }] }),
    run({ runId: "wf_done", status: "completed", startedAt: -5 }),
    run({ runId: "wf_paused", status: "paused", startedAt: -2 }),
  ]
  const agents = [
    agent(0, { phase: "Research" }),
    agent(1, { phase: "Research", status: "queued", sessionID: null }),
    agent(2, { phase: "Research", status: "completed" }),
    agent(3, { phase: null, status: "failed", error: "bad\nmore" }),
    agent(0, { runId: "wf_done", status: "completed" }),
    agent(0, { runId: "wf_paused" }),
  ]
  const s = treeOf(runs, agents)
  const expanded = new Map<string, boolean>([["run:wf_done", true]])
  const rows = rowsFor(s, expanded, { directory: DIR, sessionID: S })
  const KEYS = ["return", "left", "right", "x", "p", "m", "M"]

  test("X29 the panel key is `<plugin id>:tree`", () => {
    expect(panelKey("@rphang/opencode-workflows")).toBe("@rphang/opencode-workflows:tree")
  })

  test("X29 every row button dispatches exactly actionFor(row, key); every applicable action has a button", () => {
    expect(rows.length).toBeGreaterThan(8)
    for (const row of rows) {
      const buttons = rowButtons(row, { open: isOpen(rows, row.key) }, t)
      for (const b of buttons) {
        const a = actionFor(row, b.key)
        expect(a).not.toBeNull()
        expect(a!.type).not.toBe("toast")
      }
      const applicable = KEYS.filter((k) => {
        const a = actionFor(row, k)
        if (!a || a.type === "toast") return false
        // The fold button shows the one direction that changes something.
        if (k === "left" || k === "right") return (k === "left") === isOpen(rows, row.key)
        // Enter on a phase row only folds it: the fold button covers it.
        if (row.kind === "phase" && k === "return") return false
        // Pause/resume acts on the whole run: only its run row has the button.
        return !(k === "p" && row.kind !== "run")
      })
      expect(buttons.map((b) => b.key).sort()).toEqual(applicable.sort())
    }
  })

  test("X29 buttons by row: run (fold, open, pause, stop, message), queued agent (stop, message, no open), phase (fold, message), finished run (fold, open)", () => {
    const ids = (r: Row | undefined) => rowButtons(r!, { open: isOpen(rows, r!.key) }, t).map((b) => b.id)
    expect(ids(rows.find((r) => r.key === "run:wf_ab12"))).toEqual(["fold", "open", "pause", "stop", "message", "urgent"])
    expect(ids(rows.find((r) => r.key === "run:wf_paused"))).toEqual(["fold", "open", "resume", "stop", "message", "urgent"])
    expect(ids(rows.find((r) => r.key === "agent:wf_ab12:1"))).toEqual(["stop", "message", "urgent"])
    expect(ids(rows.find((r) => r.key === "agent:wf_ab12:0"))).toEqual(["open", "stop", "message", "urgent"])
    expect(ids(rows.find((r) => r.key === "agent:wf_ab12:3"))).toEqual(["open"])
    expect(ids(rows.find((r) => r.kind === "phase" && r.title === "Research"))).toEqual(["fold", "message", "urgent"])
    expect(ids(rows.find((r) => r.key === "run:wf_done"))).toEqual(["fold", "open"])
    const fold = rowButtons(rows.find((r) => r.key === "run:wf_ab12")!, { open: true }, t)[0]!
    expect(fold).toMatchObject({ id: "fold", key: "left", icon: "chevron-down", label: "Collapse" })
  })

  test("X29 open is left out when it would open the session the panel is next to", () => {
    const row = rows.find((r) => r.key === "run:wf_ab12")!
    expect(rowButtons(row, { open: true, viewedSessionID: S }, t).map((b) => b.id)).not.toContain("open")
  })

  test("X29 row text: status glyph, title and a muted detail; agents nest under phases", () => {
    const now = 65_000
    const runRow = rowText(rows.find((r) => r.key === "run:wf_ab12")!, now)
    expect(runRow).toMatchObject({ glyph: "●", title: "deep-research", depth: 0 })
    expect(runRow.detail).toBe("running · 0/2 · 0 · $0 · 1m05s · wf_ab12")
    const phase = rowText(rows.find((r) => r.kind === "phase" && r.title === "Research")!, now)
    expect(phase).toMatchObject({ title: "Research", depth: 1, detail: "1/3 · 1 running · 900 · 4.0s" })
    const failed = rowText(rows.find((r) => r.key === "agent:wf_ab12:3")!, now)
    expect(failed).toMatchObject({ glyph: "✗", title: "#3 agent 3", depth: 2, tone: "danger" })
    expect(failed.detail).toBe("failed · 0 · 1m05s · bad")
    const queued = rowText(rows.find((r) => r.key === "agent:wf_ab12:1")!, now)
    expect(queued.detail).toBe("queued")
  })

  test("X29 a declared phase that has no agents yet shows the queued glyph, not ✓", () => {
    const base = rows.find((r) => r.kind === "phase" && r.title === "Research")
    if (base?.kind !== "phase") throw new Error("fixture has no Research phase")
    const pending = { ...base, title: "Report", phase: { title: "Report", model: "m/report", agents: 0, done: 0, running: 0, tokens: 0, elapsedMs: null } }
    expect(rowText(pending, 65_000)).toMatchObject({ glyph: "◌", title: "Report", detail: "m/report · 0/0" })
    const finished = { ...pending, phase: { ...pending.phase, agents: 2, done: 2 } }
    expect(rowText(finished, 65_000).glyph).toBe("✓")
  })

  test("X29 toasts: an action's info toast, a control answer, and one line when the plugin is unavailable", () => {
    expect(actionToast({ type: "toast", message: "run wf_ab12 is completed", variant: "info" })).toEqual({
      title: "run wf_ab12 is completed",
      variant: "default",
      icon: "info",
    })
    expect(actionToast({ type: "toast", message: "x", variant: "warning" }).icon).toBe("warning")
    expect(controlToast({ ok: true, message: "paused wf_ab12" }, t)).toEqual({ title: "Workflows", description: "paused wf_ab12", variant: "success" })
    expect(controlToast({ ok: false, message: "no such run" }, t).variant).toBe("error")
    expect(controlToast(undefined, t)).toEqual({ title: "Workflows", description: "done", variant: "error" })
    expect(panelLine(undefined, t)).toBe("Workflows are not available for this session")
    expect(panelLine({ available: true, status: "" }, t)).toBe("")
    expect(panelLine({ available: false, status: "workflows RPC unavailable (x); use /workflows" }, t)).toBe(
      "workflows RPC unavailable (x); use /workflows",
    )
    expect(panelLine({ available: false, status: "" }, t)).toBe("Loading workflows…")
  })
})

describe("X30 finish notice", () => {
  const finished = {
    runId: "wf_ab12",
    parentSessionID: S,
    directory: DIR,
    workflowName: "deep-research",
    status: "completed" as const,
    agents: 4,
    tokens: 12_345,
    cost: 0.42,
    durationMs: 65_000,
  }
  const open = [{ serverID: "sidecar", sessionID: S }]

  test("X30 notify: title, message, the parent session to open on click, and an id that dedupes across windows", () => {
    const plan = notifyPlan(finished, "sidecar", open)!
    expect(plan.notify).toEqual({
      title: "Workflow deep-research completed",
      message: "4 agents · 12.3k tokens · $0.42 · 1m05s",
      variant: "default",
      session: { server: "sidecar", id: S },
      id: "dynamic-workflows:sidecar:wf_ab12",
    })
    expect(plan.toast).toEqual({ title: "Workflow deep-research completed", description: "4 agents · 12.3k tokens · $0.42 · 1m05s", variant: "success" })
    expect(notifyPlan({ ...finished, status: "failed" }, "sidecar", open)!.notify.variant).toBe("error")
    expect(notifyPlan({ ...finished, status: "failed" }, "sidecar", open)!.toast.variant).toBe("error")
    expect(notifyPlan({ ...finished, status: "stopped" }, "sidecar", open)!.toast.variant).toBe("default")
  })

  test("X30 only for runs whose parent session is open in a tab of this window (same server)", () => {
    expect(notifyPlan(finished, "http://other", open)).toBeNull()
    expect(notifyPlan({ ...finished, parentSessionID: "ses_closed" }, "sidecar", open)).toBeNull()
    expect(notifyPlan({ ...finished, parentSessionID: null }, "sidecar", open)).toBeNull()
  })

  test("X30 toast fallback only when no system notification was shown, and only in the window showing that session or the focused one", () => {
    expect(shouldToast({ notification: true, sound: true }, { showsSession: true, focused: true })).toBe(false)
    expect(shouldToast({ notification: false, sound: false }, { showsSession: true, focused: false })).toBe(true)
    expect(shouldToast({ notification: false, sound: true }, { showsSession: false, focused: true })).toBe(true)
    expect(shouldToast({ notification: false, sound: false }, { showsSession: false, focused: false })).toBe(false)
  })

  test("X30 the translator interpolates `{{name}}` and falls back to the key", () => {
    expect(translator({ a: "Hi {{name}}, {{name}}" })("a", { name: "x" })).toBe("Hi x, x")
    expect(translator({})("missing.key")).toBe("missing.key")
  })
})
