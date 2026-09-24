// Extension X21: workflow_control {action:"result"} shows the parent model what each agent of a
// FINISHED run returned: a list (failed agents first) or one agent's full return value. While the
// run is going it only repeats the status note (P77), so it gives a polling model nothing new. The
// notification points at it (P79) and summarizes the agents that returned nothing (X20).

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { AUTHORING_REFERENCE, TOOL_DESCRIPTION } from "../../src/authoring.ts"
import { awaitNotificationNote } from "../../src/plugin/format.ts"
import { CONTROL_INPUT_SCHEMA, CONTROL_TOOL_DESCRIPTION } from "../../src/plugin/tools.ts"
import { FakeRunner } from "../helpers/fake-runner.ts"
import { createHarness, script, type Harness } from "../helpers/plugin-harness.ts"

let h: Harness
beforeEach(async () => {
  h = await createHarness()
})
afterEach(async () => {
  await h.dispose()
})

const SECRET = "AGENT-OUTPUT-7731"

type Plugged = Awaited<ReturnType<Harness["setup"]>>

/** Launches and waits for the notification and for the run to settle. */
async function finished(p: Plugged, input: any, i = 0) {
  const out = await p.call(input)
  expect(out.error).toBeUndefined()
  const n = await p.notification(i)
  await p.settled(out.runId!)
  return { out, n, text: String(n.text) }
}

