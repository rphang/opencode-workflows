// Parity: script API (P20–P37), end to end through the plugin's `workflow` tool. Agent-level
// items that depend on opencode (structured output, model/effort/agent/worktree) run with the REAL
// opencode runner over the fake opencode ctx; the rest use the FakeRunner.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { defaultMaxConcurrent, MAX_CONCURRENT_ENV } from "../../src/engine.ts"
import { MAX_FANOUT_ITEMS } from "../../src/prelude.ts"
import { FakeRunner, sleep } from "../helpers/fake-runner.ts"
import { createHarness, script, tag, type Harness } from "../helpers/plugin-harness.ts"
import { childPrompt } from "../../src/opencode/runner.ts"

let h: Harness
beforeEach(async () => {
  h = await createHarness()
})
afterEach(async () => {
  await h.dispose()
})

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    return await fn()
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

const FILES_SCHEMA = `{ type: "object", required: ["files"], properties: { files: { type: "array", items: { type: "string" } } } }`

describe("P20 agent()", () => {
  test("P20 agent(prompt) without a schema resolves to the subagent's final text", async () => {
    const p = await h.setup({ real: true, fake: { respond: ({ text }) => ({ text: `answer to: ${text}` }) } })
    await p.call({ script: script(`const r = await agent("what is 2+2?"); return { r, type: typeof r }`) })
    expect(p.resultOf(await p.notification(0))).toEqual({ r: `answer to: ${childPrompt("what is 2+2?")}`, type: "string" })
    expect(p.fake.children().length).toBe(1)
  })

  test("P20 each agent() call spawns exactly one subagent (child session)", async () => {
    const p = await h.setup({ real: true })
    await p.call({ script: script(`await agent("a"); await agent("b"); return await agent("c")`) })
    await p.notification(0)
    expect(p.fake.calls.create.length).toBe(3)
  })
})

describe("P21 structured output", () => {
  test("P21 opts.schema resolves to the validated object (submitted through workflow_submit)", async () => {
    const p = await h.setup({ real: true, fake: { respond: () => ({ submit: [{ files: ["a.ts", "b.ts"] }], text: "submitted" }) } })
    await p.call({ script: script(`const r = await agent("list files", { schema: ${FILES_SCHEMA} }); return { r, n: r.files.length }`) })
    expect(p.resultOf(await p.notification(0))).toEqual({ r: { files: ["a.ts", "b.ts"] }, n: 2 })
  })

  test("P21 an invalid submission is retried and the corrected output is returned", async () => {
    const p = await h.setup({
      real: true,
      fake: { respond: ({ turn }) => (turn === 0 ? { submit: [{ files: "nope" }], text: "x" } : { submit: [{ files: ["ok.ts"] }], text: "y" }) },
    })
    await p.call({ script: script(`return await agent("list", { schema: ${FILES_SCHEMA} })`) })
    expect(p.resultOf(await p.notification(0))).toEqual({ files: ["ok.ts"] })
  })

  test("P21 after MAX_STRUCTURED_OUTPUT_RETRIES (default 5) failed attempts agent() THROWS with the last validation failure", async () => {
    await withEnv({ MAX_STRUCTURED_OUTPUT_RETRIES: undefined, OPENCODE_WORKFLOW_MAX_STRUCTURED_OUTPUT_RETRIES: undefined }, async () => {
      const p = await h.setup({ real: true, fake: { respond: () => ({ submit: [{ files: 42 }], text: "bad" }) } })
      await p.call({
        script: script(`try { await agent("list", { schema: ${FILES_SCHEMA} }); return "no throw" } catch (e) { return "threw: " + e.message }`),
      })
      const r = String(p.resultOf(await p.notification(0)))
      expect(r).toMatch(/^threw: structured output failed validation after 5 attempts/)
      expect(r).toMatch(/files/) // the last validation failure names the bad field
      expect(p.fake.calls.prompt.length).toBe(5)
    })
  })

  test("P21 MAX_STRUCTURED_OUTPUT_RETRIES changes the attempt count", async () => {
    await withEnv({ MAX_STRUCTURED_OUTPUT_RETRIES: "2" }, async () => {
      const p = await h.setup({ real: true, fake: { respond: () => ({ submit: [{ files: 42 }], text: "bad" }) } })
      await p.call({ script: script(`try { await agent("list", { schema: ${FILES_SCHEMA} }) } catch (e) { return e.message }`) })
      expect(String(p.resultOf(await p.notification(0)))).toMatch(/after 2 attempts/)
      expect(p.fake.calls.prompt.length).toBe(2)
    })
  })

  test("P21 an uncaught schema failure fails the run", async () => {
    await withEnv({ MAX_STRUCTURED_OUTPUT_RETRIES: "1" }, async () => {
      const p = await h.setup({ real: true, fake: { respond: () => ({ text: "I refuse to call tools" }) } })
      await p.call({ script: script(`return await agent("list", { schema: ${FILES_SCHEMA} })`) })
      const text = String((await p.notification(0)).text)
      expect(tag(text, "status")).toBe("failed")
      expect(text).toMatch(/structured output failed validation/)
    })
  })

  test("P21 DEGRADED fallback: when the agent never calls workflow_submit, valid JSON in its reply is accepted", async () => {
    await withEnv({ MAX_STRUCTURED_OUTPUT_RETRIES: "1" }, async () => {
      const p = await h.setup({ real: true, fake: { respond: () => ({ text: 'Here you go:\n```json\n{"files":["x.ts"]}\n```' }) } })
      await p.call({ script: script(`return await agent("list", { schema: ${FILES_SCHEMA} })`) })
      expect(p.resultOf(await p.notification(0))).toEqual({ files: ["x.ts"] })
    })
  })

  test("P21 workflow_submit is only allowed in children that have a schema", async () => {
    const p = await h.setup({ real: true, fake: { respond: ({ text }) => (text.includes("schema") ? { submit: [{ files: [] }] } : { text: "t" }) } })
    await p.call({ script: script(`await agent("plain"); return await agent("with schema", { schema: ${FILES_SCHEMA} })`) })
    await p.notification(0)
    const submitRule = (i: number) => p.fake.calls.create[i].permissions.find((r: any) => r.action === "workflow_submit")
    expect(submitRule(0).effect).toBe("deny")
    expect(submitRule(1).effect).toBe("allow")
  })
})

