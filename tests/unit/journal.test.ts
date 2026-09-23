import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RunStore, defaultDataRoot, newRunId } from "../../src/store.ts"
import { ReplayCursor, agentKey, canonicalJson, loadForResume } from "../../src/journal.ts"
import type { JournalEntry, RunSummary } from "../../src/types.ts"
import { ZERO_USAGE } from "../../src/types.ts"

let root: string
let store: RunStore

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "wf-store-"))
  store = new RunStore({ root })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function entry(index: number, key: string, status: JournalEntry["status"] = "completed", value: any = `v${index}`): JournalEntry {
  return { type: "result", index, key, status, value: status === "completed" ? value : undefined, usage: { ...ZERO_USAGE, output: 1 } }
}

function summary(runId: string, startedAt: number, extra: Partial<RunSummary> = {}): RunSummary {
  return {
    runId,
    taskId: `task-${runId}`,
    workflowName: "wf",
    description: "d",
    status: "running",
    startedAt,
    agentCount: 0,
    usage: ZERO_USAGE,
    phases: [],
    logs: [],
    warnings: [],
    scriptPath: "",
    transcriptDir: "",
    ...extra,
  }
}

// ---------------------------------------------------------------- agentKey

describe("agentKey", () => {
  test("is a sha256 hex digest", () => {
    expect(agentKey("hi", {})).toMatch(/^[0-9a-f]{64}$/)
  })
  test("is stable and independent of property order", () => {
    const a = agentKey("p", { model: "m", effort: "low", schema: { type: "object", properties: { a: { type: "string" }, b: { type: "number" } } } })
    const b = agentKey("p", { schema: { properties: { b: { type: "number" }, a: { type: "string" } }, type: "object" }, effort: "low", model: "m" })
    expect(a).toBe(b)
  })
  test("excludes label and phase", () => {
    expect(agentKey("p", { label: "x", phase: "y" })).toBe(agentKey("p", {}))
  })
  test("undefined options equal omitted options", () => {
    expect(agentKey("p", { model: undefined })).toBe(agentKey("p", {}))
    expect(agentKey("p", undefined)).toBe(agentKey("p", {}))
  })
  test("changes with prompt, schema, model, effort, isolation, agentType", () => {
    const base = agentKey("p", {})
    const variants = [
      agentKey("q", {}),
      agentKey("p", { schema: { type: "object" } }),
      agentKey("p", { model: "a/b" }),
      agentKey("p", { effort: "high" }),
      agentKey("p", { isolation: "worktree" }),
      agentKey("p", { agentType: "explore" }),
    ]
    expect(new Set([base, ...variants]).size).toBe(variants.length + 1)
  })
  test("array order in schema matters", () => {
    expect(agentKey("p", { schema: { required: ["a", "b"] } })).not.toBe(agentKey("p", { schema: { required: ["b", "a"] } }))
  })
  test("canonicalJson sorts keys recursively and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[1,{"y":2,"z":1}]},"b":1}')
  })
})

// ---------------------------------------------------------------- ReplayCursor (P41)

