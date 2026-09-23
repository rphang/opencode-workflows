// Parity: subagent semantics (P60–P62), through the plugin with the REAL opencode runner over the
// fake opencode ctx (child sessions are created with ctx.session.create).

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { agentKey } from "../../src/journal.ts"
import { evaluatePermission } from "../../src/opencode/permissions.ts"
import { STRUCTURED_SUBAGENT_PREAMBLE, SUBAGENT_PREAMBLE } from "../../src/opencode/runner.ts"
import { createHarness, script, type Harness } from "../helpers/plugin-harness.ts"

let h: Harness
beforeEach(async () => {
  h = await createHarness()
})
afterEach(async () => {
  await h.dispose()
})

const denies = (create: any) => create.permissions.filter((r: any) => r.effect === "deny").map((r: any) => r.action)

describe("P60 no nested launches", () => {
  test("P60 the `workflow` tool (and workflow_control) is denied in every child session", async () => {
    const p = await h.setup({ real: true })
    await p.call({ script: script(`await agent("a"); return await agent("b", { schema: { type: "object" } })`) })
    await p.notification(0)
    expect(p.fake.calls.create.length).toBe(2)
    for (const c of p.fake.calls.create) {
      expect(denies(c)).toContain("workflow")
      expect(denies(c)).toContain("workflow_control")
      expect(c.permissions.find((r: any) => r.action === "workflow")).toEqual({ action: "workflow", resource: "*", effect: "deny" })
    }
  })

  test("P60 the deny rules come after inherited rules, so a parent `allow workflow` cannot re-enable it", async () => {
    const p = await h.setup({
      real: true,
      fake: { parent: { permissions: [{ action: "workflow", resource: "*", effect: "allow" }] } },
    })
    await p.call({ script: script(`return await agent("a")`) })
    await p.notification(0)
    const perms = p.fake.calls.create[0].permissions as any[]
    const allowAt = perms.findIndex((r) => r.action === "workflow" && r.effect === "allow")
    const denyAt = perms.findIndex((r) => r.action === "workflow" && r.effect === "deny")
    expect(allowAt).toBeGreaterThanOrEqual(0)
    expect(denyAt).toBeGreaterThan(allowAt) // later rules win in opencode
  })
})

describe("P61 inherited permissions", () => {
  test("P61 DEGRADED: child sessions get the parent's permission rules copied at create time", async () => {
    const parentRules = [
      { action: "bash", resource: "rm *", effect: "deny" },
      { action: "edit", resource: "*", effect: "ask" },
      { action: "webfetch", resource: "*", effect: "allow" },
    ]
    const p = await h.setup({ real: true, fake: { parent: { permissions: parentRules } } })
    await p.call({ script: script(`return await parallel([() => agent("a"), () => agent("b")])`) })
    await p.notification(0)
    for (const c of p.fake.calls.create) expect(c.permissions.slice(0, 3)).toEqual(parentRules)
  })

  test("P61 DEGRADED: a parent without session rules yields only the workflow deny rules", async () => {
    const p = await h.setup({ real: true })
    await p.call({ script: script(`return await agent("a")`) })
    await p.notification(0)
    const perms = p.fake.calls.create[0].permissions as any[]
    expect(perms.every((r) => ["workflow", "workflow_control", "workflow_submit", "question"].includes(r.action))).toBe(true)
  })
})

describe("P63 workflow agents never wait on a prompt nobody sees", () => {
  test("P63 the `question` tool is denied in every child, after inherited rules (a parent allow cannot re-enable it)", async () => {
    const p = await h.setup({
      real: true,
      fake: { parent: { permissions: [{ action: "question", resource: "*", effect: "allow" }] } },
    })
    await p.call({ script: script(`return await parallel([() => agent("a"), () => agent("b", { schema: { type: "object" } })])`) })
    await p.notification(0)
    expect(p.fake.calls.create.length).toBe(2)
    for (const c of p.fake.calls.create) {
      expect(evaluatePermission("question", "*", c.permissions)).toBe("deny")
      const allowAt = c.permissions.findIndex((r: any) => r.action === "question" && r.effect === "allow")
      const denyAt = c.permissions.findIndex((r: any) => r.action === "question" && r.effect === "deny")
      expect(denyAt).toBeGreaterThan(allowAt)
    }
  })

  test("P63 an `ask` evaluated for a workflow child becomes `deny` with an explanation; allow/deny and other sessions are untouched", async () => {
    let child = ""
    const p = await h.setup({
      real: true,
      fake: {
        respond: ({ sessionID }) => {
          child = sessionID
          return { hang: true }
        },
      },
    })
    expect(p.fake.permissionHooks.some((x) => x.name === "evaluate")).toBe(true)
    const out = await p.call({ script: script(`return await agent("read C:/Windows/win.ini")`) })
    const t0 = Date.now()
    while (!child && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 5))
    expect(child).not.toBe("")

    const ask = await p.fake.evaluatePermission({ sessionID: child, action: "external_directory", resources: ["C:/Windows/*"], effect: "ask" })
    expect(ask.effect).toBe("deny")
    expect(ask.message).toMatch(/workflow agent/i)
    expect(ask.message).toMatch(/cannot ask/i)
    const allow = await p.fake.evaluatePermission({ sessionID: child, action: "read", resources: ["a.ts"], effect: "allow" })
    expect(allow.effect).toBe("allow")
    expect(allow.message).toBeUndefined()
    const parent = await p.fake.evaluatePermission({ sessionID: p.fake.parentID, action: "external_directory", resources: ["C:/Windows/*"], effect: "ask" })
    expect(parent.effect).toBe("ask")
    const unknown = await p.fake.evaluatePermission({ sessionID: "ses_gone", action: "bash", resources: ["ls"], effect: "ask" })
    expect(unknown.effect).toBe("ask")

    await p.control({ action: "stop", runId: out.runId })
    await p.notification(0)
  })

  test("P63 the evaluate hook is removed when the plugin is disposed", async () => {
    const p = await h.setup({ real: true })
    expect(p.fake.permissionHooks.length).toBe(1)
    await p.cleanup!()
    expect(p.fake.permissionHooks.length).toBe(0)
  })
})

