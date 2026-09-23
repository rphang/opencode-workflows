import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createOpencodeRunner, STRUCTURED_SUBAGENT_PREAMBLE, SUBAGENT_PREAMBLE } from "../../src/opencode/runner.ts"
import { evaluatePermission } from "../../src/opencode/permissions.ts"
import { createSubmitRegistry, createSubmitTool, SUBMIT_STORAGE_PREFIX } from "../../src/opencode/submit.ts"
import { EFFORT_VARIANTS, parseModelRef, resolveChildModel } from "../../src/opencode/model.ts"
import type { AgentOptions, AgentRecord, AgentRequest } from "../../src/types.ts"
import { createFakeCtx, type FakeCtxOptions } from "../helpers/fake-opencode-ctx.ts"

const SCHEMA = {
  type: "object",
  properties: { answer: { type: "string" }, n: { type: "number" } },
  required: ["answer"],
  additionalProperties: false,
}

function setup(fakeOpts: FakeCtxOptions = {}, runnerOpts: Record<string, unknown> = {}) {
  const fake = createFakeCtx(fakeOpts)
  const registry = createSubmitRegistry(fake.ctx.storage)
  fake.setSubmitTool(createSubmitTool(registry))
  const runner = createOpencodeRunner(fake.ctx as any, {
    parentSessionID: fake.parentID,
    runId: "run1",
    registry,
    git: fake.git,
    ...runnerOpts,
  })
  return { fake, registry, runner }
}

function req(prompt: string, opts: AgentOptions = {}, extra: Partial<AgentRequest> = {}) {
  const updates: Partial<AgentRecord>[] = []
  const controller = new AbortController()
  const request: AgentRequest = {
    runId: "run1",
    index: 0,
    prompt,
    opts,
    signal: controller.signal,
    onUpdate: (u) => updates.push(u),
    ...extra,
  }
  return { request, updates, controller }
}

const ENV_KEYS = ["MAX_STRUCTURED_OUTPUT_RETRIES", "OPENCODE_WORKFLOW_AGENT_TIMEOUT_MS"]
const saved: Record<string, string | undefined> = {}
beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
})
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

// ---------------------------------------------------------------------------------------------

