// The opencode runner's steer window (src/opencode/runner.ts, design §A.4) over the fake session,
// whose inbox follows the live-verified model: drained before every model step, resume:true starts a
// successor turn after the session went idle.
import { describe, expect, test } from "bun:test"
import { AgentMailbox, type AgentMessage } from "../../src/mailbox.ts"
import { createOpencodeRunner, STRUCTURED_SUBAGENT_PREAMBLE, SUBAGENT_PREAMBLE } from "../../src/opencode/runner.ts"
import { STEERING_PREAMBLE_LINE } from "../../src/opencode/steer.ts"
import { createSubmitRegistry, createSubmitTool } from "../../src/opencode/submit.ts"
import type { AgentOptions, AgentRecord, AgentRequest } from "../../src/types.ts"
import { createFakeCtx, type FakeCtxOptions, type FakeSession } from "../helpers/fake-opencode-ctx.ts"

const SCHEMA = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] }

function setup(fakeOpts: FakeCtxOptions = {}) {
  const fake = createFakeCtx(fakeOpts)
  const registry = createSubmitRegistry(fake.ctx.storage)
  fake.setSubmitTool(createSubmitTool(registry))
  const runner = createOpencodeRunner(fake.ctx as any, { parentSessionID: fake.parentID, runId: "run1", registry, git: fake.git })
  return { fake, registry, runner }
}

function req(prompt: string, mailbox: AgentMailbox, opts: AgentOptions = {}) {
  const updates: Partial<AgentRecord>[] = []
  const controller = new AbortController()
  const request: AgentRequest = { runId: "run1", index: 0, prompt, opts, signal: controller.signal, onUpdate: (u) => updates.push(u), mailbox }
  return { request, updates, controller }
}

let k = 0
const msg = (text: string, extra: Partial<AgentMessage> = {}): AgentMessage => ({
  id: `wm_0_${++k}`,
  from: "user",
  via: "command",
  text,
  urgent: false,
  at: 1,
  ...extra,
})

const steered = (s: FakeSession) => s.messages.some((m) => m.type === "synthetic")
const lastAssistantText = (s: FakeSession) =>
  s.messages
    .filter((m) => m.type === "assistant")
    .at(-1)
    ?.content.filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("")