describe("P62 tagged child sessions", () => {
  test("P62 child sessions carry a `[wf:<runId>]` title prefix and {workflowRunId, workflowAgentIndex, parentSessionID, workflowPhase} metadata", async () => {
    const p = await h.setup({ real: true })
    const out = await p.call({ script: script(`phase("Scan"); await agent("first task"); return await agent("second task", { label: "two" })`) })
    await p.notification(0)
    const [a, b] = p.fake.calls.create
    expect(a.title).toBe(`[wf:${out.runId}] first task`)
    expect(b.title).toBe(`[wf:${out.runId}] two`)
    expect(a.metadata).toEqual({ workflowRunId: out.runId, workflowAgentIndex: 0, parentSessionID: p.fake.parentID, workflowPhase: "Scan" })
    expect(b.metadata.workflowAgentIndex).toBe(1)
  })

  test("P62 the child session id is recorded on the agent and shown in the status view", async () => {
    const p = await h.setup({ real: true })
    const out = await p.call({ script: script(`return await agent("x")`) })
    await p.notification(0)
    await p.settled(out.runId!)
    const child = p.fake.children()[0]!.info.id
    expect((await h.store.readAgentRecord(out.runId!, 0))?.sessionID).toBe(child)
    expect(await p.control({ action: "status", runId: out.runId })).toContain(child)
  })
})

describe("P61 agent inheritance and agentType restrictions", () => {
  const evaluate = (rules: any[], action: string, resource: string) => evaluatePermission(action, resource, rules)

  test("P61 children run as the parent's current agent: a Plan-mode launch gets `plan` children (edit denied)", async () => {
    const p = await h.setup({ real: true })
    await p.call({ script: script(`return await agent("a")`) }, undefined, "plan")
    await p.notification(0)
    expect(p.fake.calls.create[0].agent).toBe("plan")
    expect(p.fake.children()[0]!.info.agent).toBe("plan")
  })

  test("P61 children of a build session run as build (no extra rules copied)", async () => {
    const p = await h.setup({ real: true })
    await p.call({ script: script(`return await agent("a")`) })
    await p.notification(0)
    expect(p.fake.calls.create[0].agent).toBe("build")
    // Only the plugin's own denies (P60 workflow tools, P63 question): nothing copied from the agent.
    expect(p.fake.calls.create[0].permissions.every((r: any) => r.action.startsWith("workflow") || r.action === "question")).toBe(true)
  })

  test("P61 agentType naming a primary-mode agent is refused (agent() returns null, no child session)", async () => {
    const p = await h.setup({ real: true })
    const out = await p.call({ script: script(`return await agent("a", { agentType: "build" })`) }, undefined, "plan")
    expect(p.resultOf(await p.notification(0))).toBeNull()
    expect(p.fake.calls.create.length).toBe(0)
    await p.settled(out.runId!)
    expect(await p.control({ action: "status", runId: out.runId })).toMatch(/cannot run as a subagent/)
  })

  test("P61 agentType naming an unknown agent is refused", async () => {
    const p = await h.setup({ real: true })
    const out = await p.call({ script: script(`return await agent("a", { agentType: "ghost" })`) })
    expect(p.resultOf(await p.notification(0))).toBeNull()
    expect(p.fake.calls.create.length).toBe(0)
    await p.settled(out.runId!)
    expect(await p.control({ action: "status", runId: out.runId })).toMatch(/unknown agent "ghost"/)
  })

  test("P61 the parent's `subagent` deny rules apply to agentType", async () => {
    const p = await h.setup({ real: true, fake: { parent: { permissions: [{ action: "subagent", resource: "explore", effect: "deny" }] } } })
    const out = await p.call({ script: script(`return [await agent("a", { agentType: "explore" }), await agent("b", { agentType: "general" })]`) })
    expect(p.resultOf(await p.notification(0))).toEqual([null, "ok"])
    expect(p.fake.calls.create.map((c: any) => c.agent)).toEqual(["general"])
    await p.settled(out.runId!)
    expect(await p.control({ action: "status", runId: out.runId })).toMatch(/denied/)
  })

  test("P61 a different agentType keeps the parent agent's deny/ask rules (Plan-mode edit deny survives)", async () => {
    const p = await h.setup({ real: true })
    await p.call({ script: script(`return await agent("a", { agentType: "general" })`) }, undefined, "plan")
    await p.notification(0)
    const c = p.fake.calls.create[0]
    expect(c.agent).toBe("general")
    expect(evaluate(c.permissions, "edit", "src/a.ts")).toBe("deny")
    // plan's allow rules are not copied: they could widen the chosen agent's own restrictions.
    expect(c.permissions.some((r: any) => r.action === "question" && r.effect === "allow")).toBe(false)
  })
})