describe("P22 schema preflight", () => {
  test("P22 a required key ruled out by additionalProperties:false throws before the subagent starts", async () => {
    const p = await h.setup()
    await p.call({
      script: script(
        `try { await agent("x", { schema: { type: "object", additionalProperties: false, properties: { a: { type: "string" } }, required: ["b"] } }); return "started" } catch (e) { return e.message }`,
      ),
    })
    const r = String(p.resultOf(await p.notification(0)))
    expect(r).toMatch(/schema rejected before the agent started/)
    expect(r).toMatch(/required key "b"/)
    expect(r).toMatch(/additionalProperties/)
    expect(p.runner.calls.length).toBe(0)
  })

  test("P22 a non-object root schema throws before the subagent starts", async () => {
    const p = await h.setup()
    await p.call({ script: script(`try { await agent("x", { schema: { type: "string" } }) } catch (e) { return e.message }`) })
    expect(String(p.resultOf(await p.notification(0)))).toMatch(/schema rejected before the agent started/)
    expect(p.runner.calls.length).toBe(0)
  })

  test("P22 other provable contradictions (min>max, empty enum) are rejected", async () => {
    const p = await h.setup()
    await p.call({
      script: script(`
const out = []
for (const schema of [
  { type: "object", properties: { n: { type: "number", minimum: 5, maximum: 1 } } },
  { type: "object", properties: { e: { enum: [] } } },
]) { try { await agent("x", { schema }); out.push("started") } catch (e) { out.push("rejected") } }
return out`),
    })
    expect(p.resultOf(await p.notification(0))).toEqual(["rejected", "rejected"])
    expect(p.runner.calls.length).toBe(0)
  })

  test("P22 no child session is created for a rejected schema (real runner)", async () => {
    const p = await h.setup({ real: true })
    await p.call({ script: script(`try { await agent("x", { schema: { type: "array" } }) } catch (e) { return "ok" }`) })
    await p.notification(0)
    expect(p.fake.calls.create.length).toBe(0)
  })
})

