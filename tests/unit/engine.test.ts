import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  DEFAULT_MAX_AGENTS,
  LARGE_WORKFLOW_AGENT_THRESHOLD,
  defaultMaxConcurrent,
  getActiveRun,
  isRunActive,
  startRun,
  type StartRunOptions,
  type WorkflowEvent,
  type WorkflowRun,
} from "../../src/engine.ts"
import { agentKey, loadForResume, ReplayCursor } from "../../src/journal.ts"
import { RunStore } from "../../src/store.ts"
import type { JournalEntry, WorkflowMeta } from "../../src/types.ts"
import { FakeRunner, sleep } from "../helpers/fake-runner.ts"

let root: string
let store: RunStore

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "wf-engine-"))
  store = new RunStore({ root })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const META: WorkflowMeta = { name: "test-wf", description: "a test workflow" }

type RunOpts = Partial<StartRunOptions> & { runner?: FakeRunner }

function run(body: string, opts: RunOpts = {}): { wf: WorkflowRun; runner: FakeRunner; events: WorkflowEvent[] } {
  const runner = opts.runner ?? new FakeRunner()
  const events: WorkflowEvent[] = []
  const wf = startRun({
    runId: store.newRunId(),
    taskId: "task_1",
    sessionKey: "ses_parent",
    meta: META,
    body,
    runner,
    store,
    summaryThrottleMs: 5,
    ...opts,
    onEvent: (e) => {
      events.push(e)
      opts.onEvent?.(e)
    },
  })
  return { wf, runner, events }
}

async function journal(runId: string): Promise<JournalEntry[]> {
  return store.readJournal(runId)
}

describe("basic run", () => {
  test("P12 P20 returns the script's return value; agent() resolves to the final text", async () => {
    const { wf, runner } = run(`const a = await agent("hello"); return { a }`)
    const s = await wf.result()
    expect(s.status).toBe("completed")
    expect(s.result).toEqual({ a: "done: hello" })
    expect(runner.prompts).toEqual(["hello"])
    expect(s.agentCount).toBe(1)
    expect(s.workflowName).toBe("test-wf")
    expect(s.description).toBe("a test workflow")
    expect(s.taskId).toBe("task_1")
    expect(s.endedAt).toBeGreaterThanOrEqual(s.startedAt)
    expect(wf.status).toBe("completed")
  })

  test("P05 args exposed verbatim, undefined when omitted", async () => {
    const a = run(`return { args, t: typeof args }`, { args: { xs: [1, 2], s: "x" } })
    expect((await a.wf.result()).result).toEqual({ args: { xs: [1, 2], s: "x" }, t: "object" })
    const b = run(`return typeof args`)
    expect((await b.wf.result()).result).toBe("undefined")
  })

  test("run.json, script path and transcript dir are persisted", async () => {
    const { wf } = run(`return 1`, { source: "export const meta = {name:'x', description:''}\nreturn 1" })
    const s = await wf.result()
    const dir = await store.runDir(wf.runId)
    expect(s.transcriptDir).toBe(dir)
    expect(s.scriptPath).toBe(join(dir, "script.js"))
    expect(await readFile(s.scriptPath, "utf8")).toContain("return 1")
    const onDisk = await store.readSummary(wf.runId)
    expect(onDisk?.status).toBe("completed")
    expect(onDisk?.result).toBe(1)
  })

  test("uses an existing run dir and scriptPath when provided", async () => {
    const runId = store.newRunId()
    const loc = await store.createRun("ses_parent", runId)
    const { wf } = run(`return 2`, { runId, scriptPath: "/somewhere/script.js" })
    const s = await wf.result()
    expect(s.transcriptDir).toBe(loc.dir)
    expect(s.scriptPath).toBe("/somewhere/script.js")
  })

  test("syntax error in body fails the run without starting any agent", async () => {
    const { wf, runner } = run(`await agent("x");\nconst = 3`)
    const s = await wf.result()
    expect(s.status).toBe("failed")
    expect(s.error).toContain("SyntaxError")
    expect(s.error).toContain("line 2")
    expect(runner.calls.length).toBe(0)
  })

  test("uncaught script error fails the run with the message", async () => {
    const { wf } = run(`await agent("a"); throw new Error("kaput")`)
    const s = await wf.result()
    expect(s.status).toBe("failed")
    expect(s.error).toContain("kaput")
    expect(s.agentCount).toBe(1)
  })

  test("P15 Math.random() inside the script fails the run", async () => {
    const s = await run(`return Math.random()`).wf.result()
    expect(s.status).toBe("failed")
    expect(s.error).toContain("Math.random() is not available")
  })

  test("initial warnings are kept in the summary", async () => {
    const s = await run(`return 1`, { warnings: ["meta warning"] }).wf.result()
    expect(s.warnings).toContain("meta warning")
  })

  test("events: run_started, agent updates, run_finished", async () => {
    const { wf, events } = run(`await agent("a"); return 1`)
    await wf.result()
    const types = events.map((e) => e.type)
    expect(types[0]).toBe("run_started")
    expect(types[types.length - 1]).toBe("run_finished")
    const agentStatuses = events.flatMap((e) => (e.type === "agent" ? [e.record.status] : []))
    // status transitions (streamed updates re-emit the same status)
    expect(agentStatuses.filter((s, i) => s !== agentStatuses[i - 1])).toEqual(["queued", "running", "completed"])
    expect(events.some((e) => e.type === "agent" && e.record.sessionID === "ses_fake_0")).toBe(true)
  })

  test("a throwing onEvent does not break the run", async () => {
    const s = await run(`await agent("a"); return 1`, {
      onEvent: () => {
        throw new Error("listener bug")
      },
    }).wf.result()
    expect(s.status).toBe("completed")
  })

  test("un-awaited agents still running when the script returns are stopped", async () => {
    const runner = new FakeRunner().on("bg", { hold: true })
    const { wf } = run(`agent("bg"); await agent("fg"); return "ok"`, { runner })
    const s = await wf.result()
    expect(s.status).toBe("completed")
    await wf.settled()
    expect(runner.finished.find((f) => f.prompt === "bg")?.status).toBe("stopped")
    expect(wf.agents().find((a) => a.prompt === "bg")?.status).toBe("stopped")
  })
})

