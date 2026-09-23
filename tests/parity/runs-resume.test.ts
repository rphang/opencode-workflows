// Parity: runs, journal and resume (P40–P44), through the plugin's `workflow` and
// `workflow_control` tools.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { isRunActive } from "../../src/engine.ts"
import { agentKey } from "../../src/journal.ts"
import { FakeRunner } from "../helpers/fake-runner.ts"
import { createHarness, script, tag, type Harness } from "../helpers/plugin-harness.ts"

let h: Harness
beforeEach(async () => {
  h = await createHarness()
})
afterEach(async () => {
  await h.dispose()
})

function journalLines(dir: string): any[] {
  const file = join(dir, "journal.jsonl")
  if (!existsSync(file)) return []
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
}

describe("P40 transcript dir", () => {
  test("P40 each run has a runId and a transcript dir with script.js, journal.jsonl and per-agent records", async () => {
    const runner = new FakeRunner().on("bad", { status: "failed", error: "api down" })
    const p = await h.setup({ runner })
    const src = script(`await agent("first", { label: "L1" }); await agent("bad"); return 1`)
    const out = await p.call({ script: src })
    await p.notification(0)
    await p.settled(out.runId!)
    const dir = out.transcriptDir!
    expect(readFileSync(join(dir, "script.js"), "utf8")).toBe(src)
    const lines = journalLines(dir)
    expect(lines.length).toBe(2)
    expect(lines[0]).toMatchObject({ type: "result", index: 0, key: agentKey("first", { label: "L1" }), status: "completed", value: "done: first" })
    expect(lines[0].usage).toMatchObject({ input: 100, output: 10 })
    expect(lines[1]).toMatchObject({ type: "result", index: 1, key: agentKey("bad", {}), status: "failed", error: "api down" })
    const rec0 = JSON.parse(readFileSync(join(dir, "agents", "0.json"), "utf8"))
    expect(rec0).toMatchObject({ index: 0, label: "L1", prompt: "first", status: "completed" })
    const rec1 = JSON.parse(readFileSync(join(dir, "agents", "1.json"), "utf8"))
    expect(rec1).toMatchObject({ index: 1, status: "failed", error: "api down" })
    expect(existsSync(join(dir, "run.json"))).toBe(true)
  })

  test("P40 per-agent records hold the FINAL state once the run settles (no stale 'running' write wins)", async () => {
    const p = await h.setup()
    const out = await p.call({ script: script(`return (await parallel(Array.from({ length: 20 }, (_, i) => () => agent("a" + i)))).length`) })
    await p.notification(0)
    await p.settled(out.runId!)
    for (let i = 0; i < 20; i++) {
      const rec = await h.store.readAgentRecord(out.runId!, i)
      expect(rec?.status).toBe("completed")
      expect(rec?.usage.output).toBe(10)
    }
    expect(journalLines(out.transcriptDir!).length).toBe(20)
  })

  test("P40 the notification points at the transcript dir and script path", async () => {
    const p = await h.setup()
    const out = await p.call({ script: script(`return 1`) })
    const text = String((await p.notification(0)).text)
    expect(text).toContain(out.runId!)
    expect(text).toContain(out.transcriptDir!)
    expect(text).toContain(out.scriptPath!)
  })
})