describe("P23 null results", () => {
  test("P23 agent() resolves to null when the agent dies on a terminal API error", async () => {
    const p = await h.setup({
      real: true,
      fake: { respond: () => ({ outcome: "failed", error: { type: "APIError", message: "overloaded" } }) },
    })
    await p.call({ script: script(`const r = await agent("x"); return r === null ? "null" : r`) })
    const n = await p.notification(0)
    expect(p.resultOf(n)).toBe(null)
    expect(tag(String(n.text), "status")).toBe("completed")
  })

  test("P23 agent() resolves to null when the agent is stopped mid-run", async () => {
    const p = await h.setup({ real: true, fake: { respond: ({ text }) => (text.includes("long") ? { hang: true } : { text: "fine" }) } })
    const out = await p.call({ script: script(`const r = await agent("long job"); const s = await agent("after"); return [r, s]`) })
    await waitUntil(() => p.fake.calls.prompt.length === 1)
    await sleep(20)
    expect(await p.control({ action: "stop_agent", runId: out.runId, agentIndex: 0 })).toMatch(/stopped agent 0/i)
    expect(p.resultOf(await p.notification(0))).toEqual([null, "fine"])
    expect(p.fake.calls.interrupt.length).toBe(1)
  })

  test("P23 FakeRunner: failed and stopped outcomes both map to null, the script keeps going", async () => {
    const runner = new FakeRunner().on("f", { status: "failed", error: "api down" }).on("s", { status: "stopped" })
    const p = await h.setup({ runner })
    await p.call({ script: script(`return [await agent("f"), await agent("s"), await agent("ok")]`) })
    expect(p.resultOf(await p.notification(0))).toEqual([null, null, "done: ok"])
  })
})

async function waitUntil(cond: () => boolean, ms = 5000) {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout")
    await sleep(5)
  }
}

describe("P24 label and phase", () => {
  test("P24 opts.label sets the display label; opts.phase overrides the current phase()", async () => {
    const runner = new FakeRunner().on("slow", { hold: true })
    const p = await h.setup({ runner })
    const out = await p.call({
      script: script(
        `phase("Scan")\nawait agent("a", { label: "custom-label" })\nawait agent("b", { phase: "Verify" })\nreturn await agent("slow")`,
        `{ name: "lab", description: "d", phases: [{ title: "Scan" }, { title: "Verify" }] }`,
      ),
    })
    await runner.waitForHeld(1)
    expect(runner.calls[0]!.phase).toBe("Scan")
    expect(runner.calls[1]!.phase).toBe("Verify")
    expect(runner.calls[2]!.phase).toBe("Scan")
    const status = await p.control({ action: "status", runId: out.runId })
    expect(status).toContain("custom-label")
    runner.release()
    await p.notification(0)
    await p.settled(out.runId!)
    const s = await h.store.readSummary(out.runId!)
    expect(s!.phases.map((x) => [x.title, x.agents])).toEqual([
      ["Scan", 2],
      ["Verify", 1],
    ])
  })

  test("P24 the label reaches the child session title (real runner)", async () => {
    const p = await h.setup({ real: true })
    await p.call({ script: script(`return await agent("do it", { label: "src/a.ts" })`) })
    await p.notification(0)
    expect(p.fake.calls.create[0].title).toMatch(/\] src\/a\.ts$/)
  })
})

describe("P25 model", () => {
  test("P25 default model is the parent session's model", async () => {
    const p = await h.setup({ real: true })
    await p.call({ script: script(`return await agent("x")`) })
    await p.notification(0)
    expect(p.fake.calls.create[0].model).toMatchObject({ providerID: "openai", id: "gpt-5.4-mini" })
  })

  test("P25 opts.model overrides it with a provider/model ref", async () => {
    const p = await h.setup({ real: true })
    await p.call({ script: script(`return await agent("x", { model: "anthropic/claude-haiku-4-5" })`) })
    await p.notification(0)
    expect(p.fake.calls.create[0].model).toMatchObject({ providerID: "anthropic", id: "claude-haiku-4-5" })
  })
})