describe("agent()", () => {
  test("P21 schema: resolves to the validated object", async () => {
    const schema = { type: "object", properties: { n: { type: "number" } }, required: ["n"] }
    const runner = new FakeRunner().on("count", { value: { n: 3 } })
    const s = await run(`return await agent("count", { schema: ${JSON.stringify(schema)} })`, { runner }).wf.result()
    expect(s.result).toEqual({ n: 3 })
    expect(runner.calls[0].opts.schema).toEqual(schema)
  })

  test("P21 schema_failed THROWS with the last validation failure (catchable)", async () => {
    const schema = { type: "object", properties: { n: { type: "number" } }, required: ["n"] }
    const runner = new FakeRunner().on("count", { value: { n: "three" } })
    const s = await run(
      `try { await agent("count", { schema: ${JSON.stringify(schema)} }); return "no" } catch (e) { return String(e.message || e) }`,
      { runner },
    ).wf.result()
    expect(s.status).toBe("completed")
    expect(s.result).toContain("failed validation")
    expect(s.result).toContain("/n")
  })

  test("P21 uncaught schema_failed fails the run and is journaled as failed", async () => {
    const runner = new FakeRunner().on("x", { status: "schema_failed", error: "bad output" })
    const { wf } = run(`await agent("x", { schema: { type: "object" } }); return 1`, { runner })
    const s = await wf.result()
    expect(s.status).toBe("failed")
    expect(s.error).toContain("bad output")
    await wf.settled()
    const j = await journal(wf.runId)
    expect(j[0].status).toBe("failed")
    expect(j[0].error).toContain("bad output")
  })

  test("P22 contradictory schema throws before the subagent starts", async () => {
    const schema = { type: "object", properties: {}, required: ["a"], additionalProperties: false }
    const { wf, runner } = run(
      `try { await agent("x", { schema: ${JSON.stringify(schema)} }) } catch (e) { return String(e.message || e) }`,
    )
    const s = await wf.result()
    expect(String(s.result)).toContain("required key")
    expect(runner.calls.length).toBe(0)
    expect(s.agentCount).toBe(0)
  })

  test("P22 non-object root schema throws before start", async () => {
    const { wf, runner } = run(`try { await agent("x", { schema: { type: "string" } }) } catch (e) { return "threw" }`)
    expect((await wf.result()).result).toBe("threw")
    expect(runner.calls.length).toBe(0)
  })

  test("P23 stopped / failed agents resolve to null", async () => {
    const runner = new FakeRunner().on("stop", { status: "stopped" }).on("fail", { status: "failed", error: "api died" })
    const { wf } = run(`return [await agent("stop"), await agent("fail"), await agent("ok")]`, { runner })
    const s = await wf.result()
    expect(s.result).toEqual([null, null, "done: ok"])
    const recs = wf.agents()
    expect(recs.map((r) => r.status)).toEqual(["stopped", "failed", "completed"])
    expect(recs[1].error).toBe("api died")
  })

  test("P23 a runner that rejects resolves agent() to null (failed)", async () => {
    const runner = new FakeRunner().on("x", { throws: "transport error" })
    const { wf } = run(`return await agent("x")`, { runner })
    const s = await wf.result()
    expect(s.result).toBeNull()
    expect(wf.agents()[0].status).toBe("failed")
    expect(wf.agents()[0].error).toContain("transport error")
  })

  test("agent() with a non-string prompt throws", async () => {
    const { wf, runner } = run(`try { await agent(42) } catch (e) { return "threw" }`)
    expect((await wf.result()).result).toBe("threw")
    expect(runner.calls.length).toBe(0)
  })

  test("P24 label and explicit phase override the current phase", async () => {
    const { wf, runner } = run(`phase("A"); await agent("one", { label: "first" }); await agent("two", { phase: "B" }); await agent("three")`)
    await wf.result()
    const recs = wf.agents()
    expect(recs.map((r) => [r.label, r.phase])).toEqual([
      ["first", "A"],
      [recs[1].label, "B"],
      [recs[2].label, "A"],
    ])
    expect(recs[1].label.length).toBeGreaterThan(0)
    expect(runner.calls.map((c) => c.phase)).toEqual(["A", "B", "A"])
  })

  test("P25 P26 P27 P28 model/effort/agentType/isolation are passed to the runner", async () => {
    const { wf, runner } = run(
      `await agent("x", { model: "openai/gpt-5", effort: "high", agentType: "explore", isolation: "worktree", bogus: 1 })`,
    )
    await wf.result()
    expect(runner.calls[0].opts).toEqual({ model: "openai/gpt-5", effort: "high", agentType: "explore", isolation: "worktree" })
    expect(runner.calls[0].runId).toBe(wf.runId)
    expect(runner.calls[0].index).toBe(0)
  })

  test("runner onUpdate streams sessionID into the record", async () => {
    const { wf } = run(`await agent("x")`)
    await wf.result()
    expect(wf.agents()[0].sessionID).toBe("ses_fake_0")
  })

  test("a running agent's record on disk gets its sessionID as soon as the runner reports it (crash leaves it findable)", async () => {
    const runner = new FakeRunner().on("slow", { hold: true, sessionID: "ses_child_live" })
    const { wf } = run(`await agent("slow")`, { runner })
    await runner.waitForHeld(1)
    let rec: any
    const t0 = Date.now()
    while (Date.now() - t0 < 3000) {
      rec = await store.readAgentRecord(wf.runId, 0)
      if (rec?.sessionID) break
      await sleep(5)
    }
    expect(rec?.status).toBe("running")
    expect(rec?.sessionID).toBe("ses_child_live")
    wf.stop()
    await wf.settled()
  })

  test("agent indices follow start (call) order", async () => {
    const runner = new FakeRunner().on("a", { delayMs: 30 })
    const { wf } = run(`await parallel([() => agent("a"), () => agent("b"), () => agent("c")])`, { runner })
    await wf.result()
    expect(wf.agents().map((r) => [r.index, r.prompt])).toEqual([
      [0, "a"],
      [1, "b"],
      [2, "c"],
    ])
  })
})