describe("P41 resume", () => {
  test("P41 doc example: A, B (fails), C, D started in that order → relaunch returns A from cache and runs B, C and D again", async () => {
    const runner = new FakeRunner().on(/^B$/, { status: "failed", error: "rate limited" })
    const p = await h.setup({ runner })
    const src = script(`return await parallel([() => agent("A"), () => agent("B"), () => agent("C"), () => agent("D")])`)
    const first = await p.call({ script: src })
    expect(p.resultOf(await p.notification(0))).toEqual(["done: A", null, "done: C", "done: D"])
    await p.settled(first.runId!)
    expect(runner.prompts).toEqual(["A", "B", "C", "D"])

    const runner2 = new FakeRunner()
    const p2 = await h.setup({ runner: runner2 })
    const second = await p2.call({ script: src, resumeFromRunId: first.runId })
    expect(second.error).toBeUndefined()
    expect(p2.resultOf(await p2.notification(0))).toEqual(["done: A", "done: B", "done: C", "done: D"])
    expect(runner2.prompts.sort()).toEqual(["B", "C", "D"])
  })

  test("P41 replay follows START order: the longest unchanged completed prefix is cached", async () => {
    const p = await h.setup()
    const first = await p.call({ script: script(`const a = await agent("A"); const b = await agent("B"); const c = await agent("C"); return [a, b, c]`) })
    await p.notification(0)
    await p.settled(first.runId!)
    expect(p.runner.calls.length).toBe(3)

    // Unchanged script: everything cached, nothing runs.
    const same = await p.call({ script: script(`const a = await agent("A"); const b = await agent("B"); const c = await agent("C"); return [a, b, c]`), resumeFromRunId: first.runId })
    expect(p.resultOf(await p.notification(1))).toEqual(["done: A", "done: B", "done: C"])
    await p.settled(same.runId!)
    expect(p.runner.calls.length).toBe(3)
  })

  test("P41 the first changed call and EVERY call after it run live, even ones that completed", async () => {
    const p = await h.setup()
    const first = await p.call({ script: script(`return [await agent("A"), await agent("B"), await agent("C")]`) })
    await p.notification(0)
    await p.settled(first.runId!)

    const r2 = new FakeRunner()
    const p2 = await h.setup({ runner: r2 })
    await p2.call({ script: script(`return [await agent("A"), await agent("B edited"), await agent("C")]`), resumeFromRunId: first.runId })
    expect(p2.resultOf(await p2.notification(0))).toEqual(["done: A", "done: B edited", "done: C"])
    expect(r2.prompts).toEqual(["B edited", "C"])
  })

  test("P41 changed options count as a changed call (same prompt, different schema/model)", async () => {
    const p = await h.setup()
    const first = await p.call({ script: script(`return [await agent("A"), await agent("B")]`) })
    await p.notification(0)
    await p.settled(first.runId!)
    const r2 = new FakeRunner()
    const p2 = await h.setup({ runner: r2 })
    await p2.call({ script: script(`return [await agent("A", { model: "openai/gpt-5" }), await agent("B")]`), resumeFromRunId: first.runId })
    await p2.notification(0)
    expect(r2.prompts).toEqual(["A", "B"])
  })

  test("P41 label and phase changes do NOT invalidate the cache", async () => {
    const p = await h.setup()
    const first = await p.call({ script: script(`return [await agent("A"), await agent("B")]`) })
    await p.notification(0)
    await p.settled(first.runId!)
    const r2 = new FakeRunner()
    const p2 = await h.setup({ runner: r2 })
    await p2.call({ script: script(`phase("New"); return [await agent("A", { label: "renamed" }), await agent("B")]`), resumeFromRunId: first.runId })
    await p2.notification(0)
    expect(r2.prompts).toEqual([])
  })

  test("P41 an earlier agent returning something different changes later prompts, which then run live", async () => {
    const r1 = new FakeRunner().on("pick", { value: "alpha" })
    const p = await h.setup({ runner: r1 })
    const src = script(`const a = await agent("pick one"); const b = await agent("use " + a); return b`)
    const first = await p.call({ script: src })
    await p.notification(0)
    await p.settled(first.runId!)
    // The resumed run edits the first prompt → it runs live, returns something else → B changes too.
    const r2 = new FakeRunner().on("pick", { value: "beta" })
    const p2 = await h.setup({ runner: r2 })
    await p2.call({ script: src.replace("pick one", "pick one again"), resumeFromRunId: first.runId })
    expect(p2.resultOf(await p2.notification(0))).toBe("done: use beta")
    expect(r2.prompts).toEqual(["pick one again", "use beta"])
  })

  test("P41 a resumed run can itself be resumed", async () => {
    const p = await h.setup()
    const src = script(`return [await agent("A"), await agent("B")]`)
    const first = await p.call({ script: src })
    await p.notification(0)
    await p.settled(first.runId!)
    const second = await p.call({ script: src, resumeFromRunId: first.runId })
    await p.notification(1)
    await p.settled(second.runId!)
    const third = await p.call({ script: src, resumeFromRunId: second.runId })
    expect(third.error).toBeUndefined()
    expect(p.resultOf(await p.notification(2))).toEqual(["done: A", "done: B"])
    expect(p.runner.calls.length).toBe(2)
  })
})

