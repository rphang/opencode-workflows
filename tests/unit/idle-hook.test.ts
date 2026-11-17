// The `experimental.idle` session hook (src/opencode/idle.ts, opencode 2.3+): X22 reads steering messages
// that land as a child's execution ends in that same execution; X23 nudges a schema agent that stops
// without an accepted workflow_submit, within the P21 budget. Over the fake session, whose 2.3.0 mode
// runs the Location's hooks after a succeeded turn and continues the execution when the inbox is not
// empty after them.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { AgentMailbox, type AgentMessage } from "../../src/mailbox.ts"
import { ChildLiveRegistry, idleHookEnabled, registerIdleHook } from "../../src/opencode/idle.ts"
import { createOpencodeRunner } from "../../src/opencode/runner.ts"
import { createSubmitRegistry, createSubmitTool, SUBMIT_STORAGE_PREFIX } from "../../src/opencode/submit.ts"
import type { AgentOptions, AgentRecord, AgentRequest } from "../../src/types.ts"
import { createFakeCtx, type FakeCtxOptions, type FakeSession } from "../helpers/fake-opencode-ctx.ts"

const SCHEMA = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const saved = process.env.MAX_STRUCTURED_OUTPUT_RETRIES
beforeEach(() => {
  delete process.env.MAX_STRUCTURED_OUTPUT_RETRIES
})
afterEach(() => {
  if (saved === undefined) delete process.env.MAX_STRUCTURED_OUTPUT_RETRIES
  else process.env.MAX_STRUCTURED_OUTPUT_RETRIES = saved
})

async function setup(fakeOpts: FakeCtxOptions = {}, hookOpts: { timeoutMs?: number } = {}) {
  const fake = createFakeCtx(fakeOpts)
  const registry = createSubmitRegistry(fake.ctx.storage)
  fake.setSubmitTool(createSubmitTool(registry))
  const live = new ChildLiveRegistry()
  const registration = await registerIdleHook(fake.ctx as any, { registry, live, ...hookOpts })
  const runner = createOpencodeRunner(fake.ctx as any, { parentSessionID: fake.parentID, runId: "run1", registry, git: fake.git, live })
  return { fake, registry, live, registration, runner }
}