describe("runner steer window", () => {
  test("X01 a message sent mid-turn lands at the next step boundary of the same turn; the result is the reply after it", async () => {
    const mb = new AgentMailbox()
    let posted: Promise<unknown> | undefined
    const { fake, runner } = setup({
      respond: ({ turn }) => ({
        steps: 3,
        stepDelayMs: 15,
        onStep: (i) => {
          if (turn === 0 && i === 0) posted = mb.post(msg("focus on auth"))
        },
        textFn: (s) => (steered(s) ? "STEERED" : "plain"),
      }),
    })
    const out = await runner.run(req("task", mb).request)
    expect(await posted).toMatchObject({ ok: true, state: "sent" })
    expect(out).toMatchObject({ status: "completed", value: "STEERED" })
    const child = fake.children()[0]!
    expect(child.turns).toBe(1) // no extra turn: same execution
    expect(fake.calls.prompt).toHaveLength(1)
    const syn = fake.calls.synthetic[0]
    // resume:false: a steer item never wakes the session by itself (the runner decides, see X03).
    expect(syn).toMatchObject({ delivery: "steer", resume: false, sessionID: child.info.id })
    expect(fake.calls.interrupt).toHaveLength(0)
    expect(syn.text).toBe('<orchestrator-message from="user" id="wm_0_' + k + '">\nfocus on auth\n</orchestrator-message>')
    expect(syn.metadata).toMatchObject({ workflowRunId: "run1", workflowAgentIndex: 0 })
    expect(mb.records()[0]!.status).toBe("delivered")
    expect(mb.state).toBe("closed")
  })

  test("X03 a message sent after the last step: the runner itself starts the successor turn (interrupt resume:true) and reads that reply", async () => {
    const mb = new AgentMailbox()
    const { fake, runner } = setup({
      successorDelayMs: 20,
      respond: ({ successor }) =>
        successor
          ? { text: "REPLY TO MESSAGE" }
          : {
              steps: 2,
              afterSteps: () => {
                void mb.post(msg("one more thing"))
              },
              text: "first answer",
            },
    })
    const out = await runner.run(req("task", mb).request)
    expect(out).toMatchObject({ status: "completed", value: "REPLY TO MESSAGE" })
    const child = fake.children()[0]!
    expect(child.turns).toBe(2)
    // no turn ran after the one the result came from
    expect(lastAssistantText(child)).toBe("REPLY TO MESSAGE")
    expect(mb.records()[0]!.status).toBe("delivered")
    expect(fake.calls.interrupt).toEqual([{ sessionID: child.info.id, resume: true }])
  })

  test("X03 a message that never reaches the agent is reported undelivered, with a warning; the result stays the turn's reply", async () => {
    const mb = new AgentMailbox()
    const { runner } = setup({
      noSuccessor: true,
      respond: () => ({ steps: 1, afterSteps: () => void mb.post(msg("lost")), text: "first answer" }),
    })
    const r = req("task", mb)
    const out = await runner.run(r.request)
    expect(out).toMatchObject({ status: "completed", value: "first answer" })
    expect(mb.records()[0]!.status).toBe("undelivered")
    expect(r.updates.some((u) => u.warnings?.some((w) => /not delivered/.test(w)))).toBe(true)
  }, 15_000)

  test("X03 a message the runner gives up on never starts a turn later: nothing runs unread and no tokens go uncounted", async () => {
    const mb = new AgentMailbox()
    const { fake, runner } = setup({
      // opencode would start a resume:true item's successor turn on its own; here it would come after
      // the ~2 s verify window, when nobody reads the session any more.
      successorDelayMs: 2_600,
      ignoreWake: true,
      respond: ({ successor }) =>
        successor ? { text: "UNREAD REPLY", tokens: { output: 999 } } : { steps: 1, afterSteps: () => void mb.post(msg("late")), text: "first answer" },
    })
    const r = req("task", mb)
    const out = await runner.run(r.request)
    expect(out).toMatchObject({ status: "completed", value: "first answer" })
    expect(mb.records()[0]!.status).toBe("undelivered")
    await new Promise((res) => setTimeout(res, 800))
    const child = fake.children()[0]!
    expect(child.turns).toBe(1)
    expect(lastAssistantText(child)).toBe("first answer")
    // The message stays parked in the finished agent's inbox: it wakes nothing.
    expect(child.inbox).toHaveLength(1)
    expect(child.inbox[0]!.resume).toBe(false)
  }, 15_000)

  test("X03 steers whose synthetic() returned no id cannot be checked: no false undelivered warning and no 2 s wait", async () => {
    const mb = new AgentMailbox()
    const posted: Promise<unknown>[] = []
    const { runner } = setup({
      syntheticNoId: true,
      respond: ({ turn }) => ({
        steps: 3,
        stepDelayMs: 10,
        onStep: (i) => {
          if (turn === 0 && i === 0) posted.push(mb.post(msg("one")), mb.post(msg("two")))
        },
        textFn: (s) => `saw ${s.messages.filter((m) => m.type === "synthetic").length}`,
      }),
    })
    const r = req("task", mb)
    const t0 = Date.now()
    const out = await runner.run(r.request)
    expect(Date.now() - t0).toBeLessThan(1_000)
    for (const p of posted) expect(await p).toMatchObject({ ok: true, state: "sent" })
    expect(out).toMatchObject({ status: "completed", value: "saw 2" })
    expect(mb.records().map((m) => m.status)).toEqual(["sent", "sent"])
    expect(r.updates.some((u) => u.warnings?.some((w) => /not delivered/.test(w)))).toBe(false)
  })

  test("X04 held messages are appended to the first prompt, after the task, and reported delivered", async () => {
    const mb = new AgentMailbox()
    await mb.post(msg("prefer primary sources"))
    const { fake, runner } = setup({ respond: () => ({ text: "ok" }) })
    await runner.run(req("research X", mb).request)
    const text = fake.calls.prompt[0]!.text
    expect(text.startsWith(`${SUBAGENT_PREAMBLE}\n\nresearch X\n\n<orchestrator-message from="user"`)).toBe(true)
    expect(text).toContain("prefer primary sources")
    expect(fake.calls.synthetic).toHaveLength(0)
    expect(mb.records()[0]!.status).toBe("delivered")
  })

  test("X08 urgent: steer then interrupt({resume:true}); the agent continues with the message and completes", async () => {
    const mb = new AgentMailbox()
    const { fake, runner } = setup({
      respond: ({ turn, successor }) =>
        successor
          ? { text: "URGENT-OK" }
          : {
              steps: 5,
              stepDelayMs: 15,
              onStep: (i) => {
                if (turn === 0 && i === 1) void mb.post(msg("switch to French", { urgent: true }))
              },
              text: "long english answer",
            },
    })
    const r = req("task", mb)
    const out = await runner.run(r.request)
    expect(out).toMatchObject({ status: "completed", value: "URGENT-OK" })
    expect(fake.calls.interrupt).toEqual([{ sessionID: fake.children()[0]!.info.id, resume: true }])
    expect(r.updates.some((u) => u.warnings?.some((w) => /urgent/i.test(w) && /tokens/.test(w)))).toBe(true)
    expect(mb.records()[0]!.status).toBe("delivered")
  })

  test("X02 a schema agent that already submitted refuses messages with `submitted`", async () => {
    const mb = new AgentMailbox()
    let result: unknown
    const { fake, runner, registry } = setup({
      respond: ({ turn }) => ({
        steps: 2,
        onStep: async (i) => {
          if (turn !== 0 || i !== 1) return
          await registry.submit(fake.children()[0]!.info.id, { answer: "done" })
          result = await mb.post(msg("change it"))
        },
      }),
    })
    const out = await runner.run(req("compute", mb, { schema: SCHEMA }).request)
    expect(out).toMatchObject({ status: "completed", value: { answer: "done" } })
    expect(result).toMatchObject({ ok: false, reason: "submitted" })
    expect(fake.calls.synthetic).toHaveLength(0)
  })

  test("X02 between schema retries the window is closed (finishing); after the agent settles it is sealed (finished)", async () => {
    const mb = new AgentMailbox()
    const results: unknown[] = []
    const { runner } = setup({
      respond: ({ turn }) => (turn === 0 ? { afterSteps: () => void setTimeout(() => void mb.post(msg("x")).then((r) => results.push(r)), 0), text: "no submit" } : { submit: [{ answer: "ok" }] }),
    })
    const out = await runner.run(req("compute", mb, { schema: SCHEMA }).request)
    expect(out.status).toBe("completed")
    expect(await mb.post(msg("late"))).toMatchObject({ ok: false, reason: "finished" })
  })

  test("a stopped agent seals its mailbox", async () => {
    const mb = new AgentMailbox()
    const { runner } = setup({ respond: () => ({ hang: true }) })
    const r = req("task", mb)
    const p = runner.run(r.request)
    await new Promise((res) => setTimeout(res, 20))
    r.controller.abort()
    expect((await p).status).toBe("stopped")
    expect(await mb.post(msg("too late"))).toMatchObject({ ok: false, reason: "finished" })
  })

  test("X09 P78 both preambles tell the agent orchestrator messages may arrive", () => {
    expect(SUBAGENT_PREAMBLE).toContain(STEERING_PREAMBLE_LINE)
    expect(STRUCTURED_SUBAGENT_PREAMBLE).toContain(STEERING_PREAMBLE_LINE)
    expect(SUBAGENT_PREAMBLE.endsWith("Your task:")).toBe(true)
  })
})