describe("P26 effort", () => {
  test("P26 opts.effort maps to a model variant when the model supports it", async () => {
    const p = await h.setup({ real: true })
    await p.call({ script: script(`return await agent("x", { effort: "high" })`) })
    await p.notification(0)
    expect(p.fake.calls.create[0].model).toMatchObject({ providerID: "openai", id: "gpt-5.4-mini", variant: "high" })
  })

  test("P26 DEGRADED: effort on a model without variants is ignored with a warning shown in the status view", async () => {
    const p = await h.setup({ real: true })
    const out = await p.call({ script: script(`return await agent("x", { model: "anthropic/claude-haiku-4", effort: "high" })`) })
    const n = await p.notification(0)
    expect(tag(String(n.text), "status")).toBe("completed")
    expect(p.fake.calls.create[0].model?.variant).toBeUndefined()
    await p.settled(out.runId!)
    const rec = await h.store.readAgentRecord(out.runId!, 0)
    expect(rec?.warnings?.join("\n")).toMatch(/effort/)
    expect(await p.control({ action: "status", runId: out.runId })).toMatch(/effort/)
  })

  test("P26 an effort outside the enum throws", async () => {
    const p = await h.setup()
    await p.call({ script: script(`try { await agent("x", { effort: "turbo" }) } catch (e) { return e.message }`) })
    expect(String(p.resultOf(await p.notification(0)))).toMatch(/effort must be one of low, medium, high, xhigh, max/)
  })
})

describe("P27 agentType", () => {
  test("P27 opts.agentType selects the opencode agent of the child session", async () => {
    const p = await h.setup({ real: true })
    await p.call({ script: script(`return await agent("x", { agentType: "explore" })`) })
    await p.notification(0)
    expect(p.fake.calls.create[0].agent).toBe("explore")
    expect(p.fake.children()[0]!.info.agent).toBe("explore")
  })
})

describe("P28 worktree isolation", () => {
  test("P28 isolation:'worktree' runs the agent in a fresh worktree, removed when unchanged", async () => {
    const p = await h.setup({ real: true })
    const out = await p.call({ script: script(`return await agent("look only", { isolation: "worktree" })`) })
    await p.notification(0)
    expect(p.fake.calls.worktreeCreate.length).toBe(1)
    expect(p.fake.calls.worktreeCreate[0].name).toBe(`wf-${out.runId}-0`)
    const wt = p.fake.calls.create[0].location?.directory
    expect(wt).toContain(`wf-${out.runId}-0`)
    expect(p.fake.calls.worktreeRemove.length).toBe(1)
    expect(p.fake.calls.worktreeRemove[0].directory).toBe(wt)
  })

  test("P28 a worktree with changes is kept and reported in the status view", async () => {
    const p = await h.setup({ real: true, fake: { respond: () => ({ text: "edited", writeFile: true }) } })
    const out = await p.call({ script: script(`return await agent("edit a file", { isolation: "worktree" })`) })
    await p.notification(0)
    expect(p.fake.calls.worktreeRemove.length).toBe(0)
    await p.settled(out.runId!)
    const rec = await h.store.readAgentRecord(out.runId!, 0)
    expect(rec?.worktree).toContain(`wf-${out.runId}-0`)
    expect(await p.control({ action: "status", runId: out.runId })).toContain(`wf-${out.runId}-0`)
  })

  test("P28 agents without isolation run in the project directory (no worktree)", async () => {
    const p = await h.setup({ real: true })
    await p.call({ script: script(`return await agent("x")`) })
    await p.notification(0)
    expect(p.fake.calls.worktreeCreate.length).toBe(0)
    expect(p.fake.calls.create[0].location).toBeUndefined()
  })
})