describe("P42 nothing to resume", () => {
  test("P42 resuming an unknown run fails with `nothing to resume` instead of starting over", async () => {
    const p = await h.setup()
    const out = await p.call({ script: script(`return await agent("A")`), resumeFromRunId: "wf_doesnotexist" })
    expect(out.status).toBe("async_launched")
    expect(out.error).toMatch(/nothing to resume/)
    await Bun.sleep(30)
    expect(p.runner.calls.length).toBe(0)
    expect(p.notifications().length).toBe(0)
  })

  test("P42 resuming a run with no saved agent results fails with `nothing to resume`", async () => {
    const p = await h.setup()
    const first = await p.call({ script: script(`return 1`) })
    await p.notification(0)
    await p.settled(first.runId!)
    const out = await p.call({ script: script(`return await agent("A")`), resumeFromRunId: first.runId })
    expect(out.error).toMatch(/nothing to resume/)
    expect(p.runner.calls.length).toBe(0)
  })

  test("P42 resume is scoped to the same session", async () => {
    const p = await h.setup()
    const first = await p.call({ script: script(`return await agent("A")`) })
    await p.notification(0)
    await p.settled(first.runId!)
    const out = await p.call({ script: script(`return await agent("A")`), resumeFromRunId: first.runId }, "ses_someone_else")
    expect(out.error).toMatch(/nothing to resume/)
  })
})

describe("P43 refuse while agents still run", () => {
  test("P43 resume is refused while agents from the stopped run are still running, then allowed once they exit", async () => {
    const runner = new FakeRunner().on("slow", { hold: true, lingerMs: 200 })
    const p = await h.setup({ runner })
    const src = script(`await agent("fast"); return await agent("slow")`)
    const first = await p.call({ script: src })
    await runner.waitForHeld(1)
    // running run: refused
    expect((await p.call({ script: src, resumeFromRunId: first.runId })).error).toMatch(/still running/)
    await p.control({ action: "stop", runId: first.runId })
    // stopped, but the agent has not exited yet: still refused
    expect(isRunActive(first.runId!)).toBe(true)
    const refused = await p.call({ script: src, resumeFromRunId: first.runId })
    expect(refused.error).toMatch(/still running/)
    await p.settled(first.runId!)
    const ok = await p.call({ script: src, resumeFromRunId: first.runId })
    expect(ok.error).toBeUndefined()
  })
})

describe("P44 stopping the whole run", () => {
  test("P44 a whole-run stop counts no agent as failed; running ones restart on resume", async () => {
    const runner = new FakeRunner().on("slow", { hold: true })
    const p = await h.setup({ runner })
    const src = script(`const a = await agent("A"); const b = await parallel([() => agent("slow 1"), () => agent("slow 2")]); return [a, b]`)
    const first = await p.call({ script: src })
    await runner.waitForHeld(2)
    await p.control({ action: "stop", runId: first.runId })
    const n = await p.notification(0)
    expect(tag(String(n.text), "status")).toBe("stopped")
    await p.settled(first.runId!)

    const lines = journalLines(first.transcriptDir!)
    expect(lines.map((l) => l.status).sort()).toEqual(["completed", "stopped", "stopped"])
    expect(lines.some((l) => l.status === "failed")).toBe(false)
    for (const i of [1, 2]) expect((await h.store.readAgentRecord(first.runId!, i))!.status).toBe("stopped")

    const r2 = new FakeRunner()
    const p2 = await h.setup({ runner: r2 })
    await p2.call({ script: src, resumeFromRunId: first.runId })
    expect(p2.resultOf(await p2.notification(0))).toEqual(["done: A", ["done: slow 1", "done: slow 2"]])
    expect(r2.prompts.sort()).toEqual(["slow 1", "slow 2"])
  })

  test("P44 agents only queued when the run stopped are not journaled and run on resume", async () => {
    const runner = new FakeRunner().on("slow", { hold: true })
    const prev = process.env.OPENCODE_WORKFLOW_MAX_CONCURRENT_AGENTS
    process.env.OPENCODE_WORKFLOW_MAX_CONCURRENT_AGENTS = "1"
    try {
      const p = await h.setup({ runner })
      const first = await p.call({ script: script(`return await parallel([() => agent("slow"), () => agent("queued")])`) })
      await runner.waitForHeld(1)
      await p.control({ action: "stop", runId: first.runId })
      await p.notification(0)
      await p.settled(first.runId!)
      expect(runner.prompts).toEqual(["slow"])
      expect(journalLines(first.transcriptDir!).every((l) => l.status !== "failed")).toBe(true)
    } finally {
      if (prev === undefined) delete process.env.OPENCODE_WORKFLOW_MAX_CONCURRENT_AGENTS
      else process.env.OPENCODE_WORKFLOW_MAX_CONCURRENT_AGENTS = prev
    }
  })
})
