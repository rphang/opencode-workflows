// X31: opencode 2.3's `subagent` tool always runs in the background, and session.wait() only awaits
// executions, not jobs. The idle hook records a workflow child's own background jobs (shared
// storage, so worktree children work too) and the runner keeps waiting after wait() while the
// latest report lists any: the job's report wakes the child, and the result is the reply after it.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { AgentMailbox, type AgentMessage } from "../../src/mailbox.ts"
import { JOBS_STORAGE_PREFIX } from "../../src/opencode/background.ts"
import { ChildLiveRegistry, registerIdleHook } from "../../src/opencode/idle.ts"
import { createOpencodeRunner, type OpencodeRunnerOptions } from "../../src/opencode/runner.ts"
import { createSubmitRegistry, createSubmitTool } from "../../src/opencode/submit.ts"
import type { AgentOptions, AgentRecord, AgentRequest } from "../../src/types.ts"
import { createFakeCtx, type FakeCtxOptions, type FakeSession } from "../helpers/fake-opencode-ctx.ts"

const SCHEMA = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] }

const saved = process.env.MAX_STRUCTURED_OUTPUT_RETRIES
beforeEach(() => {
  delete process.env.MAX_STRUCTURED_OUTPUT_RETRIES
})
afterEach(() => {
  if (saved === undefined) delete process.env.MAX_STRUCTURED_OUTPUT_RETRIES
  else process.env.MAX_STRUCTURED_OUTPUT_RETRIES = saved
})

type Fake = ReturnType<typeof createFakeCtx>

async function setup(fakeOpts: FakeCtxOptions = {}, runnerOpts: Partial<OpencodeRunnerOptions> = {}) {
  const fake = createFakeCtx(fakeOpts)
  const registry = createSubmitRegistry(fake.ctx.storage)
  fake.setSubmitTool(createSubmitTool(registry))
  const live = new ChildLiveRegistry()
  await registerIdleHook(fake.ctx as any, { registry, live })
  const runner = createOpencodeRunner(fake.ctx as any, { parentSessionID: fake.parentID, runId: "run1", registry, git: fake.git, live, ...runnerOpts })
  return { fake, registry, runner }
}

function req(prompt: string, opts: AgentOptions = {}, mailbox?: AgentMailbox) {
  const updates: Partial<AgentRecord>[] = []
  const controller = new AbortController()
  const request: AgentRequest = { runId: "run1", index: 0, prompt, opts, signal: controller.signal, onUpdate: (u) => updates.push(u), mailbox }
  return { request, updates, controller }
}

const msg = (text: string): AgentMessage => ({ id: `wm_0_${text.length}`, from: "user", via: "command", text, urgent: false, at: 1 })
const jobKeys = (fake: Fake) => [...fake.storage.keys()].filter((k) => k.startsWith(JOBS_STORAGE_PREFIX))
const idleMarkers = (s: FakeSession) => s.messages.filter((m) => m.type === "idle").length

/** First turn launches a background job that reports after `ms`; the report's turn answers `final`. */
function launching(fake: () => Fake, ms: number, first: Record<string, unknown> = {}, final: Record<string, unknown> = { text: "FINAL WITH SUBAGENT RESULT" }) {
  return ({ turn, session, successor }: { turn: number; session: FakeSession; successor?: boolean }) => {
    if (turn === 0) {
      const job = fake().startBackground(session.info.id, { description: "research" })
      if (ms >= 0) setTimeout(() => void fake().finishBackground(session.info.id, job, "<subagent>found it</subagent>"), ms)
      return { text: "I launched a subagent; waiting for its report.", ...first }
    }
    return successor ? final : { text: "unexpected prompt turn" }
  }
}