describe("phase / log", () => {
  test("P32 phases group agents with counts and tokens; meta.phases order first", async () => {
    const meta: WorkflowMeta = { ...META, phases: [{ title: "Plan" }, { title: "Do" }, { title: "Unused" }] }
    const { wf, events } = run(`phase("Do"); await agent("d1"); await agent("d2"); phase("Plan"); await agent("p1"); phase("Extra"); await agent("e1")`, {
      meta,
    })
    const s = await wf.result()
    expect(s.phases.map(({ title, agents, done, tokens }) => ({ title, agents, done, tokens }))).toEqual([
      { title: "Plan", agents: 1, done: 1, tokens: 110 },
      { title: "Do", agents: 2, done: 2, tokens: 220 },
      { title: "Unused", agents: 0, done: 0, tokens: 0 },
      { title: "Extra", agents: 1, done: 1, tokens: 110 },
    ])
    expect(events.filter((e) => e.type === "phase").map((e) => (e as { title: string }).title)).toEqual(["Do", "Plan", "Extra"])
  })

  test("X10 meta.phases[].model is kept as the phase's display label and never chooses an agent's model", async () => {
    const meta: WorkflowMeta = { ...META, phases: [{ title: "Scan", model: "openai/gpt-5.4" }, { title: "Judge" }] }
    const { wf, runner } = run(`phase("Scan"); await agent("s1"); await agent("s2", { model: "anthropic/x" }); phase("Judge"); await agent("j1"); phase("Extra"); await agent("e1")`, {
      meta,
    })
    const s = await wf.result()
    expect(s.phases.map((p) => [p.title, p.model])).toEqual([
      ["Scan", "openai/gpt-5.4"],
      ["Judge", undefined],
      ["Extra", undefined],
    ])
    // Display only: agents keep the model their own opts give (none for s1).
    expect(runner.calls.map((c) => c.opts.model)).toEqual([undefined, "anthropic/x", undefined, undefined])
  })

  test("X10 a phase counts its running agents while they run", async () => {
    const runner = new FakeRunner().on("slow", { hold: true })
    const meta: WorkflowMeta = { ...META, phases: [{ title: "Scan" }] }
    const { wf } = run(`phase("Scan"); await parallel([() => agent("slow a"), () => agent("slow b"), () => agent("quick")]); return 1`, { meta, runner })
    await runner.waitForHeld(2)
    await sleep(10)
    expect(wf.summary().phases[0]).toMatchObject({ title: "Scan", agents: 3, done: 1, running: 2 })
    runner.release()
    const s = await wf.result()
    expect(s.phases[0]).toMatchObject({ done: 3, running: 0 })
  })

  test("P33 log() lines land in the summary and as events", async () => {
    const { wf, events } = run(`log("hello", 1, { a: 2 }); log("second")`)
    const s = await wf.result()
    expect(s.logs).toEqual(['hello 1 {"a":2}', "second"])
    expect(events.filter((e) => e.type === "log").length).toBe(2)
  })
})

describe("budget", () => {
  test("P34 total null and remaining Infinity without a target", async () => {
    const s = await run(`return [budget.total, budget.remaining() === Infinity, budget.spent()]`).wf.result()
    expect(s.result).toEqual([null, true, 0])
  })

  test("P34 spent counts output+reasoning tokens; remaining = max(0,total-spent)", async () => {
    const runner = new FakeRunner({ usage: { input: 1000, output: 30, reasoning: 20 } })
    const s = await run(`await agent("a"); return [budget.total, budget.spent(), budget.remaining()]`, {
      runner,
      budgetTotal: 120,
    }).wf.result()
    expect(s.result).toEqual([120, 50, 70])
  })

  test("P34 hard ceiling: agent() throws once spent >= total, before starting", async () => {
    const runner = new FakeRunner({ usage: { output: 60 } })
    const { wf } = run(
      `await agent("a"); await agent("b"); try { await agent("c"); return "ran" } catch (e) { return String(e.message || e) }`,
      { runner, budgetTotal: 100 },
    )
    const s = await wf.result()
    expect(String(s.result)).toContain("budget")
    expect(runner.prompts).toEqual(["a", "b"])
    expect(s.agentCount).toBe(2)
  })
})