describe("P29 parallel", () => {
  test("P29 runs thunks concurrently and is a barrier", async () => {
    const runner = new FakeRunner({ defaults: { delayMs: 80 } })
    const p = await h.setup({ runner })
    await p.call({
      script: script(`const r = await parallel([() => agent("a"), () => agent("b"), () => agent("c"), () => agent("d")]); return r`),
    })
    expect(p.resultOf(await p.notification(0))).toEqual(["done: a", "done: b", "done: c", "done: d"])
    expect(runner.maxRunning).toBe(4)
  })

  test("P29 a throwing thunk resolves to null and parallel never rejects", async () => {
    const p = await h.setup()
    await p.call({
      script: script(`
const r = await parallel([
  () => agent("ok"),
  () => { throw new Error("sync boom") },
  async () => { await agent("x"); throw new Error("async boom") },
  () => agent("schema", { schema: { type: "array" } }),
])
return r`),
    })
    expect(p.resultOf(await p.notification(0))).toEqual(["done: ok", null, null, null])
  })

  test("P29 the barrier waits for the slowest thunk before continuing", async () => {
    const runner = new FakeRunner().on("slow", { delayMs: 150 })
    const p = await h.setup({ runner })
    await p.call({ script: script(`await parallel([() => agent("slow"), () => agent("fast")]); return await agent("after")`) })
    await p.notification(0)
    expect(runner.finished.map((f) => f.prompt)).toEqual(["fast", "slow", "after"])
  })
})

describe("P30 pipeline", () => {
  test("P30 no barrier between stages: a fast item enters stage 2 before a slow item leaves stage 1", async () => {
    const runner = new FakeRunner().on("s1 slow", { delayMs: 200 }).on("s1 fast", { delayMs: 5 })
    const p = await h.setup({ runner })
    await p.call({
      script: script(`return await pipeline(["slow", "fast"], (item) => agent("s1 " + item), (prev, item) => agent("s2 " + item))`),
    })
    expect(p.resultOf(await p.notification(0))).toEqual(["done: s2 slow", "done: s2 fast"])
    const order = runner.calls.map((c) => c.prompt)
    expect(order.indexOf("s2 fast")).toBeLessThan(order.indexOf("s2 slow"))
    const s2fastStart = order.indexOf("s2 fast")
    const s1slowDone = runner.finished.findIndex((f) => f.prompt === "s1 slow")
    // s2 fast started while s1 slow was still running
    expect(runner.finished.slice(0, s1slowDone).map((f) => f.prompt)).toContain("s1 fast")
    expect(s2fastStart).toBeGreaterThan(-1)
  })

  test("P30 each stage gets (prevResult, originalItem, index)", async () => {
    const p = await h.setup()
    await p.call({
      script: script(`return await pipeline(["a", "b"], (prev, item, i) => prev + "|" + item + "|" + i, (prev, item, i) => prev + "/" + item + "/" + i)`),
    })
    expect(p.resultOf(await p.notification(0))).toEqual(["a|a|0/a/0", "b|b|1/b/1"])
  })

  test("P30 a throwing stage drops that item to null and skips its remaining stages", async () => {
    const p = await h.setup()
    await p.call({
      script: script(`
return await pipeline([1, 2, 3],
  (n) => { if (n === 2) throw new Error("bad item"); return agent("s1 " + n) },
  (prev, n) => agent("s2 " + n))`),
    })
    expect(p.resultOf(await p.notification(0))).toEqual(["done: s2 1", null, "done: s2 3"])
    expect(p.runner.prompts).not.toContain("s2 2")
  })

  test("P30 result order is item order regardless of completion order", async () => {
    const runner = new FakeRunner().on("i0", { delayMs: 120 }).on("i1", { delayMs: 60 }).on("i2", { delayMs: 1 })
    const p = await h.setup({ runner })
    await p.call({ script: script(`return await pipeline(["i0", "i1", "i2"], (x) => agent(x))`) })
    expect(p.resultOf(await p.notification(0))).toEqual(["done: i0", "done: i1", "done: i2"])
    expect(runner.finished.map((f) => f.prompt)).toEqual(["i2", "i1", "i0"])
  })
})