describe("ReplayCursor", () => {
  test("doc example: A, B(failed), C, D -> A cached, B/C/D live", () => {
    const c = new ReplayCursor([entry(0, "A"), entry(1, "B", "failed"), entry(2, "C"), entry(3, "D")])
    expect(c.take(0, "A")?.value).toBe("v0")
    expect(c.take(1, "B")).toBeUndefined()
    expect(c.diverged).toBe(true)
    expect(c.take(2, "C")).toBeUndefined()
    expect(c.take(3, "D")).toBeUndefined()
    expect(c.hits).toBe(1)
  })
  test("full unchanged prefix replays every completed agent", () => {
    const c = new ReplayCursor([entry(0, "A"), entry(1, "B"), entry(2, "C")])
    expect(c.take(0, "A")?.value).toBe("v0")
    expect(c.take(1, "B")?.value).toBe("v1")
    expect(c.take(2, "C")?.value).toBe("v2")
    expect(c.hits).toBe(3)
    expect(c.diverged).toBe(false)
    // a new agent beyond the journal runs live
    expect(c.take(3, "D")).toBeUndefined()
    expect(c.diverged).toBe(true)
  })
  test("changed key diverges permanently, even if later keys match", () => {
    const c = new ReplayCursor([entry(0, "A"), entry(1, "B"), entry(2, "C")])
    expect(c.take(0, "A")).toBeDefined()
    expect(c.take(1, "B2")).toBeUndefined()
    expect(c.take(2, "C")).toBeUndefined()
    expect(c.hits).toBe(1)
  })
  test("stopped entry diverges", () => {
    const c = new ReplayCursor([entry(0, "A", "stopped"), entry(1, "B")])
    expect(c.take(0, "A")).toBeUndefined()
    expect(c.take(1, "B")).toBeUndefined()
  })
  test("missing (unfinished) index diverges even if later indexes completed", () => {
    // agent 1 was still running when the run was stopped: no entry
    const c = new ReplayCursor([entry(0, "A"), entry(2, "C")])
    expect(c.take(0, "A")).toBeDefined()
    expect(c.take(1, "B")).toBeUndefined()
    expect(c.take(2, "C")).toBeUndefined()
  })
  test("out-of-order index request diverges (replay is in start order)", () => {
    const c = new ReplayCursor([entry(0, "A"), entry(1, "B")])
    expect(c.take(1, "B")).toBeUndefined()
    expect(c.take(0, "A")).toBeUndefined()
  })
  test("journal lines in completion order are replayed in start order", () => {
    const c = new ReplayCursor([entry(2, "C"), entry(0, "A"), entry(1, "B")])
    expect(c.take(0, "A")).toBeDefined()
    expect(c.take(1, "B")).toBeDefined()
    expect(c.take(2, "C")).toBeDefined()
  })
  test("empty journal: everything live", () => {
    const c = new ReplayCursor([])
    expect(c.take(0, "A")).toBeUndefined()
    expect(c.diverged).toBe(true)
    expect(c.hits).toBe(0)
  })
  test("null completed value is still a cache hit", () => {
    const c = new ReplayCursor([entry(0, "A", "completed", null)])
    const e = c.take(0, "A")
    expect(e).toBeDefined()
    expect(e!.value).toBeNull()
  })
  test("duplicate index: last line wins", () => {
    const c = new ReplayCursor([entry(0, "A", "failed"), entry(0, "A", "completed", "retry")])
    expect(c.take(0, "A")?.value).toBe("retry")
  })
})

// ---------------------------------------------------------------- store

describe("newRunId", () => {
  test("unique and lexicographically sortable in creation order", () => {
    const ids = Array.from({ length: 500 }, () => newRunId())
    expect(new Set(ids).size).toBe(500)
    expect([...ids].sort()).toEqual(ids)
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]+$/)
  })
})

describe("defaultDataRoot", () => {
  test("OPENCODE_WORKFLOW_DATA_DIR wins", () => {
    expect(defaultDataRoot({ OPENCODE_WORKFLOW_DATA_DIR: "/x/y", XDG_DATA_HOME: "/xdg" }, "linux", "/home/u")).toBe("/x/y")
  })
  test("XDG_DATA_HOME on posix and windows", () => {
    expect(defaultDataRoot({ XDG_DATA_HOME: "/xdg" }, "linux", "/home/u")).toBe(join("/xdg", "opencode", "workflows"))
    expect(defaultDataRoot({ XDG_DATA_HOME: "C:\\xdg", LOCALAPPDATA: "C:\\L" }, "win32", "C:\\u")).toBe(join("C:\\xdg", "opencode", "workflows"))
  })
  test("posix fallback ~/.local/share", () => {
    expect(defaultDataRoot({}, "linux", "/home/u")).toBe(join("/home/u", ".local", "share", "opencode", "workflows"))
  })
  test("windows fallback LOCALAPPDATA", () => {
    expect(defaultDataRoot({ LOCALAPPDATA: "C:\\L" }, "win32", "C:\\u")).toBe(join("C:\\L", "opencode", "workflows"))
    expect(defaultDataRoot({}, "win32", "C:\\u")).toBe(join("C:\\u", "AppData", "Local", "opencode", "workflows"))
  })
  test("RunStore uses env root when no option given", () => {
    const prev = process.env.OPENCODE_WORKFLOW_DATA_DIR
    process.env.OPENCODE_WORKFLOW_DATA_DIR = root
    try {
      expect(new RunStore().root).toBe(root)
    } finally {
      if (prev === undefined) delete process.env.OPENCODE_WORKFLOW_DATA_DIR
      else process.env.OPENCODE_WORKFLOW_DATA_DIR = prev
    }
  })
})