describe("nested workflow()", () => {
  const child = { meta: { name: "child", description: "c" }, body: `const r = await agent("child " + args.x); log("in child"); return { r, args }` }

  test("P35 runs another workflow inline and returns its result, sharing the agent counter", async () => {
    const { wf, runner } = run(`await agent("parent"); const r = await workflow("child", { x: 1 }); return r`, {
      resolveWorkflow: async (ref) => {
        expect(ref).toBe("child")
        return child
      },
    })
    const s = await wf.result()
    expect(s.status).toBe("completed")
    expect(s.result).toEqual({ r: "done: child 1", args: { x: 1 } })
    expect(runner.calls.map((c) => [c.index, c.prompt])).toEqual([
      [0, "parent"],
      [1, "child 1"],
    ])
    expect(s.agentCount).toBe(2)
    expect(s.logs.some((l) => l.includes("in child"))).toBe(true)
  })

  test("P35 accepts {scriptPath} refs", async () => {
    let seen: unknown
    const s = await run(`return await workflow({ scriptPath: "/x/y.js" }, { x: 2 })`, {
      resolveWorkflow: async (ref) => {
        seen = ref
        return child
      },
    }).wf.result()
    expect(seen).toEqual({ scriptPath: "/x/y.js" })
    expect((s.result as { r: string }).r).toBe("done: child 2")
  })

  test("P35 nested args default to undefined", async () => {
    const s = await run(`return await workflow("c")`, {
      resolveWorkflow: async () => ({ meta: child.meta, body: "return typeof args" }),
    }).wf.result()
    expect(s.result).toBe("undefined")
  })

  test("P35 nesting inside a nested workflow throws", async () => {
    const s = await run(`try { await workflow("c") ; return "no" } catch (e) { return String(e.message || e) }`, {
      resolveWorkflow: async () => ({ meta: child.meta, body: `return await workflow("c")` }),
    }).wf.result()
    expect(String(s.result)).toContain("nested")
  })

  test("P35 unknown name throws", async () => {
    const s = await run(`try { await workflow("nope") } catch (e) { return String(e.message || e) }`, {
      resolveWorkflow: async (ref) => {
        throw new Error(`unknown workflow: ${ref}`)
      },
    }).wf.result()
    expect(String(s.result)).toContain("unknown workflow: nope")
  })

  test("P35 no resolver configured throws", async () => {
    const s = await run(`try { await workflow("x") } catch (e) { return "threw" }`).wf.result()
    expect(s.result).toBe("threw")
  })

  test("P35 child syntax error throws in the parent", async () => {
    const s = await run(`try { await workflow("c") } catch (e) { return String(e.message || e) }`, {
      resolveWorkflow: async () => ({ meta: child.meta, body: "const = 1" }),
    }).wf.result()
    expect(String(s.result)).toContain("SyntaxError")
  })

  test("P35 child runtime error throws in the parent", async () => {
    const s = await run(`try { await workflow("c") } catch (e) { return String(e.message || e) }`, {
      resolveWorkflow: async () => ({ meta: child.meta, body: "throw new Error('child broke')" }),
    }).wf.result()
    expect(String(s.result)).toContain("child broke")
  })

  test("P35 child shares the budget", async () => {
    const runner = new FakeRunner({ usage: { output: 60 } })
    const s = await run(`await agent("p"); return await workflow("c")`, {
      runner,
      budgetTotal: 100,
      resolveWorkflow: async () => ({
        meta: child.meta,
        body: `const before = budget.spent(); await agent("c1"); try { await agent("c2") } catch (e) { return [before, "ceiling"] } return "no"`,
      }),
    }).wf.result()
    expect(s.result).toEqual([60, "ceiling"])
  })

  test("P35 child agents use the child's phases", async () => {
    const { wf } = run(`phase("P"); await workflow("c")`, {
      resolveWorkflow: async () => ({ meta: child.meta, body: `await agent("inherits"); phase("C"); await agent("own")` }),
    })
    await wf.result()
    expect(wf.agents().map((a) => a.phase)).toEqual(["P", "C"])
  })

  test("P35 child shares the concurrency cap", async () => {
    const runner = new FakeRunner({ defaults: { delayMs: 20 } })
    await run(`await parallel([() => agent("a"), () => agent("b"), () => workflow("c")])`, {
      runner,
      maxConcurrent: 2,
      resolveWorkflow: async () => ({ meta: child.meta, body: `await parallel([() => agent("c1"), () => agent("c2")])` }),
    }).wf.result()
    expect(runner.maxRunning).toBe(2)
    expect(runner.calls.length).toBe(4)
  })
})

describe("limits", () => {
  test("P36 defaultMaxConcurrent: min(16, cpus-2) floored at 1; env override 1..256", () => {
    expect(defaultMaxConcurrent({}, 20)).toBe(16)
    expect(defaultMaxConcurrent({}, 8)).toBe(6)
    expect(defaultMaxConcurrent({}, 2)).toBe(1)
    expect(defaultMaxConcurrent({}, 1)).toBe(1)
    expect(defaultMaxConcurrent({ OPENCODE_WORKFLOW_MAX_CONCURRENT_AGENTS: "40" }, 4)).toBe(40)
    expect(defaultMaxConcurrent({ OPENCODE_WORKFLOW_MAX_CONCURRENT_AGENTS: "256" }, 4)).toBe(256)
    expect(defaultMaxConcurrent({ OPENCODE_WORKFLOW_MAX_CONCURRENT_AGENTS: "999" }, 4)).toBe(256)
    expect(defaultMaxConcurrent({ OPENCODE_WORKFLOW_MAX_CONCURRENT_AGENTS: "0" }, 4)).toBe(1)
    expect(defaultMaxConcurrent({ OPENCODE_WORKFLOW_MAX_CONCURRENT_AGENTS: "abc" }, 20)).toBe(16)
    expect(defaultMaxConcurrent({ OPENCODE_WORKFLOW_MAX_CONCURRENT_AGENTS: "" }, 20)).toBe(16)
  })

  test("P36 concurrent agents are capped; excess calls queue", async () => {
    const runner = new FakeRunner({ defaults: { delayMs: 15 } })
    const s = await run(`return (await parallel(Array.from({ length: 10 }, (_, i) => () => agent("t" + i)))).length`, {
      runner,
      maxConcurrent: 3,
    }).wf.result()
    expect(s.result).toBe(10)
    expect(runner.maxRunning).toBe(3)
    expect(runner.calls.length).toBe(10)
  })

  test("P36 queued agents are reported as queued", async () => {
    const runner = new FakeRunner({ defaults: { hold: true } })
    const { wf } = run(`await parallel([() => agent("a"), () => agent("b")])`, { runner, maxConcurrent: 1 })
    await runner.waitForHeld(1)
    await sleep(10)
    expect(wf.agents().map((a) => a.status)).toEqual(["running", "queued"])
    runner.release()
    await runner.waitForHeld(1)
    runner.release()
    expect((await wf.result()).status).toBe("completed")
  })

  test("P37 the agent after maxAgents throws", async () => {
    const { wf, runner } = run(
      `for (let i = 0; i < 3; i++) await agent("a" + i); try { await agent("over") ; return "no" } catch (e) { return String(e.message || e) }`,
      { maxAgents: 3 },
    )
    const s = await wf.result()
    expect(String(s.result)).toContain("3 agents")
    expect(runner.calls.length).toBe(3)
  })

  test("P37 default cap is 1000: the 1001st agent() throws", async () => {
    expect(DEFAULT_MAX_AGENTS).toBe(1000)
    const { wf, runner } = run(
      `const r = await parallel(Array.from({ length: 1000 }, (_, i) => () => agent("a" + i)));
       try { await agent("over"); return "no" } catch (e) { return [r.filter((x) => x !== null).length, String(e.message || e)] }`,
      { maxConcurrent: 64, summaryThrottleMs: 200 },
    )
    const s = await wf.result()
    expect((s.result as [number, string])[0]).toBe(1000)
    expect((s.result as [number, string])[1]).toContain("1000")
    expect(runner.calls.length).toBe(1000)
  }, 60000)

  test("P55 large-workflow warning once more than 25 agents are scheduled", async () => {
    expect(LARGE_WORKFLOW_AGENT_THRESHOLD).toBe(25)
    const a = run(`await parallel(Array.from({ length: 25 }, (_, i) => () => agent("x" + i)))`)
    expect((await a.wf.result()).warnings.some((w) => /large workflow/i.test(w))).toBe(false)
    const b = run(`await parallel(Array.from({ length: 30 }, (_, i) => () => agent("x" + i)))`)
    const s = await b.wf.result()
    expect(s.warnings.filter((w) => /large workflow/i.test(w)).length).toBe(1)
    expect(b.events.filter((e) => e.type === "warning").length).toBe(1)
  })
})