describe("X31 background jobs of a workflow child", () => {
  test("X31 a plain agent that launched a background subagent returns the reply after the job's report", async () => {
    let fake!: Fake
    const s = await setup({ respond: launching(() => fake, 40) })
    fake = s.fake
    const r = req("task")
    const out = await s.runner.run(r.request)
    expect(out).toMatchObject({ status: "completed", value: "FINAL WITH SUBAGENT RESULT" })
    const child = fake.children()[0]!
    expect(fake.calls.prompt).toHaveLength(1)
    expect(idleMarkers(child)).toBe(2) // the turn, then the execution the job's report woke
    expect(out.usage.input).toBe(200) // both executions are counted
    expect(r.updates.flatMap((u) => u.warnings ?? [])).toEqual([])
    expect(jobKeys(fake)).toEqual([]) // the report key is removed when the agent settles
  })

  test("X31 a schema agent burns no P21 attempt while its subagent runs", async () => {
    let fake!: Fake
    const s = await setup({ respond: launching(() => fake, 40, {}, { submit: [{ answer: "from subagent" }] }) })
    fake = s.fake
    const out = await s.runner.run(req("compute", { schema: SCHEMA }).request)
    expect(out).toMatchObject({ status: "completed", value: { answer: "from subagent" } })
    expect(fake.calls.prompt).toHaveLength(1)
    expect(fake.calls.synthetic.filter((c) => c.metadata?.workflowNudge !== undefined)).toHaveLength(0)
  })

  test("X31 a message sent while the agent waits for its job stays open and is read in the report's execution", async () => {
    let fake!: Fake
    const mb = new AgentMailbox()
    let posted: Promise<unknown> | undefined
    const s = await setup({
      respond: (input) => {
        if (input.turn === 0) setTimeout(() => void (posted = mb.post(msg("also check the tests"))), 10)
        return launching(() => fake, 60, {}, { textFn: (ss: FakeSession) => (ss.messages.some((m) => m.text?.includes("also check")) ? "SAW MESSAGE" : "no") })(input)
      },
    })
    fake = s.fake
    const out = await s.runner.run(req("task", {}, mb).request)
    expect(await posted).toMatchObject({ ok: true, state: "sent" })
    expect(out).toMatchObject({ status: "completed", value: "SAW MESSAGE" })
    expect(mb.records()[0]!.status).toBe("delivered")
    expect(fake.calls.interrupt).toHaveLength(0)
  })

  test("X31 the wait is capped: a warning, the result as it stands, and a worktree a job may still use is kept", async () => {
    let fake!: Fake
    const s = await setup({ respond: launching(() => fake, -1) }, { backgroundWaitMs: 80 })
    fake = s.fake
    const wt = fake.instance(fake.worktreeDir("wf-run1-0"))
    await registerIdleHook(wt.ctx, { registry: createSubmitRegistry(wt.ctx.storage), live: new ChildLiveRegistry() })
    const r = req("task", { isolation: "worktree" })
    const out = await s.runner.run(r.request)
    expect(out).toMatchObject({ status: "completed", value: "I launched a subagent; waiting for its report." })
    expect(r.updates.some((u) => u.warnings?.some((w) => /background job/.test(w) && /still running/.test(w)))).toBe(true)
    expect(fake.calls.worktreeRemove).toHaveLength(0)
    expect(r.updates.some((u) => typeof u.worktree === "string")).toBe(true)
  })

  test("X31 a stop while waiting for a job stops the agent at once", async () => {
    let fake!: Fake
    const s = await setup({ respond: launching(() => fake, -1) })
    fake = s.fake
    const r = req("task")
    const p = s.runner.run(r.request)
    while (!fake.calls.idleHook.length) await new Promise((res) => setTimeout(res, 2))
    await new Promise((res) => setTimeout(res, 30))
    const t0 = Date.now()
    r.controller.abort()
    expect((await p).status).toBe("stopped")
    expect(Date.now() - t0).toBeLessThan(2_500)
  })

  test("X31 a worktree child: the worktree instance's hook records the job in shared storage and the runner waits", async () => {
    let fake!: Fake
    const s = await setup({ respond: launching(() => fake, 40) })
    fake = s.fake
    const wt = fake.instance(fake.worktreeDir("wf-run1-0"))
    await registerIdleHook(wt.ctx, { registry: createSubmitRegistry(wt.ctx.storage), live: new ChildLiveRegistry() })
    const out = await s.runner.run(req("task", { isolation: "worktree" }).request)
    expect(out).toMatchObject({ status: "completed", value: "FINAL WITH SUBAGENT RESULT" })
    expect(fake.calls.idleHook.every((c) => c.directory === wt.directory)).toBe(true)
    expect(fake.calls.worktreeRemove).toHaveLength(1)
  })

  test("X31 a job report after the agent settled does not recreate its record", async () => {
    let fake!: Fake
    const s = await setup({ respond: launching(() => fake, -1) }, { backgroundWaitMs: 30 })
    fake = s.fake
    await s.runner.run(req("task").request)
    const child = fake.children()[0]!
    expect(jobKeys(fake)).toEqual([])
    await fake.finishBackground(child.info.id, child.background![0]!)
    await new Promise((res) => setTimeout(res, 30))
    await fake.ctx.session.wait({ sessionID: child.info.id })
    expect(jobKeys(fake)).toEqual([])
  })

  test("X31 a descendant's job (not the child's own) does not hold the result", async () => {
    const s = await setup({
      respond: ({ session }) => {
        session.background = [{ kind: "shell", sessionID: "ses_grandchild", command: "sleep 100" }]
        return { text: "done" }
      },
    })
    const t0 = Date.now()
    expect(await s.runner.run(req("task").request)).toMatchObject({ status: "completed", value: "done" })
    expect(Date.now() - t0).toBeLessThan(500)
  })
})
