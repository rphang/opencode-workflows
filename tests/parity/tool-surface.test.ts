// Parity: tool surface (P01–P06), through the plugin's `workflow` tool over a fake opencode ctx, and
// the freeform `workflow_script` tool (X24).

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { AUTHORING_REFERENCE, TOOL_DESCRIPTION } from "../../src/authoring.ts"
import { isRunActive } from "../../src/engine.ts"
import { WORKFLOW_INPUT_SCHEMA } from "../../src/plugin/tools.ts"
import { FakeRunner, sleep } from "../helpers/fake-runner.ts"
import { createHarness, script, SESSION, tag, tctx, visibleTools, type Harness } from "../helpers/plugin-harness.ts"

let h: Harness
beforeEach(async () => {
  h = await createHarness()
})
afterEach(async () => {
  await h.dispose()
})

describe("P01 tool input", () => {
  test("P01 tool is named `workflow` and accepts {script, name, scriptPath, args, resumeFromRunId, title, description}", async () => {
    const p = await h.setup()
    const tool = p.tools().get("workflow")!
    expect(tool).toBeTruthy()
    const props = Object.keys(tool.input.properties)
    for (const k of ["script", "name", "scriptPath", "args", "resumeFromRunId", "title", "description"]) expect(props).toContain(k)
  })

  test("P01 at least one of script/name/scriptPath is required (nothing runs)", async () => {
    const p = await h.setup()
    const out = await p.call({ args: [1, 2], title: "t" })
    expect(out.status).toBe("async_launched")
    expect(out.error).toMatch(/script, name, or scriptPath/)
    await sleep(20)
    expect(p.runner.calls.length).toBe(0)
    expect(p.notifications().length).toBe(0)
  })

  test("P01 scriptPath takes precedence over script and name", async () => {
    const p = await h.setup()
    const file = join(h.projectDir, "mine.js")
    writeFileSync(file, script(`return "from-file"`, `{ name: "file-wf", description: "from file" }`))
    const out = await p.call({ scriptPath: file, script: script(`return "inline"`), name: "deep-research" })
    expect(out.error).toBeUndefined()
    expect(out.workflowName).toBe("file-wf")
    expect(p.resultOf(await p.notification(0))).toBe("from-file")
  })

  test("P01 script takes precedence over name", async () => {
    const p = await h.setup()
    const out = await p.call({ script: script(`return "inline"`), name: "deep-research" })
    expect(out.workflowName).toBe("t-wf")
    expect(p.resultOf(await p.notification(0))).toBe("inline")
  })

  test("P01 name runs a saved workflow", async () => {
    mkdirSync(join(h.projectDir, ".opencode", "workflows"), { recursive: true })
    writeFileSync(join(h.projectDir, ".opencode", "workflows", "g.js"), script(`return "hi " + args`, `{ name: "greet", description: "greets" }`))
    const p = await h.setup()
    const out = await p.call({ name: "greet", args: "ann" })
    expect(out.error).toBeUndefined()
    expect(out.workflowName).toBe("greet")
    expect(p.resultOf(await p.notification(0))).toBe("hi ann")
  })

  test("P01 the `workflow` tool's schema, options and base description stay byte-identical (Claude Code parity, prompt caching)", async () => {
    // A change here is a deliberate parity / prompt-cache decision: update the hashes in the same commit.
    // The freeform workflow_script tool (X24) is a separate tool and must not touch this one.
    const sha = (v: string) => createHash("sha256").update(v).digest("hex")
    expect(sha(JSON.stringify(WORKFLOW_INPUT_SCHEMA))).toBe("67ede3b7265cc247f9ba6d80828bcd6dd61190deff4e04839cd9d3a795104ac9")
    expect(sha(TOOL_DESCRIPTION)).toBe("6abf884cd52b7e936700c175dc03cc7adc6ec84c3e9d592bc97889e7ffbae954")
    for (const options of [{}, { freeformTool: false }]) {
      const p = await h.setup({ options })
      const tool = p.tools().get("workflow")!
      expect(tool.input).toEqual(WORKFLOW_INPUT_SCHEMA)
      expect(tool.options).toEqual({ codemode: false })
      expect(tool.freeform).toBeUndefined()
      expect(tool.description.startsWith(TOOL_DESCRIPTION)).toBe(true)
      expect(tool.description).not.toContain("workflow_script")
    }
  })

  test("P01 title and description inputs are ignored (meta decides the name and description)", async () => {
    const p = await h.setup()
    const out = await p.call({ script: script(`return 1`), title: "Other title", description: "other description" })
    expect(out.workflowName).toBe("t-wf")
    const n = await p.notification(0)
    expect(n.text).toContain(`Dynamic workflow "test workflow" completed`)
    expect(n.text).not.toContain("other description")
  })
})