function req(prompt: string, mailbox?: AgentMailbox, opts: AgentOptions = {}) {
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

const idleMarkers = (s: FakeSession) => s.messages.filter((m) => m.type === "idle").length
const nudges = (fake: ReturnType<typeof createFakeCtx>) => fake.calls.synthetic.filter((c) => c.metadata?.workflowNudge !== undefined)
const warned = (updates: Partial<AgentRecord>[], re: RegExp) => updates.some((u) => u.warnings?.some((w) => re.test(w)))

/** Delays every synthetic() send by `ms` (or until `gate` resolves): the send is in flight meanwhile. */
function slowSynthetic(fake: ReturnType<typeof createFakeCtx>, wait: () => Promise<unknown>) {
  const orig = fake.ctx.session.synthetic
  fake.ctx.session.synthetic = (async (input: any) => {
    await wait()
    return orig(input)
  }) as typeof orig
}

describe("X22 steering flush at the idle boundary", () => {
  test("X22 registration: only when ctx.session.hook exists; OPENCODE_WORKFLOW_IDLE_HOOK=0 is the kill switch", async () => {
    const { fake, registration } = await setup()
    expect(registration).toBeDefined()
    expect(fake.sessionHooks.map((h) => h.name)).toEqual(["experimental.idle"])
    await registration!.dispose()
    expect(fake.sessionHooks).toHaveLength(0)
    const old = createFakeCtx({ noSessionHook: true })
    expect(await registerIdleHook(old.ctx as any, { registry: createSubmitRegistry(), live: new ChildLiveRegistry() })).toBeUndefined()
    const throwing = createFakeCtx()
    ;(throwing.ctx.session as any).hook = async () => {
      throw new Error("unknown hook")
    }
    expect(await registerIdleHook(throwing.ctx as any, { registry: createSubmitRegistry(), live: new ChildLiveRegistry() })).toBeUndefined()
    for (const v of ["0", "false", "no", "off"]) expect(idleHookEnabled({ OPENCODE_WORKFLOW_IDLE_HOOK: v })).toBe(false)
    expect(idleHookEnabled({})).toBe(true)
    expect(idleHookEnabled({ OPENCODE_WORKFLOW_IDLE_HOOK: "1" })).toBe(true)
  })

  test("X22 ignores sessions that are not workflow children (looked up once, then cached)", async () => {
    const { fake } = await setup({ respond: () => ({ text: "hi" }) })
    const s = (await fake.ctx.session.create({ title: "someone else's session" })) as { id: string }
    let gets = 0
    const orig = fake.ctx.session.get
    fake.ctx.session.get = (async (i: any) => {
      if (i.sessionID === s.id) gets++
      return orig(i)
    }) as typeof orig
    for (let i = 0; i < 2; i++) {
      await fake.ctx.session.prompt({ sessionID: s.id, text: "hello" })
      await fake.ctx.session.wait({ sessionID: s.id })
    }
    expect(fake.calls.idleHook.filter((c) => c.sessionID === s.id)).toHaveLength(2)
    expect(gets).toBe(1)
    expect(fake.calls.synthetic).toHaveLength(0)
    expect(idleMarkers(fake.sessions.get(s.id)!)).toBe(2)
  })

  test("X22 a message in flight as the turn ends is awaited and read in the same execution: no wake, no warning", async () => {
    const mb = new AgentMailbox()
    let posted: Promise<unknown> | undefined
    const { fake, runner } = await setup({
      respond: ({ continuation }) =>
        continuation ? { text: "REPLY TO MESSAGE" } : { text: "first answer", beforeIdleHook: () => void (posted = mb.post(msg("one more thing"))) },
    })
    slowSynthetic(fake, () => sleep(30))
    const r = req("task", mb)
    const out = await runner.run(r.request)
    expect(await posted).toMatchObject({ ok: true, state: "sent" })
    expect(out).toMatchObject({ status: "completed", value: "REPLY TO MESSAGE" })
    const child = fake.children()[0]!
    expect(idleMarkers(child)).toBe(1) // one execution
    expect(fake.calls.interrupt).toHaveLength(0) // no wake
    expect(mb.records()[0]!.status).toBe("delivered")
    expect(warned(r.updates, /not delivered/)).toBe(false)
  })

  test("X22 without the hook the same in-flight message misses the execution and takes the X03 wake", async () => {
    const mb = new AgentMailbox()
    const fake = createFakeCtx({
      respond: ({ successor }) =>
        successor ? { text: "REPLY TO MESSAGE" } : { text: "first answer", beforeIdleHook: () => void mb.post(msg("one more thing")) },
    })
    slowSynthetic(fake, () => sleep(30))
    const runner = createOpencodeRunner(fake.ctx as any, { parentSessionID: fake.parentID, runId: "run1", git: fake.git })
    const out = await runner.run(req("task", mb).request)
    expect(out).toMatchObject({ status: "completed", value: "REPLY TO MESSAGE" })
    expect(idleMarkers(fake.children()[0]!)).toBe(2)
    expect(fake.calls.interrupt).toEqual([{ sessionID: fake.children()[0]!.info.id, resume: true }])
  })

  test("X22 a message posted after the hook is refused `finishing` instead of being parked", async () => {
    const mb = new AgentMailbox()
    let late: unknown
    const { fake, runner } = await setup({
      respond: () => ({ text: "answer", afterIdleCheck: async () => void (late = await mb.post(msg("too late"))) }),
    })
    const out = await runner.run(req("task", mb).request)
    expect(out).toMatchObject({ status: "completed", value: "answer" })
    expect(late).toMatchObject({ ok: false, reason: "finishing" })
    expect(fake.calls.synthetic).toHaveLength(0)
    expect(fake.children()[0]!.inbox).toHaveLength(0)
  })

  test("X22 a hung send is released by the hook's time cap; the runner's X03 path still delivers it", async () => {
    const mb = new AgentMailbox()
    let open!: () => void
    const gate = new Promise<void>((r) => (open = r))
    let hookDone = 0
    const { fake, runner } = await setup(
      {
        respond: ({ successor }) =>
          successor
            ? { text: "REPLY TO MESSAGE" }
            : {
                text: "first answer",
                beforeIdleHook: () => void mb.post(msg("slow one")),
                afterIdleCheck: () => {
                  hookDone = Date.now()
                  setTimeout(open, 30)
                },
              },
      },
      { timeoutMs: 50 },
    )
    slowSynthetic(fake, () => gate)
    const t0 = Date.now()
    const out = await runner.run(req("task", mb).request)
    expect(hookDone - t0).toBeLessThan(1_000)
    expect(out).toMatchObject({ status: "completed", value: "REPLY TO MESSAGE" })
    expect(mb.records()[0]!.status).toBe("delivered")
    expect(fake.calls.interrupt).toHaveLength(1) // the X03 wake
  })

  test("X22 an error inside the hook never fails the child", async () => {
    const { fake, live, runner } = await setup({ respond: () => ({ text: "fine" }) })
    live.get = () => {
      throw new Error("boom")
    }
    const out = await runner.run(req("task", new AgentMailbox()).request)
    expect(out).toMatchObject({ status: "completed", value: "fine" })
    expect(fake.calls.idleHook).toHaveLength(1)
    // The fake fails an execution whose hook rejects, as opencode does: the hook must never reject.
    const other = createFakeCtx({ respond: () => ({ text: "x" }) })
    await (other.ctx.session as any).hook("experimental.idle", async () => {
      throw new Error("rejected")
    })
    const s = (await other.ctx.session.create({})) as { id: string }
    await other.ctx.session.prompt({ sessionID: s.id, text: "hi" })
    await other.ctx.session.wait({ sessionID: s.id })
    expect((await other.ctx.session.get({ sessionID: s.id })).outcome).toBe("failed")
  })

  test("X22 idleHookFires:false (opencode 2.0.15): the hook registers, never fires, and the X03 wake path is unchanged", async () => {
    const mb = new AgentMailbox()
    const { fake, runner } = await setup({
      idleHookFires: false,
      successorDelayMs: 20,
      respond: ({ successor }) => (successor ? { text: "REPLY TO MESSAGE" } : { steps: 2, afterSteps: () => void mb.post(msg("one more thing")), text: "first answer" }),
    })
    const out = await runner.run(req("task", mb).request)
    expect(fake.sessionHooks).toHaveLength(1)
    expect(fake.calls.idleHook).toHaveLength(0)
    expect(out).toMatchObject({ status: "completed", value: "REPLY TO MESSAGE" })
    expect(fake.calls.interrupt).toEqual([{ sessionID: fake.children()[0]!.info.id, resume: true }])
    expect(mb.records()[0]!.status).toBe("delivered")
  })

  test("X22 a worktree child has no mailbox in the worktree instance: it falls back to the X03 wake", async () => {
    const mb = new AgentMailbox()
    const { fake, registry, runner } = await setup({
      respond: ({ successor }) =>
        successor ? { text: "REPLY TO MESSAGE" } : { text: "first answer", beforeIdleHook: () => void mb.post(msg("one more thing")) },
    })
    const wt = fake.instance(fake.worktreeDir("wf-run1-0"))
    await registerIdleHook(wt.ctx, { registry: createSubmitRegistry(wt.ctx.storage), live: new ChildLiveRegistry() })
    slowSynthetic(fake, () => sleep(30))
    const out = await runner.run(req("task", mb, { isolation: "worktree" }).request)
    expect(out).toMatchObject({ status: "completed", value: "REPLY TO MESSAGE" })
    // Only the worktree instance's hook ran for the child, and it had nothing to flush.
    expect(fake.calls.idleHook.map((c) => c.directory)).toEqual([wt.directory, wt.directory])
    expect(fake.calls.interrupt).toHaveLength(1)
    expect(mb.records()[0]!.status).toBe("delivered")
    void registry
  })
})

describe("X23 schema nudge at the idle boundary", () => {
  test("X23 an agent that stops without submitting is nudged in the same execution and completes with one prompt", async () => {
    const { fake, runner } = await setup({
      respond: ({ continuation }) => (continuation ? { submit: [{ answer: "42" }] } : { text: "I think the answer is 42" }),
    })
    const out = await runner.run(req("compute", undefined, { schema: SCHEMA }).request)
    expect(out).toMatchObject({ status: "completed", value: { answer: "42" } })
    expect(fake.calls.prompt).toHaveLength(1)
    expect(idleMarkers(fake.children()[0]!)).toBe(1)
    const [n] = nudges(fake)
    expect(n).toMatchObject({ delivery: "steer", resume: false, metadata: { workflowRunId: "run1", workflowNudge: 1 } })
    expect(n.text).toContain("You did not call the `workflow_submit` tool")
  })

  test("X23 nudges count against MAX_STRUCTURED_OUTPUT_RETRIES: same attempts, then schema_failed", async () => {
    process.env.MAX_STRUCTURED_OUTPUT_RETRIES = "3"
    const { fake, runner } = await setup({ respond: () => ({ text: "no json here" }) })
    const out = await runner.run(req("compute", undefined, { schema: SCHEMA }).request)
    expect(out.status).toBe("schema_failed")
    if (out.status === "schema_failed") expect(out.error).toContain("after 3 attempts")
    expect(fake.calls.prompt).toHaveLength(1)
    expect(nudges(fake).map((c) => c.metadata.workflowNudge)).toEqual([1, 2])
  })

  test("X23 the retries-spent JSON fallback still applies after nudges", async () => {
    process.env.MAX_STRUCTURED_OUTPUT_RETRIES = "2"
    const { fake, runner } = await setup({ respond: () => ({ text: '```json\n{"answer":"from-text"}\n```' }) })
    const out = await runner.run(req("compute", undefined, { schema: SCHEMA }).request)
    expect(out).toMatchObject({ status: "completed", value: { answer: "from-text" } })
    expect(fake.calls.prompt).toHaveLength(1)
    expect(nudges(fake)).toHaveLength(1)
  })

  test("X23 an invalid submission then a stop: the nudge carries the validation error and is not counted twice", async () => {
    process.env.MAX_STRUCTURED_OUTPUT_RETRIES = "2"
    const { fake, runner } = await setup({
      respond: ({ continuation }) => (continuation ? { submit: [{ answer: "ok" }] } : { submit: [{ answer: 1 }], text: "submitted" }),
    })
    const out = await runner.run(req("compute", undefined, { schema: SCHEMA }).request)
    // Counted twice, the invalid submission would have spent both attempts and left no nudge.
    expect(out).toMatchObject({ status: "completed", value: { answer: "ok" } })
    const [n] = nudges(fake)
    expect(n.text).toContain("failed schema validation")
    expect(n.text).toContain("/answer")
    expect(fake.calls.prompt).toHaveLength(1)
  })

  test("X23 no nudge after acceptance, for plain agents, or while the agent's own subagent runs", async () => {
    const accepted = await setup({ respond: () => ({ submit: [{ answer: "x" }] }) })
    expect(await accepted.runner.run(req("c", undefined, { schema: SCHEMA }).request)).toMatchObject({ status: "completed" })
    expect(nudges(accepted.fake)).toHaveLength(0)

    const plain = await setup({ respond: () => ({ text: "plain" }) })
    expect(await plain.runner.run(req("c").request)).toMatchObject({ status: "completed", value: "plain" })
    expect(plain.fake.calls.synthetic).toHaveLength(0)

    // Its own subagent wakes the session with its notice (the hook runs again then): the runner re-prompts here.
    const busy = await setup({
      respond: ({ turn, session }) => {
        session.background = turn === 0 ? [{ kind: "subagent", sessionID: session.info.id, childSessionID: "ses_x" }] : []
        return turn === 0 ? { text: "waiting for my subagent" } : { submit: [{ answer: "x" }] }
      },
    })
    expect(await busy.runner.run(req("c", undefined, { schema: SCHEMA }).request)).toMatchObject({ status: "completed" })
    expect(nudges(busy.fake)).toHaveLength(0)
    expect(busy.fake.calls.prompt).toHaveLength(2)

    // A descendant's job wakes that descendant, not this session: it is nudged.
    const grandchild = await setup({
      respond: ({ continuation, session }) => {
        session.background = [{ kind: "subagent", sessionID: "ses_somebody_else", childSessionID: "ses_y" }]
        return continuation ? { submit: [{ answer: "x" }] } : { text: "done" }
      },
    })
    expect(await grandchild.runner.run(req("c", undefined, { schema: SCHEMA }).request)).toMatchObject({ status: "completed" })
    expect(nudges(grandchild.fake)).toHaveLength(1)
  })

  test("X23 no nudge once the agent is stopping or its runner has unregistered it", async () => {
    let r!: ReturnType<typeof req>
    const stopping = await setup({ respond: () => ({ text: "x", beforeIdleHook: () => r.controller.abort() }) })
    r = req("c", undefined, { schema: SCHEMA })
    expect((await stopping.runner.run(r.request)).status).toBe("stopped")
    expect(nudges(stopping.fake)).toHaveLength(0)

    const done = await setup({ respond: () => ({ submit: [{ answer: "x" }] }) })
    await done.runner.run(req("c", undefined, { schema: SCHEMA }).request)
    const child = done.fake.children()[0]!
    // The session runs again after the agent settled (e.g. someone prompts it): nothing is nudged.
    await done.fake.ctx.session.prompt({ sessionID: child.info.id, text: "again" })
    await done.fake.ctx.session.wait({ sessionID: child.info.id })
    expect(done.fake.calls.idleHook.length).toBeGreaterThanOrEqual(2)
    expect(nudges(done.fake)).toHaveLength(0)
  })

  test("X23 a worktree child is nudged by the worktree instance; the runner sees the nudge through rev-ordered storage", async () => {
    process.env.MAX_STRUCTURED_OUTPUT_RETRIES = "2"
    const { fake, runner } = await setup({ respond: () => ({ text: "no submit" }) })
    const wt = fake.instance(fake.worktreeDir("wf-run1-0"))
    const wtRegistry = createSubmitRegistry(wt.ctx.storage)
    fake.setSubmitTool(createSubmitTool(wtRegistry)) // the worktree instance serves the child's tools
    await registerIdleHook(wt.ctx, { registry: wtRegistry, live: new ChildLiveRegistry() })
    const out = await runner.run(req("compute", undefined, { schema: SCHEMA, isolation: "worktree" }).request)
    // Nudge 1 used the second attempt: had the runner kept its own older copy (same failures), it
    // would have re-prompted once more.
    expect(nudges(fake)).toHaveLength(1)
    expect(fake.calls.prompt).toHaveLength(1)
    expect(out.status).toBe("schema_failed")
    if (out.status === "schema_failed") expect(out.error).toContain("after 2 attempts")
    expect([...fake.storage.keys()].filter((key) => key.startsWith(SUBMIT_STORAGE_PREFIX))).toEqual([])
  })

  test("X23 a nudge in the runner's X03 wake turn leaves the window the runner closed as it is", async () => {
    const mb = new AgentMailbox()
    let open!: () => void
    const gate = new Promise<void>((r) => (open = r))
    let during: unknown
    const { fake, runner } = await setup(
      {
        respond: ({ successor, continuation }) =>
          continuation
            ? { submit: [{ answer: "ok" }], afterSteps: async () => void (during = await mb.post(msg("during the nudge"))) }
            : successor
              ? { text: "read the late message, still no submit" }
              : { text: "first", beforeIdleHook: () => void mb.post(msg("slow")), afterIdleCheck: () => void setTimeout(open, 30) },
      },
      { timeoutMs: 50 },
    )
    slowSynthetic(fake, () => gate)
    const out = await runner.run(req("compute", mb, { schema: SCHEMA }).request)
    expect(out).toMatchObject({ status: "completed", value: { answer: "ok" } })
    expect(fake.calls.interrupt).toHaveLength(1) // the X03 wake
    expect(nudges(fake)).toHaveLength(1) // sent in the wake turn
    // The runner had closed the window to verify its messages: the nudge does not reopen it.
    expect(during).toMatchObject({ ok: false, reason: "finishing" })
  })

  test("X23 messages sent during a nudge continuation are accepted and delivered", async () => {
    const mb = new AgentMailbox()
    let posted: Promise<unknown> | undefined
    const { fake, runner } = await setup({
      respond: ({ continuation }) =>
        continuation
          ? {
              steps: 2,
              stepDelayMs: 10,
              onStep: (i) => {
                if (i === 0) posted = mb.post(msg("also add a summary"))
              },
              submit: [{ answer: "with summary" }],
            }
          : { text: "forgot to submit" },
    })
    const out = await runner.run(req("compute", mb, { schema: SCHEMA }).request)
    expect(await posted).toMatchObject({ ok: true, state: "sent" })
    expect(out).toMatchObject({ status: "completed", value: { answer: "with summary" } })
    expect(mb.records()[0]!.status).toBe("delivered")
    expect(idleMarkers(fake.children()[0]!)).toBe(1)
  })
})