describe("RunStore", () => {
  test("P40 createRun lays out <root>/<sessionKey>/<runId> with script, journal, agents", async () => {
    const run = await store.createRun("ses_1")
    expect(run.dir).toBe(join(root, "ses_1", run.runId))
    const scriptPath = await store.writeScript(run.runId, "export const meta = {}")
    expect(scriptPath).toBe(join(run.dir, "script.js"))
    expect(await readFile(scriptPath, "utf8")).toBe("export const meta = {}")
    await store.appendJournal(run.runId, entry(0, "A"))
    await store.writeAgentRecord(run.runId, {
      index: 0, key: "A", label: "a", prompt: "p", opts: {}, status: "completed", usage: ZERO_USAGE,
    })
    const files = (await readdir(run.dir)).sort()
    expect(files).toContain("script.js")
    expect(files).toContain("journal.jsonl")
    expect(files).toContain("agents")
    expect(JSON.parse(await readFile(join(run.dir, "agents", "0.json"), "utf8")).label).toBe("a")
  })

  test("createRun accepts an explicit runId and rejects duplicates / unsafe ids", async () => {
    const run = await store.createRun("s", "run_fixed")
    expect(run.runId).toBe("run_fixed")
    await expect(store.createRun("s", "run_fixed")).rejects.toThrow()
    await expect(store.createRun("s", "../evil")).rejects.toThrow()
  })

  test("sessionKey is sanitized to a single path segment", async () => {
    const run = await store.createRun("../../weird/key:1")
    const rel = run.dir.slice(root.length + 1)
    const parts = rel.split(/[\\/]/)
    expect(parts.length).toBe(2)
    expect(parts[0]).not.toContain("..")
  })

  test("journal append/read round-trips in append order", async () => {
    const { runId } = await store.createRun("s")
    await store.appendJournal(runId, entry(1, "B"))
    await store.appendJournal(runId, entry(0, "A", "completed", { x: [1, 2] }))
    const j = await store.readJournal(runId)
    expect(j.map((e) => e.index)).toEqual([1, 0])
    expect(j[1].value).toEqual({ x: [1, 2] })
  })

  test("concurrent appends all land as whole lines", async () => {
    const { runId } = await store.createRun("s")
    await Promise.all(Array.from({ length: 50 }, (_, i) => store.appendJournal(runId, entry(i, `k${i}`))))
    const j = await store.readJournal(runId)
    expect(j.length).toBe(50)
    expect(new Set(j.map((e) => e.index)).size).toBe(50)
  })

  test("readJournal ignores a torn trailing line and non-result lines", async () => {
    const run = await store.createRun("s")
    await store.appendJournal(run.runId, entry(0, "A"))
    const p = join(run.dir, "journal.jsonl")
    const prev = await readFile(p, "utf8")
    await writeFile(p, prev + '{"type":"other"}\n{"type":"result","ind')
    const j = await store.readJournal(run.runId)
    expect(j.length).toBe(1)
  })

  test("readJournal of a run with no journal returns []", async () => {
    const { runId } = await store.createRun("s")
    expect(await store.readJournal(runId)).toEqual([])
  })

  test("summary write/read is atomic (no tmp files left) and overwrites", async () => {
    const run = await store.createRun("s")
    await store.writeSummary(summary(run.runId, 1))
    await store.writeSummary(summary(run.runId, 1, { status: "completed", result: { ok: true } }))
    const s = await store.readSummary(run.runId)
    expect(s?.status).toBe("completed")
    expect(s?.result).toEqual({ ok: true })
    const files = await readdir(run.dir)
    expect(files.filter((f) => f.includes("tmp"))).toEqual([])
  })

  test("atomic write retries a transient EPERM/EBUSY rename (Windows: run.json open by a reader)", async () => {
    const calls: string[] = []
    let fails = 2
    const flaky = new RunStore({
      root,
      renameRetryDelaysMs: [1, 1, 1],
      rename: async (from, to) => {
        calls.push(to)
        if (fails > 0) {
          fails--
          throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: fails ? "EPERM" : "EBUSY" })
        }
        await rename(from, to)
      },
    })
    const run = await flaky.createRun("s")
    await flaky.writeSummary(summary(run.runId, 1, { status: "completed", result: 42 }))
    expect(calls.length).toBe(3)
    expect((await flaky.readSummary(run.runId))?.result).toBe(42)
    expect((await readdir(run.dir)).filter((f) => f.includes("tmp"))).toEqual([])
  })

  test("atomic write gives up after the retry schedule and does not retry other errors", async () => {
    let n = 0
    const failing = new RunStore({
      root,
      renameRetryDelaysMs: [1, 1],
      rename: async () => {
        n++
        throw Object.assign(new Error("EACCES"), { code: "EACCES" })
      },
    })
    const run = await failing.createRun("s")
    await expect(failing.writeSummary(summary(run.runId, 1))).rejects.toThrow("EACCES")
    expect(n).toBe(3)
    expect((await readdir(run.dir)).filter((f) => f.includes("tmp"))).toEqual([])
    n = 0
    const other = new RunStore({
      root,
      renameRetryDelaysMs: [1, 1],
      rename: async () => {
        n++
        throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" })
      },
    })
    const run2 = await other.createRun("s")
    await expect(other.writeSummary(summary(run2.runId, 1))).rejects.toThrow("ENOSPC")
    expect(n).toBe(1)
  })

  test("summary write succeeds while a reader briefly holds run.json open (real fs)", async () => {
    const run = await store.createRun("s")
    await store.writeSummary(summary(run.runId, 1))
    const fh = await open(join(run.dir, "run.json"), "r")
    const closing = new Promise<void>((r) => setTimeout(() => void fh.close().then(() => r()), 60))
    await store.writeSummary(summary(run.runId, 1, { status: "completed", result: "final" }))
    await closing
    expect((await store.readSummary(run.runId))?.result).toBe("final")
  })

  test("concurrent summary writes never leave a corrupt run.json", async () => {
    const run = await store.createRun("s")
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.writeSummary(summary(run.runId, 1, { agentCount: i }))))
    const s = await store.readSummary(run.runId)
    expect(typeof s?.agentCount).toBe("number")
  })

  test("readSummary returns undefined for an unknown run", async () => {
    expect(await store.readSummary("nope")).toBeUndefined()
  })

  test("findRun locates a run across session keys, even from a fresh store instance", async () => {
    const a = await store.createRun("sesA")
    const b = await store.createRun("sesB")
    const fresh = new RunStore({ root })
    expect(await fresh.findRun(b.runId)).toEqual({ runId: b.runId, sessionKey: "sesB", dir: join(root, "sesB", b.runId) })
    expect((await fresh.findRun(a.runId))?.sessionKey).toBe("sesA")
    expect(await fresh.findRun("missing")).toBeUndefined()
    expect(await fresh.findRun("../sesA")).toBeUndefined()
    // other methods work through findRun on a fresh instance
    await fresh.appendJournal(b.runId, entry(0, "A"))
    expect((await store.readJournal(b.runId)).length).toBe(1)
  })

  test("findRun on an empty/nonexistent root", async () => {
    const s = new RunStore({ root: join(root, "does-not-exist") })
    expect(await s.findRun("x")).toBeUndefined()
    expect(await s.listRuns()).toEqual([])
  })

  test("listRuns newest first, optionally filtered by session", async () => {
    const r1 = await store.createRun("s1")
    const r2 = await store.createRun("s2")
    const r3 = await store.createRun("s1")
    const noSummary = await store.createRun("s1")
    await store.writeSummary(summary(r1.runId, 100))
    await store.writeSummary(summary(r2.runId, 300))
    await store.writeSummary(summary(r3.runId, 200))
    expect((await store.listRuns()).map((s) => s.runId)).toEqual([r2.runId, r3.runId, r1.runId])
    expect((await store.listRuns("s1")).map((s) => s.runId)).toEqual([r3.runId, r1.runId])
    expect((await store.listRuns("unknown"))).toEqual([])
    void noSummary
  })

  test("operations on an unknown run throw", async () => {
    await expect(store.appendJournal("ghost", entry(0, "A"))).rejects.toThrow(/unknown run/)
    await expect(store.writeScript("ghost", "x")).rejects.toThrow(/unknown run/)
  })
})