describe("P02 output", () => {
  test("P02 output shape is {status:'async_launched', taskId, taskType:'local_workflow', workflowName, runId, summary, transcriptDir, scriptPath}", async () => {
    const p = await h.setup()
    const out = await p.call({ script: script(`return 1`) })
    expect(out.status).toBe("async_launched")
    expect(out.taskType).toBe("local_workflow")
    expect(typeof out.taskId).toBe("string")
    expect(out.workflowName).toBe("t-wf")
    expect(out.runId).toMatch(/^wf_/)
    expect(typeof out.summary).toBe("string")
    expect(out.summary).toContain(out.runId!)
    expect(typeof out.transcriptDir).toBe("string")
    expect(typeof out.scriptPath).toBe("string")
    expect(out.error).toBeUndefined()
    const allowed = ["status", "taskId", "taskType", "workflowName", "runId", "summary", "transcriptDir", "scriptPath", "warning", "error"]
    for (const k of Object.keys(out)) expect(allowed).toContain(k)
  })

  test("P02 returns immediately while agents are still running in the background", async () => {
    const runner = new FakeRunner().on("slow", { hold: true })
    const p = await h.setup({ runner })
    const t0 = Date.now()
    const out = await p.call({ script: script(`return await agent("slow work")`) })
    expect(Date.now() - t0).toBeLessThan(2000)
    await runner.waitForHeld(1)
    expect(isRunActive(out.runId!)).toBe(true)
    expect(p.notifications().length).toBe(0)
    runner.release()
    expect(p.resultOf(await p.notification(0))).toBe("done: slow work")
  })

  test("P02 parse warnings are surfaced as `warning`", async () => {
    const p = await h.setup()
    const out = await p.call({
      script: script(`phase("Unlisted"); return 1`, `{ name: "w", description: "d", phases: [{ title: "Plan" }] }`),
    })
    expect(out.error).toBeUndefined()
    expect(out.warning).toMatch(/Unlisted/)
  })
})

describe("P03 static check failures", () => {
  test("P03 a syntax error returns async_launched WITH error and never runs", async () => {
    const p = await h.setup()
    const out = await p.call({ script: script(`const x = ;\nawait agent("a")`) })
    expect(out.status).toBe("async_launched")
    expect(out.taskType).toBe("local_workflow")
    expect(out.error).toMatch(/SyntaxError/)
    await sleep(30)
    expect(p.runner.calls.length).toBe(0)
    expect(p.notifications().length).toBe(0)
  })

  test("P03 a failing meta check returns error and never runs", async () => {
    const p = await h.setup()
    const out = await p.call({ script: `await agent("a")\nreturn 1` })
    expect(out.status).toBe("async_launched")
    expect(out.error).toMatch(/export const meta/)
    await sleep(30)
    expect(p.runner.calls.length).toBe(0)
  })
})

describe("P04 script persistence", () => {
  test("P04 every invocation persists the script and returns its path", async () => {
    const p = await h.setup()
    const src = script(`return "v1"`)
    const out = await p.call({ script: src })
    expect(existsSync(out.scriptPath!)).toBe(true)
    expect(readFileSync(out.scriptPath!, "utf8")).toBe(src)
    expect(out.scriptPath!.startsWith(out.transcriptDir!)).toBe(true)
  })

  test("P04 a failing script is persisted too (so it can be fixed and relaunched)", async () => {
    const p = await h.setup()
    const out = await p.call({ script: script(`return (`) })
    expect(out.error).toBeTruthy()
    expect(existsSync(out.scriptPath!)).toBe(true)
    writeFileSync(out.scriptPath!, script(`return "fixed"`))
    const again = await p.call({ scriptPath: out.scriptPath })
    expect(again.error).toBeUndefined()
    expect(p.resultOf(await p.notification(0))).toBe("fixed")
  })

  test("P04 re-invoking with scriptPath runs the edited file", async () => {
    const p = await h.setup()
    const out = await p.call({ script: script(`return "v1"`) })
    expect(p.resultOf(await p.notification(0))).toBe("v1")
    writeFileSync(out.scriptPath!, script(`return "v2-edited"`))
    const out2 = await p.call({ scriptPath: out.scriptPath })
    expect(out2.scriptPath).toBe(out.scriptPath)
    expect(out2.runId).not.toBe(out.runId)
    expect(p.resultOf(await p.notification(1))).toBe("v2-edited")
  })
})