describe("P78 subagent framing", () => {
  test("P78 every child prompt starts with the non-interactive subagent preamble, then the script's prompt", async () => {
    const p = await h.setup({ real: true })
    await p.call({ script: script(`return [await agent("plain task"), await agent("typed task", { schema: { type: "object" } })]`) })
    await p.notification(0)
    const [plain, typed] = p.fake.calls.prompt.map((c: any) => String(c.text))
    expect(plain).toBe(`${SUBAGENT_PREAMBLE}\n\nplain task`)
    // Schema agents get the structured variant, then the task, then the workflow_submit instructions.
    expect(typed!.startsWith(`${STRUCTURED_SUBAGENT_PREAMBLE}\n\ntyped task\n\n`)).toBe(true)
    expect(typed!.indexOf("## Required output format")).toBeGreaterThan(typed!.indexOf("typed task"))
  })

  test("P78 both preambles say: non-interactive, no questions, answer returned as data, no workflows; under 10 lines", () => {
    for (const pre of [SUBAGENT_PREAMBLE, STRUCTURED_SUBAGENT_PREAMBLE]) {
      expect(pre).toMatch(/subagent/)
      expect(pre).toMatch(/non-interactively/)
      expect(pre).toMatch(/workflow script/)
      expect(pre).toMatch(/[Nn]o human/)
      expect(pre).toMatch(/do not ask questions or ask for confirmation/i)
      expect(pre).toMatch(/assumption/)
      expect(pre).toMatch(/returned .*to the script as data/)
      expect(pre).toMatch(/cannot launch workflows/)
      expect(pre.split("\n").length).toBeLessThan(10)
    }
    expect(SUBAGENT_PREAMBLE).toMatch(/FINAL message is returned verbatim/)
    expect(SUBAGENT_PREAMBLE).toMatch(/no greetings/)
  })

  test("P78 the plain preamble keeps assumption notes out of the returned data unless the format has room for them", () => {
    expect(SUBAGENT_PREAMBLE).not.toMatch(/state them briefly/)
    expect(SUBAGENT_PREAMBLE).toMatch(/only if the requested format has room/)
    // The plain preamble has no structured-output wording; the structured one has no "final text answer".
    expect(SUBAGENT_PREAMBLE).not.toMatch(/structured-output tool/)
    expect(STRUCTURED_SUBAGENT_PREAMBLE).not.toMatch(/final text answer/i)
    expect(STRUCTURED_SUBAGENT_PREAMBLE).toMatch(/workflow_submit/)
  })

  // Regression guard: agentKey is computed by the engine from the script's prompt before the runner
  // adds the preamble, so this passed before P78 too; it fails if the preamble ever leaks into the key.
  test("P78 the preamble is not part of the resume key: journal keys hash the script's prompt only, and resume hits the cache", async () => {
    const p = await h.setup({ real: true })
    const src = script(`return await agent("keyed task", { label: "k" })`)
    const first = await p.call({ script: src })
    await p.notification(0)
    await p.settled(first.runId!)
    const journal = await h.store.readJournal(first.runId!)
    expect(journal.map((e) => e.key)).toEqual([agentKey("keyed task", { label: "k" })])
    const creates = p.fake.calls.create.length
    const second = await p.call({ script: src, resumeFromRunId: first.runId })
    expect(second.error).toBeUndefined()
    await p.notification(1)
    expect(p.fake.calls.create.length).toBe(creates) // replayed from the journal, no new child
  })
})