describe("P31 fan-out limit", () => {
  test("P31 parallel() rejects more than 4096 items with an explicit error (no silent truncation)", async () => {
    expect(MAX_FANOUT_ITEMS).toBe(4096)
    const p = await h.setup()
    await p.call({
      script: script(`
const ok = await parallel(Array.from({ length: 4096 }, (_, i) => i))
try { await parallel(Array.from({ length: 4097 }, (_, i) => i)); return "accepted" } catch (e) { return ok.length + " " + e.message }`),
    })
    const r = String(p.resultOf(await p.notification(0)))
    expect(r).toMatch(/^4096 /)
    expect(r).toMatch(/4096/)
    expect(p.runner.calls.length).toBe(0)
  })

  test("P31 pipeline() rejects more than 4096 items with an explicit error", async () => {
    const p = await h.setup()
    await p.call({
      script: script(`try { await pipeline(Array.from({ length: 5000 }, (_, i) => i), (x) => agent("x" + x)); return "accepted" } catch (e) { return e.message }`),
    })
    expect(String(p.resultOf(await p.notification(0)))).toMatch(/4096/)
    expect(p.runner.calls.length).toBe(0)
  })
})

describe("P32 phase()", () => {
  test("P32 phase(title) groups subsequent agents under it in the progress view", async () => {
    const p = await h.setup()
    const out = await p.call({
      script: script(`phase("One"); await agent("a"); await agent("b"); phase("Two"); await agent("c"); return 1`),
    })
    await p.notification(0)
    await p.settled(out.runId!)
    const s = await h.store.readSummary(out.runId!)
    expect(s!.phases.map((x) => ({ title: x.title, agents: x.agents, done: x.done }))).toEqual([
      { title: "One", agents: 2, done: 2 },
      { title: "Two", agents: 1, done: 1 },
    ])
    const status = await p.control({ action: "status", runId: out.runId })
    expect(status).toMatch(/One/)
    expect(status).toMatch(/Two/)
  })

  test("P32 a phase() title missing from meta.phases gets a group of its own (with a warning)", async () => {
    const p = await h.setup()
    const out = await p.call({
      script: script(`phase("Extra"); await agent("a"); return 1`, `{ name: "ph", description: "d", phases: [{ title: "Plan" }] }`),
    })
    expect(out.warning).toMatch(/Extra/)
    await p.notification(0)
    await p.settled(out.runId!)
    const s = await h.store.readSummary(out.runId!)
    expect(s!.phases.map((x) => [x.title, x.agents])).toEqual([
      ["Plan", 0],
      ["Extra", 1],
    ])
  })
})

describe("P33 log()", () => {
  test("P33 log(message) emits a narrator line shown in the progress view", async () => {
    const p = await h.setup()
    const out = await p.call({ script: script(`log("starting scan"); log("found", 3, { files: 2 }); return 1`) })
    await p.notification(0)
    await p.settled(out.runId!)
    const s = await h.store.readSummary(out.runId!)
    expect(s!.logs).toEqual(["starting scan", `found 3 {"files":2}`])
    expect(await p.control({ action: "status", runId: out.runId })).toContain("starting scan")
  })
})