// ---------------------------------------------------------------- loadForResume (P42)

describe("loadForResume", () => {
  test("P42 unknown run -> nothing to resume", async () => {
    await expect(loadForResume(store, "ghost")).rejects.toThrow(/^nothing to resume: run ghost/)
  })
  test("P42 run without journal -> nothing to resume", async () => {
    const { runId } = await store.createRun("s")
    await expect(loadForResume(store, runId)).rejects.toThrow(`nothing to resume: run ${runId}`)
  })
  test("P42 run with empty journal file -> nothing to resume", async () => {
    const run = await store.createRun("s")
    await writeFile(join(run.dir, "journal.jsonl"), "")
    await expect(loadForResume(store, run.runId)).rejects.toThrow(/nothing to resume/)
  })
  test("P41 loads journal + summary into a cursor (doc example through disk)", async () => {
    const { runId } = await store.createRun("s")
    await store.writeSummary(summary(runId, 5))
    const keys = ["A", "B", "C", "D"].map((p) => agentKey(p, {}))
    await store.appendJournal(runId, entry(0, keys[0]))
    await store.appendJournal(runId, entry(2, keys[2]))
    await store.appendJournal(runId, entry(1, keys[1], "failed"))
    await store.appendJournal(runId, entry(3, keys[3]))
    const r = await loadForResume(store, runId)
    expect(r.runId).toBe(runId)
    expect(r.summary?.runId).toBe(runId)
    expect(r.entries.length).toBe(4)
    expect(r.cursor.take(0, keys[0])?.value).toBe("v0")
    expect(r.cursor.take(1, keys[1])).toBeUndefined()
    expect(r.cursor.take(2, keys[2])).toBeUndefined()
    expect(r.cursor.take(3, keys[3])).toBeUndefined()
    expect(r.cursor.hits).toBe(1)
  })
})
