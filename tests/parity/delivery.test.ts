// Parity: the task notification is the ONLY path that delivers a run's result to the model (P77).
// Claude Code has no model-facing status tool that returns a workflow's result, so a model that
// polls cannot answer from a status call and then answer again when the notification arrives.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { AUTHORING_REFERENCE, TOOL_DESCRIPTION } from "../../src/authoring.ts"
import { CONTROL_TOOL_DESCRIPTION } from "../../src/plugin/tools.ts"
import { FakeRunner } from "../helpers/fake-runner.ts"
import { createHarness, script, type Harness } from "../helpers/plugin-harness.ts"

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
      expect(status).toMatch(/run\.json/) // the full result stays readable on disk
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

  test("P77 after a plugin reload, model-facing status of a finished run still omits the result (run.json keeps it)", async () => {
    const p = await h.setup()
    const out = await p.call({ script: script(`await agent("x"); return "${RESULT}"`) })
    await p.notification(0)
    await p.settled(out.runId!)
    expect((await h.store.readSummary(out.runId!))?.result).toBe(RESULT)
    await p.cleanup?.()
    const q = await h.setup()
    const status = await q.control({ action: "status", runId: out.runId })
    expect(status).toMatch(/run\.json/)
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