describe("P34 budget", () => {
  test("P34 the model-facing budget input says to set it only when the user states a token budget", async () => {
    const { WORKFLOW_INPUT_SCHEMA } = await import("../../src/plugin/tools.ts")
    const { AUTHORING_REFERENCE } = await import("../../src/authoring.ts")
    const d = WORKFLOW_INPUT_SCHEMA.properties.budget.description
    expect(d).toMatch(/only when the user/i)
    expect(d).toMatch(/never invent/i)
    expect(AUTHORING_REFERENCE).toMatch(/only when the user explicitly/i)
  })

  test("P34 without a target: total is null and remaining() is Infinity", async () => {
    const p = await h.setup()
    await p.call({ script: script(`await agent("a"); return [budget.total, String(budget.remaining()), budget.spent()]`) })
    expect(p.resultOf(await p.notification(0))).toEqual([null, "Infinity", 10])
  })

  test("P34 with a target: remaining() = max(0, total - spent()) and agent() throws once spent() >= total", async () => {
    const p = await h.setup()
    await p.call({
      budget: 25,
      script: script(`
const seen = []
for (let i = 0; i < 5; i++) {
  try { await agent("a" + i); seen.push(budget.remaining()) } catch (e) { seen.push(e.message); break }
}
return { seen, spent: budget.spent(), total: budget.total }`),
    })
    const r = p.resultOf(await p.notification(0)) as any
    expect(r.total).toBe(25)
    expect(r.spent).toBe(30)
    expect(r.seen.slice(0, 3)).toEqual([15, 5, 0])
    expect(r.seen[3]).toMatch(/budget exhausted: 30 of 25 tokens spent/)
    expect(p.runner.calls.length).toBe(3)
  })

  test("P34 agents replayed from the journal on resume cost nothing this turn and do not count toward spent()", async () => {
    const p = await h.setup()
    const src = script(`await agent("a"); await agent("b"); const before = budget.spent(); await agent("c" + (args || "")); return { before, after: budget.spent() }`)
    const first = await p.call({ script: src })
    expect(p.resultOf(await p.notification(0))).toEqual({ before: 20, after: 30 })
    await p.settled(first.runId!)
    // a and b replay from the journal (cached: 0 tokens this turn); only "cx" runs live.
    await p.call({ script: src, args: "x", resumeFromRunId: first.runId, budget: 15 })
    expect(p.resultOf(await p.notification(1))).toEqual({ before: 0, after: 10 })
    expect(p.runner.calls.map((c) => c.prompt)).toEqual(["a", "b", "c", "cx"])
  })

  test("P34 DEGRADED: the budget is per run; runs launched in the same turn do not share one pool", async () => {
    const p = await h.setup()
    const src = script(`let n = 0\nfor (let i = 0; i < 5; i++) { try { await agent("a" + i); n++ } catch (e) { break } }\nreturn n`)
    await p.call({ script: src, budget: 25 })
    await p.call({ script: src, budget: 25 })
    // Claude Code: one per-turn pool shared by the main loop and every workflow. Here each run has its own.
    expect([p.resultOf(await p.notification(0)), p.resultOf(await p.notification(1))]).toEqual([3, 3])
  })
})

describe("P35 workflow()", () => {
  function saveWf(file: string, body: string, meta: string) {
    const dir = join(h.projectDir, ".opencode", "workflows")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, file), script(body, meta))
  }

  test("P35 workflow(name, args) runs a saved workflow inline and returns its result", async () => {
    saveWf("inner.js", `return "inner:" + args.x + ":" + await agent("inner agent")`, `{ name: "inner", description: "i" }`)
    const p = await h.setup()
    await p.call({ script: script(`return await workflow("inner", { x: 7 })`) })
    expect(p.resultOf(await p.notification(0))).toBe("inner:7:done: inner agent")
  })

  test("P35 workflow({scriptPath}) runs a script file inline", async () => {
    const file = join(h.projectDir, "child.js")
    writeFileSync(file, script(`return typeof args`, `{ name: "child", description: "c" }`))
    const p = await h.setup()
    await p.call({ script: script(`return await workflow({ scriptPath: ${JSON.stringify(file)} })`) })
    expect(p.resultOf(await p.notification(0))).toBe("undefined")
  })

  test("P35 shares the agent counter (indices continue), budget and concurrency", async () => {
    saveWf("inner.js", `await agent("in1"); await agent("in2"); return budget.total`, `{ name: "inner", description: "i" }`)
    const p = await h.setup()
    const out = await p.call({ budget: 1000, script: script(`await agent("out1"); const t = await workflow("inner"); await agent("out2"); return t`) })
    expect(p.resultOf(await p.notification(0))).toBe(1000)
    expect(p.runner.calls.map((c) => [c.index, c.prompt])).toEqual([
      [0, "out1"],
      [1, "in1"],
      [2, "in2"],
      [3, "out2"],
    ])
    await p.settled(out.runId!)
    expect((await h.store.readSummary(out.runId!))!.agentCount).toBe(4)
  })

  test("P35 args reach the child verbatim: workflow(name, null) → null, workflow(name) → undefined", async () => {
    saveWf("c.js", `return args === null ? "null" : typeof args`, `{ name: "c", description: "c" }`)
    const p = await h.setup()
    await p.call({ script: script(`return [await workflow("c", null), await workflow("c"), await workflow("c", undefined), await workflow("c", 0)]`) })
    expect(p.resultOf(await p.notification(0))).toEqual(["null", "undefined", "undefined", "number"])
  })

  test("P35 nesting is one level only: workflow() inside a child throws", async () => {
    saveWf("leaf.js", `return "leaf"`, `{ name: "leaf", description: "l" }`)
    saveWf("mid.js", `try { return await workflow("leaf") } catch (e) { return "child threw: " + e.message }`, `{ name: "mid", description: "m" }`)
    const p = await h.setup()
    await p.call({ script: script(`return await workflow("mid")`) })
    expect(String(p.resultOf(await p.notification(0)))).toMatch(/child threw: .*cannot be nested/)
  })

  test("P35 throws on an unknown name", async () => {
    const p = await h.setup()
    await p.call({ script: script(`try { await workflow("ghost") } catch (e) { return e.message }`) })
    expect(String(p.resultOf(await p.notification(0)))).toMatch(/unknown workflow "ghost"/)
  })

  test("P35 throws on a child syntax error", async () => {
    const file = join(h.projectDir, "broken.js")
    writeFileSync(file, script(`return (`, `{ name: "broken", description: "b" }`))
    const p = await h.setup()
    await p.call({ script: script(`try { await workflow({ scriptPath: ${JSON.stringify(file)} }) } catch (e) { return e.message }`) })
    expect(String(p.resultOf(await p.notification(0)))).toMatch(/SyntaxError/)
  })

  test("P35 shares the abort signal: stopping the run stops the child's agents", async () => {
    saveWf("inner.js", `return await agent("held inner")`, `{ name: "inner", description: "i" }`)
    const runner = new FakeRunner().on("held", { hold: true })
    const p = await h.setup({ runner })
    const out = await p.call({ script: script(`return await workflow("inner")`) })
    await runner.waitForHeld(1)
    await p.control({ action: "stop", runId: out.runId })
    expect(tag(String((await p.notification(0)).text), "status")).toBe("stopped")
    expect(runner.finished[0]!.status).toBe("stopped")
  })
})

