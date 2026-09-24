// Parity: tool surface (P01–P06), through the plugin's `workflow` tool over a fake opencode ctx.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { isRunActive } from "../../src/engine.ts"
import { FakeRunner, sleep } from "../helpers/fake-runner.ts"
import { createHarness, script, SESSION, tag, tctx, type Harness } from "../helpers/plugin-harness.ts"

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