describe("X21 workflow_control result: when it answers", () => {
  test("X21 P77 on a running or paused run it returns the status note byte for byte: no output, no mention of result", async () => {
    const runner = new FakeRunner().on("slow", { hold: true, value: SECRET })
    const p = await h.setup({ runner })
    const out = await p.call({ script: script(`return await agent("slow")`) })
    await runner.waitForCalls(1)
    const running = await p.control({ action: "result", runId: out.runId, agent: "0" })
    expect(running).toBe(awaitNotificationNote({ status: "running", transcriptDir: out.transcriptDir! }))
    expect(running).not.toContain(SECRET)
    expect(running).not.toMatch(/"result"|result action/)
    // The same text status ends with (status also shows progress).
    const status = await p.control({ action: "status", runId: out.runId })
    expect(status).toContain(running)

    await p.control({ action: "pause", runId: out.runId })
    const paused = await p.control({ action: "result", runId: out.runId })
    expect(paused).toBe(awaitNotificationNote({ status: "paused", transcriptDir: out.transcriptDir! }))
    await p.control({ action: "resume", runId: out.runId })
    runner.release()
    await p.notification(0)
  })

  test("X21 on a finished run it answers at once, before any notification is delivered, and from disk after a plugin reload", async () => {
    const runner = new FakeRunner().on("x", { value: SECRET })
    const p = await h.setup({ runner })
    const release = p.holdNotifications()
    const out = await p.call({ script: script(`return await agent("x", { label: "only" })`) })
    await p.settled(out.runId!)
    expect(p.synthetic.filter((s: any) => String(s.text).includes("<task-notification>"))).toHaveLength(0)
    expect(await p.control({ action: "result", runId: out.runId, agent: "0" })).toContain(SECRET)
    expect(await p.control({ action: "result", runId: out.runId })).toMatch(/#0 "only" completed/)
    release()
    await p.notification(0)
    await p.cleanup?.()
    const q = await h.setup()
    expect(await q.control({ action: "result", runId: out.runId, agent: "only" })).toContain(SECRET)
  })

  test("X21 P75 another session's run answers not found", async () => {
    const p = await h.setup()
    const { out } = await finished(p, { script: script(`return await agent("x")`) })
    expect(await p.control({ action: "result", runId: out.runId }, "ses_other")).toMatch(/not found in this session/)
  })
})

describe("X21 workflow_control result: the list", () => {
  test("X21 header with counts; failed, stopped and null rows first, then the rest by index; one line each", async () => {
    const long = "L".repeat(300) + "-END"
    const runner = new FakeRunner()
      .on("alpha", { value: `first line\nsecond line ${SECRET}` })
      .on("beta", { status: "failed", error: "rate limited by provider\nstack trace line" })
      .on("gamma", { value: { verdict: "ok", notes: long } })
      .on("delta", { value: null })
    const p = await h.setup({ runner })
    const { out } = await finished(p, {
      script: script(
        `phase("Scan"); return await parallel([() => agent("alpha task", { label: "A" }), () => agent("beta task", { label: "B" }), ` +
          `() => agent("gamma task", { label: "C" }), () => agent("delta task", { label: "D" })])`,
      ),
    })
    const list = await p.control({ action: "result", runId: out.runId })
    const lines = list.split("\n")
    expect(lines[0]).toBe(`Run ${out.runId} completed: 4 agents: 2 completed, 0 cached, 1 failed, 0 stopped, 1 null`)
    const rows = lines.filter((l) => l.startsWith("#"))
    expect(rows.map((r) => r.slice(0, 2))).toEqual(["#1", "#3", "#0", "#2"])
    expect(rows[0]).toMatch(/^#1 "B" failed \[Scan\] \S+ tokens error: rate limited by provider$/)
    expect(rows[1]).toMatch(/^#3 "D" completed \[Scan\] \S+ tokens → null$/)
    expect(rows[2]).toMatch(/^#0 "A" completed \[Scan\] \S+ tokens → first line$/)
    expect(rows[3]).toMatch(/^#2 "C" completed \[Scan\] \S+ tokens → \{/)
    expect(list).not.toContain("stack trace line")
    expect(list).not.toContain(SECRET) // previews are the first line only
    expect(list).not.toContain("-END") // and clipped
    expect(list).toContain(`agent:"<index or label>"`)
    expect(list).not.toMatch(/Rows \d/) // one page
  })

  test("X21 agent omitted, empty or blank lists; fields a model fills out of habit (agentIndex, label, status, limit, maxChars) are ignored", async () => {
    const runner = new FakeRunner().on("bad", { status: "failed", error: "boom" })
    const p = await h.setup({ runner })
    const { out } = await finished(p, { script: script(`return [await agent("ok", { label: "x" }), await agent("bad", { label: "y" })]`) })
    const list = await p.control({ action: "result", runId: out.runId })
    expect(await p.control({ action: "result", runId: out.runId, agent: "" })).toBe(list)
    expect(await p.control({ action: "result", runId: out.runId, agent: "   " })).toBe(list)
    // A model-filled status:"completed" must not hide the failed agent.
    const filled = await p.control({ action: "result", runId: out.runId, agent: "", agentIndex: 0, label: "x", status: "completed", limit: 1, maxChars: 5 })
    expect(filled).toBe(list)
    expect(filled).toContain(`#1 "y" failed`)
  })

  test("X21 paging: 50 rows per page, failed first, with the exact next call", async () => {
    const runner = new FakeRunner().on(/^f/, { status: "failed", error: "boom " + "x".repeat(500) })
    const p = await h.setup({ runner })
    const { out } = await finished(p, {
      script: script(`return (await parallel(Array.from({ length: 1000 }, (_, i) => () => agent((i % 4 === 0 ? "f" : "ok") + i)))).length`),
    })
    const first = await p.control({ action: "result", runId: out.runId })
    expect(first.split("\n")[0]).toBe(`Run ${out.runId} completed: 1000 agents: 750 completed, 0 cached, 250 failed, 0 stopped, 0 null`)
    const rows = first.split("\n").filter((l) => l.startsWith("#"))
    expect(rows).toHaveLength(50)
    expect(rows[0]).toMatch(/^#0 "[^"]*" failed/)
    expect(rows[49]).toMatch(/^#196 "[^"]*" failed/)
    expect(first).toContain(`Rows 1–50 of 1000. Next: {action:"result", runId:"${out.runId}", offset:50}`)
    expect(first.length).toBeLessThan(15_000)
    // Past the 250 failed rows come the completed ones, by index.
    const later = await p.control({ action: "result", runId: out.runId, offset: 250 })
    expect(later.split("\n").filter((l) => l.startsWith("#"))[0]).toMatch(/^#1 "[^"]*" completed/)
    expect(later).toContain(`Rows 251–300 of 1000. Next: {action:"result", runId:"${out.runId}", offset:300}`)
    const last = await p.control({ action: "result", runId: out.runId, offset: 980 })
    expect(last).toContain("Rows 981–1000 of 1000.")
    expect(last).not.toMatch(/Next:/)
  }, 60_000)
})

describe("X21 workflow_control result: one agent", () => {
  test('X21 agent selects by index ("2" or "#2") or exact label; ambiguous labels list the candidates; an unknown agent is an error with the agent count', async () => {
    const p = await h.setup()
    const { out } = await finished(p, {
      script: script(`return [await agent("p1", { label: "dup" }), await agent("p2", { label: "dup" }), await agent("p3", { label: "solo" })]`),
    })
    expect(await p.control({ action: "result", runId: out.runId, agent: "2" })).toContain("done: p3")
    expect(await p.control({ action: "result", runId: out.runId, agent: "#2" })).toContain("done: p3")
    expect(await p.control({ action: "result", runId: out.runId, agent: "solo" })).toContain("done: p3")
    const dup = await p.control({ action: "result", runId: out.runId, agent: "dup" })
    expect(dup).toMatch(/matches 2 agents/)
    expect(dup).toContain("#0")
    expect(dup).toContain("#1")
    expect(dup).not.toContain("done: p1")
    const none = await p.control({ action: "result", runId: out.runId, agent: "nope" })
    expect(none).toMatch(/No agent "nope" in run \S+: it has 3 agents \(#0–#2\)/)
    expect(await p.control({ action: "result", runId: out.runId, agent: "#7" })).toMatch(/No agent "#7".*3 agents/)
  })

  test("X21 a label that looks like an index: the index wins when it exists (with a note naming the labeled agent); otherwise the label matches", async () => {
    const p = await h.setup()
    const { out } = await finished(p, {
      script: script(`return [await agent("p0", { label: "1" }), await agent("p1", { label: "7" })]`),
    })
    const one = await p.control({ action: "result", runId: out.runId, agent: "1" })
    expect(one).toContain("done: p1")
    expect(one).toContain(`agent #0 has the label "1"`)
    expect(one).toContain(`agent:"#0"`)
    const seven = await p.control({ action: "result", runId: out.runId, agent: "7" })
    expect(seven).toMatch(/^Agent #1 "7"/)
    expect(seven).toContain("done: p1")
  })

  test("X21 detail: status, phase, model, session, usage, duration, prompt head, full error, warnings, then the value whole; a closing hint to list", async () => {
    const runner = new FakeRunner()
      .on("alpha", { value: `first line\nsecond line ${SECRET}`, model: "openai/gpt-5.4-mini#high" })
      .on("beta", { status: "failed", error: "rate limited by provider\nstack trace line" })
      .on("gamma", { value: { verdict: "ok" } })
    const p = await h.setup({ runner })
    const { out } = await finished(p, {
      script: script(`phase("Scan"); return await parallel([() => agent("alpha task " + "P".repeat(900), { label: "A" }), () => agent("beta task", { label: "B" }), () => agent("gamma task", { label: "C" })])`),
    })
    const a = await p.control({ action: "result", runId: out.runId, agent: "0" })
    expect(a.split("\n")[0]).toBe(`Agent #0 "A" of run ${out.runId}: completed`)
    expect(a).toContain("phase: Scan")
    expect(a).toContain("model: openai/gpt-5.4-mini#high")
    expect(a).toContain("session: ses_fake_0")
    expect(a).toMatch(/usage: \S+ tokens/)
    expect(a).toMatch(/duration: /)
    expect(a).toContain("prompt: alpha task")
    expect(a).not.toContain("P".repeat(600)) // prompt head: 500 characters
    expect(a).toContain(`first line\nsecond line ${SECRET}`)
    expect(a.split("\n").at(-1)).toBe("Omit agent to list all 3 agents.")

    const b = await p.control({ action: "result", runId: out.runId, agent: "B" })
    expect(b).toContain("rate limited by provider\nstack trace line") // the full error
    expect(b).toContain("agent() returned null to the script (failed: rate limited by provider)")

    const c = await p.control({ action: "result", runId: out.runId, agent: "#2" })
    expect(c).toContain(JSON.stringify({ verdict: "ok" }, null, 2))
  })

  test("X21 a null agent's detail says why agent() gave the script null; a schema agent that never validated says agent() threw", async () => {
    const runner = new FakeRunner()
      .on("nil", { value: null })
      .on("slow", { hold: true })
      .on(/^s$/, { status: "schema_failed", error: "structured output failed validation after 5 attempts: /v: must be string" })
    const p = await h.setup({ runner })
    const out = await p.call({
      script: script(
        `await agent("nil"); const r = await parallel([() => agent("slow")]); ` +
          `return await agent("s", { schema: { type: "object", properties: { v: { type: "string" } } } })`,
      ),
    })
    await runner.waitForHeld(1)
    await p.control({ action: "stop_agent", runId: out.runId, agentIndex: 1 })
    await p.notification(0)
    await p.settled(out.runId!)
    expect(await p.control({ action: "result", runId: out.runId, agent: "0" })).toContain("agent() returned null to the script (its value was null)")
    expect(await p.control({ action: "result", runId: out.runId, agent: "1" })).toContain("agent() returned null to the script (failed: stopped by user)")
    const threw = await p.control({ action: "result", runId: out.runId, agent: "2" })
    expect(threw).toContain("agent() threw in the script (failed: structured output failed validation")
    expect(threw).not.toMatch(/returned null/)
  })

  test("X21 a long value is paged by characters (50,000 per page) with the next offset", async () => {
    const body = Array.from({ length: 12000 }, (_, i) => `line ${i}`).join("\n") + "\nTAIL-MARK"
    const runner = new FakeRunner().on("big", { value: body })
    const p = await h.setup({ runner })
    const { out } = await finished(p, { script: script(`await agent("big"); return "ok"`) })
    const first = await p.control({ action: "result", runId: out.runId, agent: "0" })
    expect(first).toContain("line 0\n")
    expect(first).not.toContain("TAIL-MARK")
    expect(first).toContain(`chars 0–50000 of ${body.length}; next offset 50000`)
    const last = await p.control({ action: "result", runId: out.runId, agent: "0", offset: 100_000 })
    expect(last).toContain("TAIL-MARK")
    expect(last).not.toContain("line 0\n")
    expect(last).toContain(`chars 100000–${body.length} of ${body.length}`)
    expect(last).not.toMatch(/next offset/)
  })

  test("X21 steering messages the agent received are shown: at most 5, each clipped to 500 characters", async () => {
    const runner = new FakeRunner().on("task", {
      hold: true,
      value: (_req, msgs) => `steered ${msgs?.length ?? 0}`,
    })
    const p = await h.setup({ runner })
    const out = await p.call({ script: script(`return await agent("task A", { label: "alpha" })`) })
    await runner.waitForHeld(1)
    for (let i = 0; i < 6; i++) {
      await p.control({ action: "message", runId: out.runId, agentIndex: 0, text: `msg-${i} ` + "M".repeat(700) })
    }
    runner.release()
    await p.notification(0)
    await p.settled(out.runId!)
    const d = await p.control({ action: "result", runId: out.runId, agent: "alpha" })
    expect(d).toMatch(/steering messages: 6/)
    expect(d).not.toContain("msg-0 ")
    for (let i = 1; i < 6; i++) expect(d).toContain(`msg-${i} `)
    expect(d).not.toContain("M".repeat(600))
  })

  test("X21 P41 cached agents of a resumed run are marked as replayed from the earlier run", async () => {
    const p = await h.setup()
    const src = script(`return [await agent("A"), await agent("B")]`)
    const first = await finished(p, { script: src })
    const { out } = await finished(p, { script: src, resumeFromRunId: first.out.runId }, 1)
    const list = await p.control({ action: "result", runId: out.runId })
    expect(list.split("\n")[0]).toMatch(/2 agents: 0 completed, 2 cached, 0 failed, 0 stopped, 0 null$/)
    const b = await p.control({ action: "result", runId: out.runId, agent: "1" })
    expect(b).toContain("done: B")
    expect(b).toContain(`cached: replayed from run ${first.out.runId}; did not run again`)
  })

  test("X21 P35 agents of a nested workflow() are marked with that workflow's name", async () => {
    const dir = join(h.projectDir, ".opencode", "workflows")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "inner.js"), script(`return await agent("in1")`, `{ name: "inner", description: "i" }`))
    const p = await h.setup()
    const { out } = await finished(p, { script: script(`await agent("out1"); return await workflow("inner")`) })
    const list = await p.control({ action: "result", runId: out.runId })
    expect(list).toMatch(/^#1 .*\(workflow inner\)/m)
    expect(list).not.toMatch(/^#0 .*\(workflow/m)
    expect(await p.control({ action: "result", runId: out.runId, agent: "1" })).toMatch(/workflow: inner/)
    expect((await h.store.readAgentRecord(out.runId!, 1))?.workflow).toBe("inner")
  })
})

describe("X21 descriptions", () => {
  test("X21 P77 the schema has agent (string) and offset; the descriptions document result for finished runs without inviting polling", () => {
    const props = CONTROL_INPUT_SCHEMA.properties as Record<string, any>
    expect((props.action.enum as string[]).includes("result")).toBe(true)
    expect(props.agent.type).toBe("string")
    expect(props.offset.type).toBe("integer")
    for (const k of ["status", "limit", "maxChars"]) expect(props[k]).toBeUndefined()
    expect(props.agentIndex.description).not.toMatch(/result/)
    expect(props.label.description).not.toMatch(/result/)
    expect(CONTROL_TOOL_DESCRIPTION).toMatch(/result \(/)
    expect(CONTROL_TOOL_DESCRIPTION).toMatch(/agent:"<index or label>"/)
    expect(CONTROL_TOOL_DESCRIPTION).toMatch(/offset/)
    for (const text of [TOOL_DESCRIPTION, CONTROL_TOOL_DESCRIPTION, AUTHORING_REFERENCE]) {
      expect(text).toMatch(/"result"|`result`|result \(/)
      expect(text).toMatch(/only repeats the status note/)
      expect(text).not.toMatch(/(poll|check) (for|until)/i)
    }
    // The reference prefers the action and says why; it still documents the files on disk.
    expect(AUTHORING_REFERENCE).toMatch(/journal\.jsonl/)
    expect(AUTHORING_REFERENCE).toMatch(/completion order/)
    expect(AUTHORING_REFERENCE).toMatch(/last line (for|per) an? index wins/)
    expect(AUTHORING_REFERENCE).toMatch(/agents\/<i>\.json/)
    expect(AUTHORING_REFERENCE).toMatch(/2000 characters/)
    expect(AUTHORING_REFERENCE).toMatch(/external_directory/)
    expect(AUTHORING_REFERENCE).not.toMatch(/read `?<transcriptDir>\/journal\.jsonl/)
  })
})