describe("model.ts", () => {
  test("parseModelRef splits provider/model#variant on the first slash", () => {
    expect(parseModelRef("openai/gpt-5.4-mini")).toEqual({ providerID: "openai", id: "gpt-5.4-mini" })
    expect(parseModelRef("anthropic/claude-haiku-4-5#high")).toEqual({
      providerID: "anthropic",
      id: "claude-haiku-4-5",
      variant: "high",
    })
    expect(parseModelRef("openrouter/anthropic/claude-3")).toEqual({ providerID: "openrouter", id: "anthropic/claude-3" })
    expect(parseModelRef("haiku")).toBeUndefined()
    expect(parseModelRef("/x")).toBeUndefined()
    expect(parseModelRef("x/")).toBeUndefined()
  })

  test("EFFORT_VARIANTS covers every effort level", () => {
    for (const e of ["low", "medium", "high", "xhigh", "max"] as const) expect(EFFORT_VARIANTS[e][0]).toBe(e)
  })

  test("P25 default is the parent's model; explicit ref overrides; no model.list call needed", async () => {
    const { ctx, calls } = createFakeCtx()
    const parentModel = { providerID: "openai", id: "gpt-5.4-mini", variant: "default" }
    expect(await resolveChildModel(ctx as any, { parentModel })).toEqual({ model: parentModel, warnings: [] })
    expect(await resolveChildModel(ctx as any, { parentModel, requested: "anthropic/claude-haiku-4-5" })).toEqual({
      model: { providerID: "anthropic", id: "claude-haiku-4-5" },
      warnings: [],
    })
    expect(calls.modelList).toBe(0)
  })

  test("P25 bare alias resolves via the model list (parent provider first, newest release)", async () => {
    const { ctx } = createFakeCtx()
    const parentModel = { providerID: "openai", id: "gpt-5.4-mini" }
    const r = await resolveChildModel(ctx as any, { parentModel, requested: "haiku" })
    expect(r.model).toEqual({ providerID: "anthropic", id: "claude-haiku-4-5" })
    const exact = await resolveChildModel(ctx as any, { parentModel, requested: "gpt-5" })
    expect(exact.model).toEqual({ providerID: "openai", id: "gpt-5" })
  })

  test("P25 unknown bare alias falls back to the parent model with a warning", async () => {
    const { ctx } = createFakeCtx()
    const parentModel = { providerID: "openai", id: "gpt-5.4-mini" }
    const r = await resolveChildModel(ctx as any, { parentModel, requested: "nosuchmodel" })
    expect(r.model).toEqual(parentModel)
    expect(r.warnings.join("\n")).toContain("nosuchmodel")
  })

  test("P26 effort maps to a variant the model lists", async () => {
    const { ctx } = createFakeCtx()
    const parentModel = { providerID: "openai", id: "gpt-5.4-mini", variant: "default" }
    const r = await resolveChildModel(ctx as any, { parentModel, effort: "high" })
    expect(r).toEqual({ model: { providerID: "openai", id: "gpt-5.4-mini", variant: "high" }, warnings: [] })
    const max = await resolveChildModel(ctx as any, { parentModel, effort: "max" })
    expect(max.model?.variant).toBe("xhigh")
    const low = await resolveChildModel(ctx as any, { requested: "openai/gpt-5", effort: "low" })
    expect(low.model).toEqual({ providerID: "openai", id: "gpt-5", variant: "low" })
  })

  test("P26 effort is ignored with a warning when the model has no matching variant", async () => {
    const { ctx } = createFakeCtx()
    const r = await resolveChildModel(ctx as any, { requested: "opencode/mimo-v2.6-flash-free", effort: "high" })
    expect(r.model).toEqual({ providerID: "opencode", id: "mimo-v2.6-flash-free" })
    expect(r.warnings.length).toBe(1)
    expect(r.warnings[0]).toContain("effort")
    const xhigh = await resolveChildModel(ctx as any, { requested: "openai/gpt-5", effort: "xhigh" })
    expect(xhigh.model?.variant).toBe("high")
  })

  test("P26 an explicit #variant wins over effort", async () => {
    const { ctx } = createFakeCtx()
    const r = await resolveChildModel(ctx as any, { requested: "openai/gpt-5.4-mini#low", effort: "high" })
    expect(r.model).toEqual({ providerID: "openai", id: "gpt-5.4-mini", variant: "low" })
  })

  test("P26 effort without any known model is ignored with a warning", async () => {
    const { ctx } = createFakeCtx()
    const r = await resolveChildModel(ctx as any, { effort: "high" })
    expect(r.model).toBeUndefined()
    expect(r.warnings.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------------------------

describe("submit.ts", () => {
  test("tool definition: name, JSON-schema input with `output`, codemode off", () => {
    const tool = createSubmitTool(createSubmitRegistry())
    expect(tool.name).toBe("workflow_submit")
    expect((tool.input as any).required).toEqual(["output"])
    expect(tool.options).toMatchObject({ codemode: false })
  })

  test("invalid output returns the validation error as content (no throw), valid output is accepted", async () => {
    const registry = createSubmitRegistry()
    const tool = createSubmitTool(registry)
    await registry.register("s1", SCHEMA)
    const tctx = { sessionID: "s1" } as any
    const bad = await tool.execute({ output: { answer: 1 } }, tctx)
    expect(String(bad.content)).toContain("/answer")
    expect(String(bad.content)).toMatch(/call workflow_submit again/i)
    const ok = await tool.execute({ output: { answer: "x" } }, tctx)
    expect(String(ok.content)).toMatch(/accepted/i)
    const st = await registry.read("s1")
    expect(st?.accepted).toEqual({ value: { answer: "x" } })
    expect(st?.failures).toBe(1)
  })

  test("output passed as a JSON string is parsed before validation", async () => {
    const registry = createSubmitRegistry()
    const tool = createSubmitTool(registry)
    await registry.register("s1", SCHEMA)
    const ok = await tool.execute({ output: '{"answer":"y"}' }, { sessionID: "s1" } as any)
    expect(String(ok.content)).toMatch(/accepted/i)
    expect((await registry.read("s1"))?.accepted).toEqual({ value: { answer: "y" } })
  })

  test("a session without a registered schema gets an explanatory message", async () => {
    const tool = createSubmitTool(createSubmitRegistry())
    const r = await tool.execute({ output: {} }, { sessionID: "nope" } as any)
    expect(String(r.content)).toMatch(/only available to workflow agents/i)
  })

  test("after the retry budget the tool tells the model to stop", async () => {
    process.env.MAX_STRUCTURED_OUTPUT_RETRIES = "2"
    const registry = createSubmitRegistry()
    const tool = createSubmitTool(registry)
    await registry.register("s1", SCHEMA)
    await tool.execute({ output: {} }, { sessionID: "s1" } as any)
    const r = await tool.execute({ output: {} }, { sessionID: "s1" } as any)
    expect(String(r.content)).toMatch(/no attempts left/i)
  })

  test("state is mirrored to storage so another plugin instance (other location) can serve the tool", async () => {
    const storage = new Map<string, unknown>()
    const store = {
      get: async (k: string) => storage.get(k) as any,
      set: async (k: string, v: unknown) => void storage.set(k, v),
      remove: async (k: string) => void storage.delete(k),
    }
    const a = createSubmitRegistry(store)
    const b = createSubmitRegistry(store)
    await a.register("s1", SCHEMA)
    expect(storage.has(SUBMIT_STORAGE_PREFIX + "s1")).toBe(true)
    const r = await createSubmitTool(b).execute({ output: { answer: "z" } }, { sessionID: "s1" } as any)
    expect(String(r.content)).toMatch(/accepted/i)
    expect((await a.read("s1"))?.accepted).toEqual({ value: { answer: "z" } })
    await a.unregister("s1")
    expect(storage.has(SUBMIT_STORAGE_PREFIX + "s1")).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------

describe("createOpencodeRunner", () => {
  test("P20 plain agent: tagged child session, parent model, final text, usage", async () => {
    const { fake, runner } = setup({
      respond: () => ({ text: "hello world", tokens: { input: 10, output: 3, reasoning: 2, cacheRead: 4, cacheWrite: 1 }, cost: 0.5 }),
    })
    const { request, updates } = req("say hi", { label: "greeter", phase: "Greet" }, { index: 3 })
    const out = await runner.run(request)
    expect(out.status).toBe("completed")
    if (out.status !== "completed") return
    expect(out.value).toBe("hello world")
    expect(out.usage).toEqual({ input: 10, output: 3, reasoning: 2, cacheRead: 4, cacheWrite: 1, cost: 0.5 })
    expect(out.sessionID).toBe(fake.children()[0].info.id)
    const create = fake.calls.create[0]
    expect(create.title).toBe("[wf:run1] greeter")
    expect(create.metadata).toEqual({
      workflowRunId: "run1",
      workflowAgentIndex: 3,
      parentSessionID: fake.parentID,
      workflowPhase: "Greet",
    })
    expect(create.model).toEqual({ providerID: "openai", id: "gpt-5.4-mini", variant: "default" })
    expect(create.location).toBeUndefined()
    expect(fake.calls.prompt[0].text).toBe(`${SUBAGENT_PREAMBLE}\n\nsay hi`)
    expect(updates[0]).toEqual({ sessionID: out.sessionID })
  })

  test("P20 last assistant message with text wins; multiple text parts are joined", async () => {
    const { runner } = setup({
      respond: ({ session }) => {
        session.messages.push({ type: "assistant", content: [{ type: "text", text: "old" }] })
        return { text: "new" }
      },
    })
    const out = await runner.run(req("x").request)
    expect(out.status === "completed" && out.value).toBe("new")
  })

  test("P62 default title uses the first prompt line when no label", async () => {
    const { fake, runner } = setup()
    await runner.run(req("Review the file\nwith details").request)
    expect(fake.calls.create[0].title).toBe("[wf:run1] Review the file")
  })

  test("P60/P61/P63 permissions: parent rules copied, then question, workflow and workflow_submit denied", async () => {
    const parentRules = [{ action: "edit", resource: "*", effect: "deny" }]
    const { fake, runner } = setup({ parent: { permissions: parentRules } })
    await runner.run(req("x").request)
    expect(fake.calls.create[0].permissions).toEqual([
      ...parentRules,
      { action: "question", resource: "*", effect: "deny" },
      { action: "workflow", resource: "*", effect: "deny" },
      { action: "workflow_submit", resource: "*", effect: "deny" },
    ])
  })

  test("P60 extra denied tools are configurable", async () => {
    const { fake, runner } = setup({}, { deniedTools: ["workflow", "workflow_control"] })
    await runner.run(req("x").request)
    const actions = fake.calls.create[0].permissions.map((r: any) => `${r.action}:${r.effect}`)
    expect(actions).toEqual(["question:deny", "workflow:deny", "workflow_control:deny", "workflow_submit:deny"])
  })

  test("P27 agentType selects the child agent", async () => {
    const { fake, runner } = setup()
    await runner.run(req("x", { agentType: "explore" }).request)
    expect(fake.calls.create[0].agent).toBe("explore")
  })

  test("P61 without parentAgent the parent's stored Session.Info.agent is inherited", async () => {
    const { fake, runner } = setup({ parent: { agent: "plan" } })
    await runner.run(req("x").request)
    expect(fake.calls.create[0].agent).toBe("plan")
  })

  test("P61 parentAgent option wins over the stored agent; primary agentType fails before any session", async () => {
    const { fake, runner } = setup({ parent: { agent: "build" } }, { parentAgent: "plan" })
    const out = await runner.run(req("x", { agentType: "build" }).request)
    expect(out.status).toBe("failed")
    expect((out as { error?: string }).error).toMatch(/primary agent/)
    expect(fake.calls.create.length).toBe(0)
  })

  test("P61 evaluatePermission mirrors opencode: last match wins, wildcards, default ask", () => {
    const rules = [
      { action: "subagent", resource: "*", effect: "allow" as const },
      { action: "subagent", resource: "exp*", effect: "deny" as const },
    ]
    expect(evaluatePermission("subagent", "explore", rules)).toBe("deny")
    expect(evaluatePermission("subagent", "general", rules)).toBe("allow")
    expect(evaluatePermission("edit", "x", rules)).toBe("ask")
  })

  test("P25 opts.model overrides the model", async () => {
    const { fake, runner } = setup()
    await runner.run(req("x", { model: "anthropic/claude-haiku-4-5#max" }).request)
    expect(fake.calls.create[0].model).toEqual({ providerID: "anthropic", id: "claude-haiku-4-5", variant: "max" })
  })

  test("P26 effort maps to variant; unsupported effort reports a warning via onUpdate", async () => {
    const { fake, runner } = setup()
    await runner.run(req("x", { effort: "medium" }).request)
    expect(fake.calls.create[0].model).toEqual({ providerID: "openai", id: "gpt-5.4-mini", variant: "medium" })
    const r = req("y", { effort: "high", model: "opencode/mimo-v2.6-flash-free" })
    await runner.run(r.request)
    expect(fake.calls.create[1].model).toEqual({ providerID: "opencode", id: "mimo-v2.6-flash-free" })
    const w = r.updates.find((u) => u.warnings)
    expect(w?.warnings?.[0]).toContain("effort")
  })

  test("P25 getParent option supplies the parent session instead of session.get", async () => {
    const { fake, runner } = setup(
      {},
      { getParent: async () => ({ model: { providerID: "anthropic", id: "claude-haiku-4" }, permissions: [] }) },
    )
    await runner.run(req("x").request)
    expect(fake.calls.parentGet).toBe(0)
    expect(fake.calls.create[0].model).toEqual({ providerID: "anthropic", id: "claude-haiku-4" })
  })

  test("parent lookup failure still runs the agent on the default model, with a warning", async () => {
    const { fake, runner } = setup({ getParentError: "gone" })
    const r = req("x")
    const out = await runner.run(r.request)
    expect(out.status).toBe("completed")
    expect(fake.calls.create[0].model).toBeUndefined()
    expect(r.updates.some((u) => u.warnings?.some((w) => w.includes("gone")))).toBe(true)
  })

  // ------------------------------------------------------------------ structured output

  test("P21 schema: submit tool allowed, instructions appended, validated object returned", async () => {
    const { fake, runner, registry } = setup({ respond: () => ({ submit: [{ answer: "42" }], text: "" }) })
    const out = await runner.run(req("compute", { schema: SCHEMA }).request)
    expect(out).toMatchObject({ status: "completed", value: { answer: "42" } })
    const perms = fake.calls.create[0].permissions
    expect(perms.at(-1)).toEqual({ action: "workflow_submit", resource: "*", effect: "allow" })
    expect(perms.some((r: any) => r.action === "workflow_submit" && r.effect === "deny")).toBe(false)
    expect(fake.calls.prompt[0].text).toStartWith(`${STRUCTURED_SUBAGENT_PREAMBLE}\n\ncompute\n\n`)
    expect(fake.calls.prompt[0].text).toContain("workflow_submit")
    expect(fake.calls.prompt).toHaveLength(1)
    // registry cleaned up
    expect(await registry.read(out.sessionID!)).toBeUndefined()
    expect([...fake.storage.keys()].filter((k) => k.startsWith(SUBMIT_STORAGE_PREFIX))).toEqual([])
  })

  test("P21 invalid then valid submission in the same turn succeeds without re-prompt", async () => {
    const { fake, runner } = setup({ respond: () => ({ submit: [{ answer: 1 }, { answer: "ok" }] }) })
    const out = await runner.run(req("x", { schema: SCHEMA }).request)
    expect(out).toMatchObject({ status: "completed", value: { answer: "ok" } })
    expect(String(fake.calls.submitResults[0].result.content)).toContain("/answer")
    expect(fake.calls.prompt).toHaveLength(1)
  })

  test("P21 no submission: re-prompts, then succeeds when the model submits", async () => {
    const { fake, runner } = setup({
      respond: ({ turn }) => (turn === 0 ? { text: "I think the answer is 42" } : { submit: [{ answer: "42" }] }),
    })
    const out = await runner.run(req("x", { schema: SCHEMA }).request)
    expect(out).toMatchObject({ status: "completed", value: { answer: "42" } })
    expect(fake.calls.prompt).toHaveLength(2)
    expect(fake.calls.prompt[1].text).toContain("workflow_submit")
  })

  test("P21 retries exhausted -> falls back to JSON in the last reply", async () => {
    process.env.MAX_STRUCTURED_OUTPUT_RETRIES = "2"
    const { fake, runner } = setup({ respond: () => ({ text: 'Here:\n```json\n{"answer":"from-text"}\n```' }) })
    const out = await runner.run(req("x", { schema: SCHEMA }).request)
    expect(out).toMatchObject({ status: "completed", value: { answer: "from-text" } })
    expect(fake.calls.prompt).toHaveLength(2)
  })

  test("P21 retries exhausted with invalid output -> schema_failed naming the last validation failure", async () => {
    process.env.MAX_STRUCTURED_OUTPUT_RETRIES = "3"
    const { fake, runner } = setup({ respond: () => ({ submit: [{ answer: 7 }], text: "done" }) })
    const out = await runner.run(req("x", { schema: SCHEMA }).request)
    expect(out.status).toBe("schema_failed")
    if (out.status !== "schema_failed") return
    expect(out.error).toContain("structured output failed validation after 3 attempts")
    expect(out.error).toContain("/answer")
    expect(fake.calls.prompt).toHaveLength(3)
    expect(out.usage.input).toBe(300)
  })

  test("P21 failures within one turn count against the budget (no endless re-prompting)", async () => {
    process.env.MAX_STRUCTURED_OUTPUT_RETRIES = "3"
    const { fake, runner } = setup({ respond: () => ({ submit: [{}, {}, {}, {}] }) })
    const out = await runner.run(req("x", { schema: SCHEMA }).request)
    expect(out.status).toBe("schema_failed")
    expect(fake.calls.prompt).toHaveLength(1)
  })

  test("P21 submission made through another plugin instance (shared storage) is picked up", async () => {
    const fake = createFakeCtx({ respond: () => ({ submit: [{ answer: "remote" }] }) })
    const local = createSubmitRegistry(fake.ctx.storage)
    const remote = createSubmitRegistry(fake.ctx.storage)
    fake.setSubmitTool(createSubmitTool(remote))
    const runner = createOpencodeRunner(fake.ctx as any, {
      parentSessionID: fake.parentID,
      runId: "run1",
      registry: local,
      git: fake.git,
    })
    const out = await runner.run(req("x", { schema: SCHEMA }).request)
    expect(out).toMatchObject({ status: "completed", value: { answer: "remote" } })
  })

  // ------------------------------------------------------------------ failures / abort

  test("P23 abort mid-run interrupts the child session and returns stopped", async () => {
    const { fake, runner } = setup({ respond: () => ({ hang: true, text: "partial" }) })
    const r = req("x")
    const p = runner.run(r.request)
    while (fake.calls.prompt.length === 0) await Bun.sleep(1)
    await Bun.sleep(5)
    r.controller.abort()
    const out = await p
    expect(out.status).toBe("stopped")
    expect(out.sessionID).toBe(fake.children()[0].info.id)
    expect(fake.calls.interrupt).toEqual([{ sessionID: out.sessionID }])
  })

  test("P23 already-aborted signal: nothing is created", async () => {
    const { fake, runner } = setup()
    const r = req("x")
    r.controller.abort()
    const out = await runner.run(r.request)
    expect(out.status).toBe("stopped")
    expect(fake.calls.create).toHaveLength(0)
  })

  test("P23 terminal failure (outcome failed) -> failed with the assistant error message", async () => {
    const { runner } = setup({
      respond: () => ({ outcome: "failed", error: { type: "api", message: "rate limited" } }),
    })
    const out = await runner.run(req("x").request)
    expect(out.status).toBe("failed")
    if (out.status === "failed") expect(out.error).toContain("rate limited")
  })

  test("P23 failed turn with no assistant message (bad model) -> failed", async () => {
    const { runner } = setup({ respond: () => ({ outcome: "failed", noAssistant: true }) })
    const out = await runner.run(req("x").request)
    expect(out.status).toBe("failed")
    if (out.status === "failed") expect(out.error).toMatch(/failed/)
  })

  test("P51 child interrupted from outside (not our abort) counts as failed", async () => {
    const { fake, runner } = setup({ respond: () => ({ hang: true }) })
    const p = runner.run(req("x").request)
    while (fake.calls.prompt.length === 0) await Bun.sleep(1)
    await Bun.sleep(5)
    await fake.ctx.session.interrupt({ sessionID: fake.children()[0].info.id })
    const out = await p
    expect(out.status).toBe("failed")
    if (out.status === "failed") expect(out.error).toMatch(/interrupted/)
  })

  test("empty reply is a failure, not an empty string", async () => {
    const { runner } = setup({ respond: () => ({}) })
    const out = await runner.run(req("x").request)
    expect(out.status).toBe("failed")
    if (out.status === "failed") expect(out.error).toMatch(/no text/)
  })

  test("session.create throwing -> failed", async () => {
    const { runner } = setup({ createError: "boom" })
    const out = await runner.run(req("x").request)
    expect(out).toMatchObject({ status: "failed" })
    if (out.status === "failed") expect(out.error).toContain("boom")
  })

  test("OPENCODE_WORKFLOW_AGENT_TIMEOUT_MS interrupts and fails the agent", async () => {
    process.env.OPENCODE_WORKFLOW_AGENT_TIMEOUT_MS = "30"
    const { fake, runner } = setup({ respond: () => ({ hang: true }) })
    const out = await runner.run(req("x").request)
    expect(out.status).toBe("failed")
    if (out.status === "failed") expect(out.error).toMatch(/timed out after 30ms/)
    expect(fake.calls.interrupt).toHaveLength(1)
  })

  // ------------------------------------------------------------------ worktree

  test("P28 isolation worktree: runs in a fresh worktree, removed when unchanged", async () => {
    const { fake, runner } = setup()
    const r = req("x", { isolation: "worktree" }, { index: 2 })
    const out = await runner.run(r.request)
    expect(out.status).toBe("completed")
    expect(fake.calls.worktreeCreate).toEqual([{ projectID: fake.projectID, name: "wf-run1-2" }])
    const dir = fake.calls.create[0].location.directory
    expect(dir).toContain("wf-run1-2")
    expect(fake.calls.worktreeRemove).toEqual([{ projectID: fake.projectID, directory: dir, force: false }])
    expect(r.updates.some((u) => u.worktree)).toBe(false)
  })

  test("P28 worktree with changes is kept and its path reported", async () => {
    const { fake, runner } = setup({ respond: () => ({ text: "edited", writeFile: true }) })
    const r = req("x", { isolation: "worktree" })
    const out = await runner.run(r.request)
    expect(out.status).toBe("completed")
    expect(fake.calls.worktreeRemove).toHaveLength(0)
    const dir = fake.calls.create[0].location.directory
    expect(r.updates.find((u) => u.worktree)?.worktree).toBe(dir)
  })

  test("P28 worktree creation failure -> failed (no session created)", async () => {
    const { fake, runner } = setup({ worktreeCreateError: "not a git repo" })
    const out = await runner.run(req("x", { isolation: "worktree" }).request)
    expect(out.status).toBe("failed")
    if (out.status === "failed") expect(out.error).toContain("not a git repo")
    expect(fake.calls.create).toHaveLength(0)
  })

  test("P28 git failure while checking changes keeps the worktree (safe default)", async () => {
    const { fake, runner } = setup(
      {},
      {
        git: async (args: string[]) => {
          if (args[0] === "rev-parse") return "abc\n"
          throw new Error("git missing")
        },
      },
    )
    const out = await runner.run(req("x", { isolation: "worktree" }).request)
    expect(out.status).toBe("completed")
    expect(fake.calls.worktreeRemove).toHaveLength(0)
  })

  test("P28 worktree is cleaned up after an aborted agent too", async () => {
    const { fake, runner } = setup({ respond: () => ({ hang: true }) })
    const r = req("x", { isolation: "worktree" })
    const p = runner.run(r.request)
    while (fake.calls.prompt.length === 0) await Bun.sleep(1)
    r.controller.abort()
    expect((await p).status).toBe("stopped")
    expect(fake.calls.worktreeRemove).toHaveLength(1)
  })
})