describe("P05 args", () => {
  test("P05 args is exposed verbatim: arrays and objects are real JSON values", async () => {
    const p = await h.setup()
    const args = { issues: [1024, 1025, 1030], opts: { deep: true }, label: "x" }
    await p.call({
      script: script(`return { same: args, n: args.issues.map((i) => i + 1), isArray: Array.isArray(args.issues), deep: args.opts.deep }`),
      args,
    })
    expect(p.resultOf(await p.notification(0))).toEqual({ same: args, n: [1025, 1026, 1031], isArray: true, deep: true })
  })

  test("P05 array args support array methods directly", async () => {
    const p = await h.setup()
    await p.call({ script: script(`return args.filter((n) => n > 1).length`), args: [1, 2, 3] })
    expect(p.resultOf(await p.notification(0))).toBe(2)
  })

  test("P05 args is undefined when omitted", async () => {
    const p = await h.setup()
    await p.call({ script: script(`return typeof args + ":" + (args === undefined)`) })
    expect(p.resultOf(await p.notification(0))).toBe("undefined:true")
  })
})

describe("P06 completion notification", () => {
  test("P06 completed: status, result, usage (agent_count, tokens, duration) delivered to the parent and waking it", async () => {
    const p = await h.setup()
    const out = await p.call({ script: script(`const a = await agent("x"); const b = await agent("y"); return [a, b]`) })
    const n = await p.notification(0)
    expect(n.sessionID).toBe(SESSION)
    expect(n.resume).toBe(true)
    const text = String(n.text)
    expect(tag(text, "task-id")).toBe(out.taskId)
    expect(tag(text, "status")).toBe("completed")
    expect(p.resultOf(n)).toEqual(["done: x", "done: y"])
    const usage = tag(text, "usage")!
    expect(usage).toMatch(/agent_count: 2/)
    expect(usage).toMatch(/tokens: 220/)
    expect(usage).toMatch(/duration_ms: \d+/)
  })

  test("P06 failed: status failed and the error", async () => {
    const p = await h.setup()
    await p.call({ script: script(`await agent("x"); throw new Error("kaboom")`) })
    const text = String((await p.notification(0)).text)
    expect(tag(text, "status")).toBe("failed")
    expect(text).toContain("kaboom")
    expect(tag(text, "usage")).toMatch(/agent_count: 1/)
  })

  test("P06 failed: the result is the error once (no doubled 'Error:' prefix) and a retry hint only for when the user asks", async () => {
    const p = await h.setup()
    const out = await p.call({ script: script(`await agent("x"); throw new Error("kaboom")`) })
    const result = tag(String((await p.notification(0)).text), "result")!
    expect(result).toMatch(/^Error: [^\n]*kaboom/)
    expect(result).not.toMatch(/Error: Error/)
    expect(result.split("\n")[1]).toBe(
      `To retry (only if the user asks for it): fix the script at scriptPath and relaunch with resumeFromRunId "${out.runId}" to reuse completed agents.`,
    )
  })

  test("P06 stopped: status stopped", async () => {
    const runner = new FakeRunner().on("slow", { hold: true })
    const p = await h.setup({ runner })
    const out = await p.call({ script: script(`return await agent("slow")`) })
    await runner.waitForHeld(1)
    await p.control({ action: "stop", runId: out.runId })
    const text = String((await p.notification(0)).text)
    expect(tag(text, "status")).toBe("stopped")
  })

  test("P06 a plugin unload/reload (dispose) mid-run still notifies the parent: status stopped, reason and resume hint", async () => {
    const runner = new FakeRunner().on("slow", { hold: true })
    const p = await h.setup({ runner })
    const out = await p.call({ script: script(`return await agent("slow")`) })
    await runner.waitForHeld(1)
    await p.cleanup!()
    // dispose() waits (bounded) for the notification, so it is there once cleanup resolves.
    expect(p.notifications().length).toBe(1)
    const n = p.notifications()[0]
    const text = String(n.text)
    expect(n.sessionID).toBe(SESSION)
    expect(n.resume).toBe(true)
    expect(tag(text, "status")).toBe("stopped")
    expect(tag(text, "warnings")).toMatch(/plugin was unloaded/i)
    expect(text).toContain(`resumeFromRunId "${out.runId}"`)
    expect(isRunActive(out.runId!)).toBe(false)
  })

  test("P06 a workflow call that reaches an instance already disposed (plugin reload mid-turn) is refused, not started as an orphan run", async () => {
    const runner = new FakeRunner()
    const p = await h.setup({ runner })
    const tool = p.tools().get("workflow")!
    await p.cleanup!()
    // The model's turn still holds the old instance's tool: calling it must not start a run that
    // no live instance can see, stop or steer.
    const out = JSON.parse((await tool.execute({ script: script(`return await agent("x")`) }, tctx())).content)
    expect(out.error).toMatch(/reload/i)
    expect(out.runId && isRunActive(out.runId)).toBeFalsy()
    expect(runner.calls).toHaveLength(0)
  })

  test("P06 exactly one notification per run", async () => {
    const p = await h.setup()
    const out = await p.call({ script: script(`return 1`) })
    await p.notification(0)
    await p.settled(out.runId!)
    await sleep(30)
    expect(p.notifications().length).toBe(1)
  })
})

