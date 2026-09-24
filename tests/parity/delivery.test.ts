// Parity: the task notification is the ONLY path that delivers a run's result to the model (P77).
// Claude Code has no model-facing status tool that returns a workflow's result, so a model that
// polls cannot answer from a status call and then answer again when the notification arrives.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { AUTHORING_REFERENCE, TOOL_DESCRIPTION } from "../../src/authoring.ts"
import { formatAgentFailures } from "../../src/plugin/format.ts"
import { CONTROL_TOOL_DESCRIPTION } from "../../src/plugin/tools.ts"
import type { AgentRecord } from "../../src/types.ts"
import { FakeRunner } from "../helpers/fake-runner.ts"
import { createHarness, script, tag, type Harness } from "../helpers/plugin-harness.ts"

let h: Harness
beforeEach(async () => {
  h = await createHarness()
})
afterEach(async () => {
  await h.dispose()
})

const END_TURN = /end your turn now; do not poll, sleep, or run shell commands to wait/
const RESULT = "THE-FINAL-ANSWER-42"

describe("P77 single delivery path", () => {
  test("P77 workflow_control status of a running run has no result and tells the model to end its turn", async () => {
    const runner = new FakeRunner().on("slow", { hold: true })
    const p = await h.setup({ runner })
    const out = await p.call({ script: script(`await agent("slow"); return "${RESULT}"`) })
    await runner.waitForCalls(1)
    const status = await p.control({ action: "status", runId: out.runId })
    expect(status).toContain("Still running")
    expect(status).toMatch(/delivered to this session as a task notification/)
    expect(status).toMatch(END_TURN)
    const list = await p.control({ action: "list" })
    expect(list).toContain(out.runId!)
    expect(list).toMatch(END_TURN)
    runner.release()
    await p.notification(0)
  })

  test("P77 a finished run: model-facing status and list never show the result, before or after the notification is queued", async () => {
    const p = await h.setup()
    const release = p.holdNotifications()
    const out = await p.call({ script: script(`await agent("x"); return "${RESULT}"`) })
    await p.settled(out.runId!)
    const check = async () => {
      const status = await p.control({ action: "status", runId: out.runId })
      expect(status).toContain("completed")
      expect(status).toContain("Finished")
      expect(status).toMatch(/delivered to this session as a task notification/)
      expect(status).toMatch(/if you have not received it yet, end your turn now/i)
      // No file to read (outside the project that asks for approval) and no other action to call.
      expect(status).not.toMatch(/run\.json/)
      expect(status).not.toMatch(/"result"/)
      expect(status).not.toContain(RESULT)
      expect(status).not.toContain("Result:")
      expect(await p.control({ action: "list" })).not.toContain(RESULT)
    }
    await check()
    release()
    const n = await p.notification(0)
    expect(p.resultOf(n)).toBe(RESULT)
    // session.synthetic resolving only means the notification entered the parent's inbox (delivery
    // "queue" runs it after the current turn), not that the model has read it: still no result.
    await new Promise((r) => setTimeout(r, 20))
    await check()
  })

  test("P77 model-facing status hides per-agent result previews; /workflows <runId> shows them", async () => {
    const p = await h.setup()
    const out = await p.call({ script: script(`return await agent("x")`) })
    await p.notification(0)
    await p.settled(out.runId!)
    const status = await p.control({ action: "status", runId: out.runId })
    expect(status).toContain("#0")
    expect(status).not.toMatch(/^\s+result:/m)
    await p.command("workflows", out.runId!)
    expect(String(p.synthetic.at(-1).text)).toMatch(/^\s+result:/m)
  })

  test("P77 the user-facing /workflows <runId> still shows the result before the notification is delivered", async () => {
    const p = await h.setup()
    const release = p.holdNotifications()
    const out = await p.call({ script: script(`await agent("x"); return "${RESULT}"`) })
    await p.settled(out.runId!)
    await p.command("workflows", out.runId!)
    const text = String(p.synthetic.at(-1).text)
    expect(text).toContain("Result:")
    expect(text).toContain(RESULT)
    release()
    await p.notification(0)
  })

  test("P77 after a plugin reload, model-facing status of a finished run still omits the result and names no file", async () => {
    const p = await h.setup()
    const out = await p.call({ script: script(`await agent("x"); return "${RESULT}"`) })
    await p.notification(0)
    await p.settled(out.runId!)
    expect((await h.store.readSummary(out.runId!))?.result).toBe(RESULT)
    await p.cleanup?.()
    const q = await h.setup()
    const status = await q.control({ action: "status", runId: out.runId })
    expect(status).toMatch(/delivered to this session as a task notification/)
    expect(status).not.toMatch(/run\.json/)
    expect(status).not.toContain(RESULT)
    expect(status).not.toContain("Result:")
  })

  test("P77 tool descriptions and the launch output say: end the turn after launching, never poll, sleep or shell-wait", async () => {
    const p = await h.setup()
    const out = await p.call({ script: script(`return 1`) })
    await p.notification(0)
    for (const text of [TOOL_DESCRIPTION, out.summary!, AUTHORING_REFERENCE]) {
      expect(text).toMatch(/END YOUR TURN/)
      expect(text).toMatch(/never call workflow_control status/i)
      expect(text).toMatch(/sleep/)
      expect(text).toMatch(/shell/)
    }
    expect(CONTROL_TOOL_DESCRIPTION).toMatch(/only when the user asks about progress/i)
    expect(CONTROL_TOOL_DESCRIPTION).toMatch(/never .*to wait for/i)
    expect(CONTROL_TOOL_DESCRIPTION).toMatch(/task notification/)
  })
})