describe("journal and resume", () => {
  test("P40 every finished agent is journaled with index, key, status, value, usage", async () => {
    const runner = new FakeRunner().on("bad", { status: "failed", error: "x" })
    const { wf } = run(`await agent("a", { label: "L", model: "m/x" }); await agent("bad"); return 1`, { runner })
    await wf.result()
    await wf.settled()
    const j = await journal(wf.runId)
    expect(j.length).toBe(2)
    expect(j[0]).toMatchObject({ type: "result", index: 0, key: agentKey("a", { model: "m/x" }), status: "completed", value: "done: a" })
    expect(j[0].usage.output).toBe(10)
    expect(j[1]).toMatchObject({ index: 1, key: agentKey("bad", {}), status: "failed", error: "x" })
    const rec = await store.readAgentRecord(wf.runId, 0)
    expect(rec?.status).toBe("completed")
    expect(rec?.label).toBe("L")
  })

  test("P41 resume replays the unchanged completed prefix from cache and runs the rest live", async () => {
    const first = run(`const a = await agent("A"); const b = await agent("B"); const c = await agent("C"); return [a, b, c]`)
    await first.wf.result()
    await first.wf.settled()
    const state = await loadForResume(store, first.wf.runId)

    const runner = new FakeRunner().on("A", { value: "live A" }).on("B2", { value: "live B2" })
    const second = run(`const a = await agent("A"); const b = await agent("B2"); const c = await agent("C"); return [a, b, c]`, {
      runner,
      resume: state.cursor,
    })
    const s = await second.wf.result()
    expect(s.result).toEqual(["done: A", "live B2", "done: C"])
    expect(runner.prompts).toEqual(["B2", "C"]) // C ran live again although it completed before
    expect(second.wf.agents().map((a) => a.status)).toEqual(["cached", "completed", "completed"])
    await second.wf.settled()
    // the new run's journal contains the cached entry too, so it can itself be resumed
    const j = await journal(second.wf.runId)
    expect(j.map((e) => [e.index, e.status]).sort()).toEqual([
      [0, "completed"],
      [1, "completed"],
      [2, "completed"],
    ])
  })

  test("P41 a failed agent and everything after it re-runs", async () => {
    const r1 = new FakeRunner().on("B", { status: "failed", error: "x" })
    const first = run(`return await parallel([() => agent("A"), () => agent("B"), () => agent("C"), () => agent("D")])`, { runner: r1 })
    await first.wf.result()
    await first.wf.settled()
    const { cursor } = await loadForResume(store, first.wf.runId)
    const r2 = new FakeRunner()
    const second = run(`return await parallel([() => agent("A"), () => agent("B"), () => agent("C"), () => agent("D")])`, { runner: r2, resume: cursor })
    const s = await second.wf.result()
    expect(r2.prompts).toEqual(["B", "C", "D"])
    expect(s.result).toEqual(["done: A", "done: B", "done: C", "done: D"])
  })

  test("P41 P34 cached (replayed) agents cost nothing this turn: they count toward neither budget.spent nor live tokens", async () => {
    const first = run(`await agent("A")`)
    await first.wf.result()
    await first.wf.settled()
    const { cursor } = await loadForResume(store, first.wf.runId)
    const s = await run(`await agent("A"); return budget.spent()`, { resume: cursor, budgetTotal: 1000 }).wf.result()
    expect(s.result).toBe(0)
    expect(s.usage.output).toBe(0)
  })

  test("P41 cached null values replay as null", async () => {
    const r1 = new FakeRunner().on("A", { value: null })
    const first = run(`return await agent("A")`, { runner: r1 })
    await first.wf.result()
    await first.wf.settled()
    const { cursor } = await loadForResume(store, first.wf.runId)
    const r2 = new FakeRunner()
    const s = await run(`return await agent("A")`, { runner: r2, resume: cursor }).wf.result()
    expect(s.result).toBeNull()
    expect(r2.calls.length).toBe(0)
  })

  test("P44 stop() aborts all agents; none is journaled as failed; they re-run on resume", async () => {
    const runner = new FakeRunner().on("slow", { hold: true })
    const { wf } = run(`const a = await agent("fast"); return await parallel([() => agent("slow 1"), () => agent("slow 2")])`, { runner })
    await runner.waitForHeld(2)
    wf.stop()
    const s = await wf.result()
    expect(s.status).toBe("stopped")
    expect(wf.status).toBe("stopped")
    await wf.settled()
    const j = await journal(wf.runId)
    expect(j.filter((e) => e.status === "failed")).toEqual([])
    expect(j.filter((e) => e.status === "stopped").length).toBe(2)
    expect(wf.agents().map((a) => a.status)).toEqual(["completed", "stopped", "stopped"])

    const { cursor } = await loadForResume(store, wf.runId)
    const r2 = new FakeRunner()
    const again = run(`const a = await agent("fast"); return await parallel([() => agent("slow 1"), () => agent("slow 2")])`, { runner: r2, resume: cursor })
    const s2 = await again.wf.result()
    expect(r2.prompts).toEqual(["slow 1", "slow 2"])
    expect(s2.status).toBe("completed")
  })

  test("P44 stop() while agents are queued resolves quickly and does not start them", async () => {
    const runner = new FakeRunner({ defaults: { hold: true } })
    const { wf } = run(`await parallel([() => agent("a"), () => agent("b"), () => agent("c")])`, { runner, maxConcurrent: 1 })
    await runner.waitForHeld(1)
    wf.stop()
    await wf.result()
    await wf.settled()
    expect(runner.calls.length).toBe(1)
    expect(wf.agents().map((a) => a.status)).toEqual(["stopped", "stopped", "stopped"])
  })

  test("P51 stopAgent() stops one agent: resolves null, journaled as failed, run continues", async () => {
    const runner = new FakeRunner().on("victim", { hold: true })
    const { wf } = run(`const r = await parallel([() => agent("victim"), () => agent("other")]); return r`, { runner })
    await runner.waitForHeld(1)
    expect(wf.stopAgent(0)).toBe(true)
    const s = await wf.result()
    expect(s.status).toBe("completed")
    expect(s.result).toEqual([null, "done: other"])
    expect(wf.agents()[0].status).toBe("failed")
    await wf.settled()
    const j = await journal(wf.runId)
    expect(j.find((e) => e.index === 0)?.status).toBe("failed")
    expect(wf.stopAgent(0)).toBe(false) // already finished
    expect(wf.stopAgent(99)).toBe(false)
  })

  test("P51 stopAgent() on a queued agent resolves it to null without starting it", async () => {
    const runner = new FakeRunner().on("first", { hold: true })
    const { wf } = run(`return await parallel([() => agent("first"), () => agent("queued")])`, { runner, maxConcurrent: 1 })
    await runner.waitForHeld(1)
    expect(wf.stopAgent(1)).toBe(true)
    runner.release()
    const s = await wf.result()
    expect(s.result).toEqual(["done: first", null])
    expect(runner.prompts).toEqual(["first"])
    expect(wf.agents()[1].status).toBe("failed")
  })

  test("P43 isRunActive stays true until every agent of a stopped run has exited", async () => {
    const runner = new FakeRunner().on("slow", { hold: true, lingerMs: 150 })
    const { wf } = run(`await agent("slow")`, { runner })
    expect(isRunActive(wf.runId)).toBe(true)
    expect(getActiveRun(wf.runId)).toBe(wf)
    await runner.waitForHeld(1)
    wf.stop()
    await wf.result()
    expect(isRunActive(wf.runId)).toBe(true) // the agent is still exiting
    await wf.settled()
    expect(isRunActive(wf.runId)).toBe(false)
    expect(getActiveRun(wf.runId)).toBeUndefined()
  })

  test("P43 isRunActive is false for unknown runs and after normal completion", async () => {
    expect(isRunActive("wf_unknown")).toBe(false)
    const { wf } = run(`return 1`)
    await wf.result()
    await wf.settled()
    expect(isRunActive(wf.runId)).toBe(false)
  })
})