describe("P36 concurrency cap", () => {
  test("P36 default cap is min(16, cpus-2), at least 1", () => {
    expect(defaultMaxConcurrent({}, 64)).toBe(16)
    expect(defaultMaxConcurrent({}, 8)).toBe(6)
    expect(defaultMaxConcurrent({}, 2)).toBe(1)
    expect(defaultMaxConcurrent({}, 1)).toBe(1)
  })

  test("P36 OPENCODE_WORKFLOW_MAX_CONCURRENT_AGENTS overrides it, clamped to 1..256", () => {
    expect(defaultMaxConcurrent({ [MAX_CONCURRENT_ENV]: "3" }, 64)).toBe(3)
    expect(defaultMaxConcurrent({ [MAX_CONCURRENT_ENV]: "0" }, 64)).toBe(1)
    expect(defaultMaxConcurrent({ [MAX_CONCURRENT_ENV]: "999" }, 64)).toBe(256)
    expect(defaultMaxConcurrent({ [MAX_CONCURRENT_ENV]: "40" }, 4)).toBe(40)
  })

  test("P36 excess agent() calls queue until a slot frees (end to end)", async () => {
    await withEnv({ [MAX_CONCURRENT_ENV]: "2" }, async () => {
      const runner = new FakeRunner({ defaults: { delayMs: 30 } })
      const p = await h.setup({ runner })
      await p.call({ script: script(`return (await parallel(Array.from({ length: 6 }, (_, i) => () => agent("a" + i)))).length`) })
      expect(p.resultOf(await p.notification(0))).toBe(6)
      expect(runner.maxRunning).toBe(2)
      expect(runner.calls.length).toBe(6)
    })
  })
})

describe("P37 agent cap", () => {
  test("P37 a run can start 1000 agents; the 1001st agent() throws", async () => {
    await withEnv({ [MAX_CONCURRENT_ENV]: "64" }, async () => {
      const p = await h.setup()
      await p.call({
        script: script(`
const r = await parallel(Array.from({ length: 1000 }, (_, i) => () => agent("a" + i)))
try { await agent("one too many"); return "no throw" } catch (e) { return r.filter(Boolean).length + " | " + e.message }`),
      })
      const r = String(p.resultOf(await p.notification(0, 60000)))
      expect(r).toBe("1000 | agent limit reached: a workflow run can start at most 1000 agents")
      expect(p.runner.calls.length).toBe(1000)
    })
  }, 90000)
})