describe("X24 workflow_script: freeform inline script", () => {
  // Mirrors upstream packages/ai/src/schema/messages.ts ToolDefinition.freeformField: the input schema's
  // only property, when it is a required string; otherwise opencode refuses the freeform tool.
  const freeformField = (schema: any): string | undefined => {
    const props = Object.entries(schema?.properties && typeof schema.properties === "object" ? schema.properties : {})
    if (props.length !== 1) return undefined
    const [name, prop] = props[0] as [string, any]
    if (!prop || prop.type !== "string") return undefined
    return Array.isArray(schema.required) && schema.required.includes(name) ? name : undefined
  }
  const HINT = "workflow_script takes only the script; use the workflow tool for args, name, scriptPath, resumeFromRunId or budget"
  const FENCE = "`".repeat(3)

  test("X24 declares freeform text over an input of exactly one required string property, `script`", async () => {
    const p = await h.setup()
    const tool = p.tools().get("workflow_script")!
    expect(tool).toBeTruthy()
    expect(tool.freeform).toEqual({ type: "text" })
    expect(freeformField(tool.input)).toBe("script")
    expect(tool.input).toEqual({ type: "object", properties: { script: { type: "string" } }, required: ["script"] })
    expect(tool.options).toEqual({ codemode: false, permission: "workflow" })
    expect(tool.description).toMatch(/^Launch a NEW dynamic workflow from inline script text\./)
    expect(tool.description).toContain("`workflow` tool")
    expect(tool.description).toContain("export const meta")
    expect(tool.description.split(/\s+/).length).toBeLessThan(110)
  })

  test("X24 {script} launches exactly like workflow {script}: output shape, persisted scriptPath, result", async () => {
    const p = await h.setup()
    const src = script(`return "from-freeform"`)
    const out = await p.callScript({ script: src })
    const ref = await p.call({ script: src })
    expect(Object.keys(out).sort()).toEqual(Object.keys(ref).sort())
    expect(out.status).toBe("async_launched")
    expect(out.error).toBeUndefined()
    expect(out.workflowName).toBe("t-wf")
    expect(readFileSync(out.scriptPath!, "utf8")).toBe(src)
    expect(out.scriptPath!.startsWith(out.transcriptDir!)).toBe(true)
    const results = [p.resultOf(await p.notification(0)), p.resultOf(await p.notification(1))]
    expect(results).toEqual(["from-freeform", "from-freeform"])
    // The persisted copy is re-runnable through the workflow tool (P04).
    const again = await p.call({ scriptPath: out.scriptPath })
    expect(again.error).toBeUndefined()
  })

  test("X24 an extra key (a JSON call that also sends args, name, ...) is refused with the workflow-tool hint; nothing runs", async () => {
    const p = await h.setup()
    for (const extra of [{ args: [1] }, { name: "deep-research" }, { scriptPath: "x.js" }, { resumeFromRunId: "wf_x" }, { budget: 10 }, { title: "t" }]) {
      const out = await p.callScript({ script: script(`return await agent("a")`), ...extra })
      expect(out.status).toBe("async_launched")
      expect(out.taskType).toBe("local_workflow")
      expect(out.error).toBe(HINT)
      expect(out.transcriptDir).toBeUndefined()
    }
    await sleep(30)
    expect(p.runner.calls.length).toBe(0)
    expect(p.notifications().length).toBe(0)
    expect(await h.store.listRuns()).toEqual([])
  })

  test("X24 a script failing its meta check returns the P03 error and never runs", async () => {
    const p = await h.setup()
    const out = await p.callScript({ script: `await agent("a")\nreturn 1` })
    expect(out.status).toBe("async_launched")
    expect(out.error).toMatch(/export const meta/)
    const missing = await p.callScript({})
    expect(missing.error).toMatch(/script/)
    await sleep(30)
    expect(p.runner.calls.length).toBe(0)
  })

  test("X24 a single code fence wrapping the whole input is stripped; the stripped script runs and is persisted", async () => {
    const p = await h.setup()
    const src = script(`return "fenced"`)
    for (const wrapped of [`${FENCE}js\n${src}\n${FENCE}`, `${FENCE}\n${src}\n${FENCE}\n`, `  ${FENCE}javascript\n${src}\n${FENCE}  `]) {
      const out = await p.callScript({ script: wrapped })
      expect(out.error).toBeUndefined()
      expect(readFileSync(out.scriptPath!, "utf8")).toBe(src)
    }
    for (let i = 0; i < 3; i++) expect(p.resultOf(await p.notification(i))).toBe("fenced")
    // A fence that does not wrap the whole input is part of the script.
    const inner = script("const md = `\n" + FENCE + "js\nx\n" + FENCE + "\n`\nreturn md.length")
    const out = await p.callScript({ script: inner })
    expect(readFileSync(out.scriptPath!, "utf8")).toBe(inner)
  })

  test("X24 its permission key is `workflow`: denied with it in every child session (P60) and by a user deny of `workflow`", async () => {
    const p = await h.setup({ real: true })
    expect(visibleTools(p.tools(), [])).toEqual(expect.arrayContaining(["workflow", "workflow_script"]))
    await p.callScript({ script: script(`return await agent("a")`) })
    await p.notification(0)
    const child = p.fake.calls.create[0].permissions
    const inChild = visibleTools(p.tools(), child)
    expect(inChild).not.toContain("workflow")
    expect(inChild).not.toContain("workflow_script")
    // No separate rule: the `workflow` deny covers it.
    expect(child.some((r: any) => r.action === "workflow_script")).toBe(false)
    const denied = visibleTools(p.tools(), [{ action: "workflow", resource: "*", effect: "deny" }])
    expect(denied).not.toContain("workflow")
    expect(denied).not.toContain("workflow_script")
    expect(denied).toContain("workflow_control")
  })

  for (const [what, setup] of [
    ["plugin option freeformTool: false", { options: { freeformTool: false } }],
    ['plugin option freeformTool: "off"', { options: { freeformTool: "off" } }],
    ["OPENCODE_WORKFLOW_FREEFORM=0", { env: { OPENCODE_WORKFLOW_FREEFORM: "0" } }],
    ["OPENCODE_WORKFLOW_FREEFORM=false", { env: { OPENCODE_WORKFLOW_FREEFORM: "false" } }],
  ] as const) {
    test(`X24 opt-out: ${what} removes workflow_script and keeps the workflow tool`, async () => {
      const p = await h.setup(setup as any)
      expect(p.tools().has("workflow_script")).toBe(false)
      expect(p.tools().has("workflow")).toBe(true)
      expect(p.fake.sessionHooks.filter((x) => x.name === "context")).toHaveLength(0)
    })
  }

  test("X24 a model whose capabilities lack text freeform does not see workflow_script (context hook); one that lists it, or an unknown model, does", async () => {
    const models = [
      { id: "gpt-5.4-mini", providerID: "openai", freeform: ["text", "lark"] },
      { id: "claude-haiku-4-5", providerID: "anthropic" },
      { id: "regex-only", providerID: "openai", freeform: ["regex"] },
    ]
    const p = await h.setup({ fake: { models } })
    const event = (providerID: string, id: string) => ({
      sessionID: SESSION,
      agent: "build",
      model: { providerID, id },
      tools: { workflow: { description: "w", input: {} }, workflow_script: { description: "s", input: {} }, read: { description: "r", input: {} } },
    })
    const names = async (providerID: string, id: string) =>
      Object.keys((await p.fake.triggerSessionHook("context", event(providerID, id))).tools).sort()
    expect(await names("openai", "gpt-5.4-mini")).toEqual(["read", "workflow", "workflow_script"])
    expect(await names("anthropic", "claude-haiku-4-5")).toEqual(["read", "workflow"])
    expect(await names("openai", "regex-only")).toEqual(["read", "workflow"])
    expect(await names("nowhere", "unknown")).toEqual(["read", "workflow", "workflow_script"])
    // The model list is read once and reused.
    expect(p.fake.calls.modelList).toBe(1)
  })

  test("X24 the authoring reference tells the model to send a new inline script through workflow_script as raw text when it is offered", () => {
    const calling = AUTHORING_REFERENCE.slice(AUTHORING_REFERENCE.indexOf("## Calling the tool"), AUTHORING_REFERENCE.indexOf("## The meta block"))
    expect(calling).toMatch(/`workflow_script`/)
    expect(calling).toMatch(/raw text/)
  })
})