describe("P77 repeated progress calls", () => {
  test("P77 from the 2nd status/result call on a run since it last changed state, the note says repeating does not wait", async () => {
    const REPEAT = "Repeating this call does not wait or speed anything up."
    const runner = new FakeRunner().on("slow", { hold: true })
    const p = await h.setup({ runner })
    const out = await p.call({ script: script(`await agent("slow"); return "${RESULT}"`) })
    await runner.waitForCalls(1)
    const first = await p.control({ action: "status", runId: out.runId })
    expect(first).toMatch(END_TURN)
    expect(first).not.toContain(REPEAT)
    expect(await p.control({ action: "status", runId: out.runId })).toContain(REPEAT)
    // status and result share the count: while the run is going, both only repeat the note.
    expect(await p.control({ action: "result", runId: out.runId })).toContain(REPEAT)
    // A state change (paused) starts the count over.
    await p.control({ action: "pause", runId: out.runId })
    const paused = await p.control({ action: "status", runId: out.runId })
    expect(paused).toMatch(/Paused/)
    expect(paused).not.toContain(REPEAT)
    expect(await p.control({ action: "status", runId: out.runId })).toContain(REPEAT)
    await p.control({ action: "resume", runId: out.runId })
    runner.release()
    await p.notification(0)
  })
})

// P79: Claude Code's notification points the model at the per-agent results so it checks them
// BEFORE diagnosing an empty or unexpected result. Here the pointer is workflow_control `result`
// (X21), not a file: the transcript dir is outside the project (an external_directory ask per read,
// which can hang a headless turn) and the read tool cuts journal.jsonl lines at 2000 characters.
describe("P79 per-agent results pointed to by the notification", () => {
  test("P79 <diagnostics> follows <transcript-dir> and points at workflow_control result with Claude Code's 'BEFORE diagnosing' wording; it names no file", async () => {
    const long = "L".repeat(3000)
    const runner = new FakeRunner().on("a", { value: long }).on("b", { value: { k: [1, 2] } })
    const p = await h.setup({ runner })
    const out = await p.call({ script: script(`const a = await agent("a"); const b = await agent("b"); return ""`) })
    const text = String((await p.notification(0)).text)
    const diag = tag(text, "diagnostics")!
    expect(diag).toBe(
      `Per-agent results: workflow_control {action:"result", runId:"${out.runId}"} lists every agent (failed ones first) ` +
        `with a preview of its return value or error; add agent:"<index or label>" for one agent's full return value. ` +
        "If the result above is empty or unexpected, check this BEFORE diagnosing — do not assume agents returned " +
        `non-empty results. If you cannot use it, tell the user to open /workflows ${out.runId}; do not read the ` +
        "transcript files with shell commands.",
    )
    // Short: about 450 characters besides the two run ids, one block per notification.
    expect(diag.replaceAll(out.runId!, "").length).toBeLessThan(460)
    expect(text.indexOf("<diagnostics>")).toBeGreaterThan(text.indexOf("</transcript-dir>"))
    expect(text.indexOf("<diagnostics>")).toBeGreaterThan(text.indexOf("</result>"))
    // It never carries per-agent values itself, and names no file or permission.
    expect(diag).not.toContain(long.slice(0, 50))
    expect(diag).not.toMatch(/journal|\.json|external_directory/)
  })

  test("P79 a run that started no agents has no <diagnostics>", async () => {
    const p = await h.setup()
    await p.call({ script: script(`return 1`) })
    const text = String((await p.notification(0)).text)
    expect(tag(text, "diagnostics")).toBeUndefined()
    expect(tag(text, "agent-failures")).toBeUndefined()
  })

  test("P79 P77 the tool description names the result action for after the notification; the launch output, status and list never point at it", async () => {
    expect(TOOL_DESCRIPTION).toContain(
      'PER-AGENT OUTPUTS: after the task notification arrives, workflow_control action "result" shows what each agent returned (failed agents first). ' +
        "Use it when the result is empty or unexpected, or when the user asks what a specific agent said. It is for diagnosing a finished run, " +
        "not for checking progress: while the run is going it only repeats the status note.",
    )
    // A paragraph of its own, not part of AFTER LAUNCHING.
    expect(TOOL_DESCRIPTION).toMatch(/\n\nPER-AGENT OUTPUTS:/)
    const runner = new FakeRunner().on("slow", { hold: true })
    const p = await h.setup({ runner })
    const out = await p.call({ script: script(`await agent("slow"); return "${RESULT}"`) })
    await runner.waitForCalls(1)
    expect(out.summary).not.toMatch(/"result"|journal/)
    for (const view of [await p.control({ action: "status", runId: out.runId }), await p.control({ action: "list" })]) {
      expect(view).not.toMatch(/"result"|journal/)
      expect(view).toMatch(END_TURN)
    }
    runner.release()
    await p.notification(0)
  })
})