describe("lifecycle", () => {
  test("pause() stops scheduling new agents; resume() continues", async () => {
    const runner = new FakeRunner().on("first", { hold: true })
    const { wf, events } = run(`await agent("first"); await agent("second"); return "ok"`, { runner })
    await runner.waitForHeld(1)
    expect(wf.pause()).toBe(true)
    expect(wf.status).toBe("paused")
    runner.release()
    await sleep(40)
    expect(runner.prompts).toEqual(["first"])
    expect(wf.agents()[1]?.status).toBe("queued")
    expect(wf.resume()).toBe(true)
    expect(wf.status).toBe("running")
    const s = await wf.result()
    expect(s.result).toBe("ok")
    expect(runner.prompts).toEqual(["first", "second"])
    expect(events.some((e) => e.type === "run_paused")).toBe(true)
    expect(events.some((e) => e.type === "run_resumed")).toBe(true)
  })

  test("stop() on a paused run stops it", async () => {
    const runner = new FakeRunner().on("first", { hold: true })
    const { wf } = run(`await agent("first"); await agent("second")`, { runner })
    await runner.waitForHeld(1)
    wf.pause()
    wf.stop()
    expect((await wf.result()).status).toBe("stopped")
  })

  test("stop() after completion is a no-op", async () => {
    const { wf } = run(`return 1`)
    await wf.result()
    wf.stop()
    expect(wf.status).toBe("completed")
    expect(wf.pause()).toBe(false)
  })

  test("P50 run.json snapshots are written while running, with per-phase counts", async () => {
    const runner = new FakeRunner().on("wait", { hold: true })
    const { wf } = run(`phase("One"); await agent("quick"); await agent("wait")`, { runner })
    await runner.waitForHeld(1)
    await sleep(40)
    const snap = await store.readSummary(wf.runId)
    expect(snap?.status).toBe("running")
    expect(snap?.phases.map(({ title, agents, done, tokens }) => ({ title, agents, done, tokens }))).toEqual([{ title: "One", agents: 2, done: 1, tokens: 110 }])
    expect(snap?.agentCount).toBe(2)
    runner.release()
    await wf.result()
  })

  test("summary usage sums live agent usage", async () => {
    const runner = new FakeRunner({ usage: { input: 5, output: 7, reasoning: 1, cost: 0.5 } })
    const s = await run(`await agent("a"); await agent("b")`, { runner }).wf.result()
    expect(s.usage).toEqual({ input: 10, output: 14, reasoning: 2, cacheRead: 0, cacheWrite: 0, cost: 1 })
  })

  test("summary() returns a live snapshot", async () => {
    const runner = new FakeRunner().on("w", { hold: true })
    const { wf } = run(`await agent("w")`, { runner })
    await runner.waitForHeld(1)
    expect(wf.summary().status).toBe("running")
    expect(wf.summary().agentCount).toBe(1)
    runner.release()
    await wf.result()
    expect(wf.summary().status).toBe("completed")
  })

  test("parentSessionID and now() are used in the summary", async () => {
    let t = 1000
    const s = await run(`await agent("a")`, { parentSessionID: "ses_p", now: () => (t += 10) }).wf.result()
    expect(s.parentSessionID).toBe("ses_p")
    expect(s.startedAt).toBe(1010)
    expect(s.endedAt).toBeGreaterThan(s.startedAt)
  })

  test("a resumed ReplayCursor constructed directly works too", async () => {
    const cursor = new ReplayCursor([
      { type: "result", index: 0, key: agentKey("A"), status: "completed", value: "cached A", usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } },
    ])
    const s = await run(`return await agent("A")`, { resume: cursor }).wf.result()
    expect(s.result).toBe("cached A")
  })
})

describe("edge cases", () => {
  test("P34 usage streamed via onUpdate while running counts toward budget.spent", async () => {
    const runner = new FakeRunner().on("stream", (req) => {
      req.onUpdate?.({ usage: { input: 0, output: 40, reasoning: 2, cacheRead: 0, cacheWrite: 0, cost: 0 } })
      return { hold: true, usage: { output: 50 } }
    })
    const { wf } = run(`const p = agent("stream"); return p`, { runner, budgetTotal: 1000 })
    await runner.waitForHeld(1)
    expect(wf.agents()[0].usage.output).toBe(40)
    runner.release()
    await wf.result()
    expect(wf.agents()[0].usage.output).toBe(50)
  })

  test("P35 nested agents are journaled in the parent run (resumable)", async () => {
    const resolveWorkflow = async () => ({ meta: { name: "c", description: "" }, body: `return await agent("inner")` })
    const first = run(`await agent("outer"); return await workflow("c")`, { resolveWorkflow })
    await first.wf.result()
    await first.wf.settled()
    const { cursor } = await loadForResume(store, first.wf.runId)
    const r2 = new FakeRunner()
    const s = await run(`await agent("outer"); return await workflow("c")`, { resolveWorkflow, resume: cursor, runner: r2 }).wf.result()
    expect(s.result).toBe("done: inner")
    expect(r2.calls.length).toBe(0)
  })

  test("agent() after the run was stopped is rejected (script sees abort)", async () => {
    const runner = new FakeRunner().on("a", { hold: true })
    const { wf } = run(`try { await agent("a") } catch (e) {} await agent("b")`, { runner })
    await runner.waitForHeld(1)
    wf.stop()
    await wf.result()
    await wf.settled()
    expect(runner.prompts).toEqual(["a"])
  })

  test("FakeRunner: release(match) releases only matching holds; ignoreAbort finishes normally", async () => {
    const runner = new FakeRunner().on("h", { hold: true }).on("stubborn", { delayMs: 30, ignoreAbort: true })
    const ac = new AbortController()
    const mk = (index: number, prompt: string) => ({ runId: "r", index, prompt, opts: {}, signal: ac.signal })
    const p1 = runner.run(mk(0, "h1"))
    const p2 = runner.run(mk(1, "h2"))
    await runner.waitForHeld(2)
    expect(runner.release("h1")).toBe(1)
    expect((await p1).status).toBe("completed")
    expect(runner.heldCount).toBe(1)
    const p3 = runner.run(mk(2, "stubborn"))
    ac.abort()
    expect((await p2).status).toBe("stopped")
    expect((await p3).status).toBe("completed")
    expect(runner.maxRunning).toBe(2)
  })

  test("result() summary reflects unawaited agents that settle after the script returns", async () => {
    const runner = new FakeRunner().on("slow", { hold: true, lingerMs: 20 }).on("fast", { delayMs: 5 })
    const { wf } = run(`phase("P"); agent("slow bg"); await agent("fast"); return "ok"`, { runner })
    const s = await wf.result()
    expect(s.status).toBe("completed")
    expect(s.phases[0]).toMatchObject({ title: "P", agents: 2, done: 2 })
    expect(s.usage.output).toBe(20)
    await wf.settled()
    expect((await store.readSummary(wf.runId))?.usage.output).toBe(20)
  })

  test("result() does not wait forever on an agent that ignores the abort (bounded grace)", async () => {
    const runner = new FakeRunner().on("stubborn", { delayMs: 400, ignoreAbort: true })
    const { wf } = run(`agent("stubborn"); return "ok"`, { runner, finishGraceMs: 30 })
    const t0 = Date.now()
    const s = await wf.result()
    expect(Date.now() - t0).toBeLessThan(300)
    expect(s.status).toBe("completed")
    await wf.settled()
  })

  test("settled() retries the final run.json write instead of dropping it silently", async () => {
    let failures = 2
    const orig = store.writeSummary.bind(store)
    store.writeSummary = async (sum) => {
      if (sum.status !== "running" && failures > 0) {
        failures--
        throw Object.assign(new Error("EPERM"), { code: "EPERM" })
      }
      return orig(sum)
    }
    const { wf } = run(`return await agent("a")`)
    await wf.result()
    await wf.settled()
    const onDisk = await store.readSummary(wf.runId)
    expect(onDisk?.status).toBe("completed")
    expect(onDisk?.result).toBe("done: a")
  })
})


// ---- steering (X01–X06) -------------------------------------------------------------------------