// X20: a compact per-agent failure summary in the notification (Claude Code has none).
describe("X20 per-agent failure summary in the notification", () => {
  test("X20 failed and stop_agent-stopped agents: counts, then index, label, status and the error's first line; after usage, before script-path", async () => {
    const runner = new FakeRunner()
      .on("bad", { status: "failed", error: "boom:   provider 500\n    at stack line" })
      .on("slow", { hold: true })
    const p = await h.setup({ runner })
    const out = await p.call({
      script: script(
        `const r = await parallel([() => agent("ok"), () => agent("bad", { label: "the  bad\\n one" }), () => agent("slow", { label: "slowpoke" })]); return r`,
      ),
    })
    await runner.waitForHeld(1)
    await p.control({ action: "stop_agent", runId: out.runId, agentIndex: 2 })
    const text = String((await p.notification(0)).text)
    expect(tag(text, "status")).toBe("completed")
    const block = tag(text, "agent-failures")!
    // stop_agent counts as failed (P51): its agent() returned null.
    expect(block.split("\n")[0]).toBe("2 of 3 agents returned no result (2 failed, 0 stopped, 0 null):")
    expect(block).toContain(`#1 "the bad one" failed: boom: provider 500`)
    expect(block).not.toContain("stack line")
    expect(block).toMatch(/#2 "slowpoke" failed: stopped by user/)
    expect(block).not.toContain(`#0`)
    expect(text.indexOf("<agent-failures>")).toBeGreaterThan(text.indexOf("</usage>"))
    expect(text.indexOf("<agent-failures>")).toBeLessThan(text.indexOf("<script-path>"))
    expect(text.indexOf("<agent-failures>")).toBeLessThan(text.indexOf("<diagnostics>"))
  })

  test("X20 a stopped run lists the agents it stopped", async () => {
    const runner = new FakeRunner().on("slow", { hold: true })
    const p = await h.setup({ runner })
    const out = await p.call({ script: script(`await agent("fast"); return await agent("slow", { label: "held" })`) })
    await runner.waitForHeld(1)
    await p.control({ action: "stop", runId: out.runId })
    const text = String((await p.notification(0)).text)
    expect(tag(text, "status")).toBe("stopped")
    const block = tag(text, "agent-failures")!
    expect(block).toMatch(/^1 of 2 agents returned no result \(0 failed, 1 stopped, 0 null\):/)
    expect(block).toMatch(/#1 "held" stopped$/m)
  })

  test("X20 a run whose agents all completed with a value has no failure block", async () => {
    const p = await h.setup()
    await p.call({ script: script(`return await agent("x")`) })
    expect(String((await p.notification(0)).text)).not.toContain("<agent-failures>")
  })

  test("X20 null values, a schema agent that threw and a nested workflow() agent are named as such", async () => {
    const dir = join(h.projectDir, ".opencode", "workflows")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "inner.js"), script(`return await agent("in-nil")`, `{ name: "inner", description: "i" }`))
    const runner = new FakeRunner()
      .on("nil", { value: null })
      .on("in-nil", { value: null })
      .on(/^s$/, { status: "schema_failed", error: "structured output failed validation after 5 attempts: /v: must be string" })
    const p = await h.setup({ runner })
    const out = await p.call({
      script: script(
        `await agent("nil", { label: "nothing" }); await workflow("inner"); ` +
          `return await agent("s", { label: "judge", schema: { type: "object", properties: { v: { type: "string" } } } })`,
      ),
    })
    const text = String((await p.notification(0)).text)
    expect(tag(text, "status")).toBe("failed")
    const block = tag(text, "agent-failures")!
    expect(block.split("\n")[0]).toBe("3 of 3 agents returned no result (1 failed, 0 stopped, 2 null):")
    expect(block).toContain(`#0 "nothing" completed: returned null`)
    expect(block).toMatch(/#1 "[^"]*" completed in workflow "inner": returned null/)
    expect(block).toContain(`#2 "judge" failed (agent() threw): structured output failed validation`)
    await p.settled(out.runId!)
  })

  test("X20 a failed run with no failed agent says the script raised the error, including agent() calls refused before an agent started", async () => {
    const REFUSED =
      "No agent failed: the error above was raised by the script itself (this includes agent() calls refused before an " +
      "agent started: budget, agent cap, invalid options/schema)."
    const p = await h.setup()
    await p.call({ script: script(`await agent("x"); await agent("y"); throw new Error("kaboom")`) })
    const text = String((await p.notification(0)).text)
    expect(tag(text, "status")).toBe("failed")
    expect(tag(text, "agent-failures")).toBe(REFUSED)
    // A refused agent() call (schema preflight) leaves no agent record: the same line explains it.
    await p.call({ script: script(`await agent("ok"); return await agent("z", { schema: { type: "string" } })`) })
    const refused = String((await p.notification(1)).text)
    expect(tag(refused, "status")).toBe("failed")
    expect(tag(refused, "result")).toMatch(/schema rejected before the agent started/)
    expect(tag(refused, "agent-failures")).toBe(REFUSED)
  })

  test("X20 bounded: 1000 failing agents with long labels and errors give a block under 3 KB with a count of the rest", async () => {
    const runner = new FakeRunner().on(/^f/, { status: "failed", error: "E  ".repeat(3000) })
    const p = await h.setup({ runner })
    const items = JSON.stringify(Array.from({ length: 1000 }, (_, i) => i))
    const out = await p.call({
      script: script(`const r = await pipeline(${items}, (i) => agent("f" + i, { label: "L".repeat(500) + i })); return r.filter(Boolean).length`),
    })
    const text = String((await p.notification(0, 60000)).text)
    const block = tag(text, "agent-failures")!
    expect(block.split("\n")[0]).toBe("1000 of 1000 agents returned no result (1000 failed, 0 stopped, 0 null):")
    const lines = block.split("\n").filter((l) => l.startsWith("#"))
    expect(lines.length).toBe(10)
    // label ≤ 60 characters, error ≤ 160, whitespace folded
    expect(lines[0]).toMatch(/^#0 "L{59}…" failed: (E ){79}E…$/)
    expect(block.split("\n").at(-1)).toBe(
      `… and 990 more: workflow_control {action:"result", runId:"${out.runId}"} lists failed agents first.`,
    )
    expect(Buffer.byteLength(block, "utf8")).toBeLessThan(3000)
  }, 60000)

  test("X20 bounded worst case: 3-digit indexes, threw, nested workflow and multi-byte labels/errors stay under 3000 bytes", () => {
    const usage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
    const record = (index: number, failed: boolean): AgentRecord => ({
      index,
      key: `k${index}`,
      label: "é漢".repeat(100) + index,
      prompt: "p",
      opts: {},
      status: failed ? "failed" : "completed",
      usage,
      ...(failed ? { threw: true, workflow: "ワーク".repeat(40), error: "エラー é ".repeat(200) } : { result: "ok" }),
    })
    // All 1000 failed (#0…), and 20 failed among the last indexes (#980…#999, the widest).
    for (const firstFailed of [0, 980]) {
      const agents = Array.from({ length: 1000 }, (_, i) => record(i, i >= firstFailed))
      const block = formatAgentFailures({ runId: "wf_abcdefghijklm_12345678", status: "failed" }, agents)!
      expect(Buffer.byteLength(block, "utf8")).toBeLessThan(3000)
      const lines = block.split("\n").filter((l) => l.startsWith("#"))
      expect(lines.length).toBeGreaterThanOrEqual(1)
      expect(lines.length).toBeLessThanOrEqual(10)
      for (const l of lines) expect(l).toMatch(/^#\d+ "[^"]*" failed \(agent\(\) threw\) in workflow "[^"]*": エラー/)
      // Every failed agent is either shown or counted in the footer.
      const more = Number(block.split("\n").at(-1)!.match(/^… and (\d+) more: /)![1])
      expect(lines.length + more).toBe(1000 - firstFailed)
    }
  })
})