describe("steering: WorkflowRun.message", () => {
  const steerable = () =>
    new FakeRunner().on("task", { hold: true, value: (_req, msgs) => (msgs?.length ? `steered: ${msgs.map((m) => m.text).join(" | ")}` : "plain") })
  const user = (text: string) => ({ from: "user" as const, via: "command" as const, text })

  test("X01 a running agent gets the message and its agent() resolves to the steered reply", async () => {
    const runner = steerable()
    const { wf, events } = run(`const a = await agent("task A", { label: "alpha" }); return a`, { runner })
    await runner.waitForHeld(1)
    const [rep] = await wf.message({ kind: "index", index: 0 }, user("focus on auth"))
    expect(rep).toMatchObject({ index: 0, label: "alpha", status: "running", outcome: "sent", messageId: "wm_0_1" })
    runner.release()
    const s = await wf.result()
    expect(s.result).toBe("steered: focus on auth")
    expect(s.steeredAgents).toBe(1)
    await wf.settled()
    const rec = await store.readAgentRecord(wf.runId, 0)
    expect(rec?.messages).toEqual([expect.objectContaining({ id: "wm_0_1", status: "delivered", from: "user", via: "command", text: "focus on auth" })])
    const j = await journal(wf.runId)
    expect(j[0]).toMatchObject({ index: 0, status: "completed", steered: true })
    const msgs = await store.readJournalMessages(wf.runId)
    expect(msgs).toEqual([expect.objectContaining({ type: "message", index: 0, id: "wm_0_1", text: "focus on auth", urgent: false })])
    // the agent event carries the messages (progress views)
    const last = events.filter((e) => e.type === "agent").at(-1) as any
    expect(last.record.messages?.[0]?.status).toBe("delivered")
  })

  test("X04 a queued agent's message is held, then delivered with its first prompt", async () => {
    const runner = steerable()
    const { wf } = run(`const r = await parallel([() => agent("task A"), () => agent("task B")]); return r`, { runner, maxConcurrent: 1 })
    await runner.waitForHeld(1)
    const [rep] = await wf.message({ kind: "index", index: 1 }, user("be brief"))
    expect(rep).toMatchObject({ status: "queued", outcome: "held" })
    expect(wf.agents()[1]!.messages?.[0]?.status).toBe("held")
    runner.release()
    await runner.waitForHeld(1)
    runner.release()
    const s = await wf.result()
    expect(s.result).toEqual(["plain", "steered: be brief"])
    expect(wf.agents()[1]!.messages?.[0]?.status).toBe("delivered")
  })

  test("X02 finished and cached agents refuse with `finished`; a finished run throws", async () => {
    const runner = steerable().on("quick", { value: "q" })
    const { wf } = run(`await agent("quick one"); const b = await agent("task B"); return b`, { runner })
    await runner.waitForHeld(1)
    const [rep] = await wf.message({ kind: "index", index: 0 }, user("too late"))
    expect(rep).toMatchObject({ index: 0, status: "completed", outcome: "refused", reason: "finished" })
    runner.release()
    await wf.result()
    await expect(wf.message({ kind: "all" }, user("x"))).rejects.toThrow(/not running/)
  })

  test("X05 targets: unknown index, ambiguous label, phase (running + queued), all", async () => {
    const runner = steerable()
    const { wf } = run(
      `phase("Research")
       const r = await parallel([() => agent("task A", { label: "dup" }), () => agent("task B", { label: "dup" }), () => agent("task C", { label: "solo", phase: "Judge" })])
       return r`,
      { runner, maxConcurrent: 2 },
    )
    await runner.waitForHeld(2)
    await expect(wf.message({ kind: "index", index: 9 }, user("x"))).rejects.toThrow(/no agent #9/)
    await expect(wf.message({ kind: "label", label: "dup" }, user("x"))).rejects.toThrow(/#0.*#1/)
    await expect(wf.message({ kind: "label", label: "nobody" }, user("x"))).rejects.toThrow(/no agent labeled "nobody"/)
    await expect(wf.message({ kind: "phase", phase: "Nope" }, user("x"))).rejects.toThrow(/Nope/)
    const research = await wf.message({ kind: "phase", phase: "Research" }, user("r"))
    expect(research.map((r) => [r.index, r.outcome])).toEqual([
      [0, "sent"],
      [1, "sent"],
    ])
    const judge = await wf.message({ kind: "label", label: "solo" }, user("j"))
    expect(judge.map((r) => [r.index, r.outcome])).toEqual([[2, "held"]])
    const all = await wf.message({ kind: "all" }, user("a"))
    expect(all.map((r) => r.index)).toEqual([0, 1, 2])
    runner.release()
    await runner.waitForHeld(1)
    runner.release()
    await wf.result()
  })

  test("X06 P41 resume: the steered agent and every later agent run live; earlier ones stay cached", async () => {
    const runner = steerable().on("first", { value: "one" }).on("third", { value: "three" })
    const body = `const a = await agent("first"); const b = await agent("task B"); const c = await agent("third"); return [a, b, c]`
    const { wf } = run(body, { runner })
    await runner.waitForHeld(1)
    await wf.message({ kind: "index", index: 1 }, user("change course"))
    runner.release()
    expect((await wf.result()).result).toEqual(["one", "steered: change course", "three"])
    await wf.settled()

    const loaded = await loadForResume(store, wf.runId)
    expect([...loaded.steered]).toEqual([1])
    const runner2 = new FakeRunner().on("first", { value: "one" }).on("task B", { value: "fresh B" }).on("third", { value: "three" })
    const { wf: wf2 } = run(body, { runner: runner2, resume: loaded.cursor })
    const s2 = await wf2.result()
    expect(s2.result).toEqual(["one", "fresh B", "three"])
    expect(runner2.prompts).toEqual(["task B", "third"]) // agent 0 cached, 1 and 2 live
    expect(wf2.agents().map((a) => a.status)).toEqual(["cached", "completed", "completed"])
  })
})
