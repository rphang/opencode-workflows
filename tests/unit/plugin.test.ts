// Plugin wiring tests: the `workflow` tool, `workflow_control`, `workflow_submit`, slash commands,
// task notifications and the disable switch — over a fake opencode v2 plugin Context.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin, { createPlugin } from "../../src/index.ts"
import { AUTHORING_REFERENCE, TOOL_DESCRIPTION } from "../../src/authoring.ts"
import { isRunActive } from "../../src/engine.ts"
import { formatTaskNotification, formatDuration, formatRunLine, formatRunStatus } from "../../src/plugin/format.ts"
import type { PluginDeps } from "../../src/plugin/setup.ts"
import { RunStore } from "../../src/store.ts"
import type { RunSummary, WorkflowOutput } from "../../src/types.ts"
import { ZERO_USAGE } from "../../src/types.ts"
import { createFakeCtx, type FakeCtxOptions } from "../helpers/fake-opencode-ctx.ts"
import { FakeRunner, sleep } from "../helpers/fake-runner.ts"

// ---------------------------------------------------------------------------------------------
// Fake plugin context: extends the runner fake with tool/command registries and session.synthetic.

interface Registered {
  name: string
  description: string
  input: any
  options?: any
  execute: (input: any, tctx: any) => Promise<any>
}

function makePluginCtx(opts: FakeCtxOptions & { options?: Record<string, unknown> } = {}) {
  const fake = createFakeCtx(opts)
  const toolCbs: ((e: any) => void)[] = []
  const commandCbs: ((e: any) => void)[] = []
  const synthetic: any[] = []
  const prompts: any[] = []
  let reloads = 0
  let disposed = 0

  function collect<T extends { name: string }>(cbs: ((e: any) => void)[]): Map<string, T> {
    const out = new Map<string, T>()
    const editor = {
      add: (d: T) => out.set(d.name, d),
      remove: (id: string) => out.delete(id),
      list: () => [...out.values()],
      get: (id: string) => out.get(id),
      update: () => {},
      namespace: () => {},
    }
    for (const cb of cbs) cb(editor)
    return out
  }

  const session = {
    ...fake.ctx.session,
    async synthetic(input: any) {
      synthetic.push(input)
      return { id: `syn_${synthetic.length}`, sessionID: input.sessionID, type: "synthetic" }
    },
    async prompt(input: any) {
      prompts.push(input)
      return fake.ctx.session.prompt(input)
    },
  }

  const ctx = {
    ...fake.ctx,
    options: opts.options ?? {},
    session,
    tool: {
      async transform(cb: (e: any) => void) {
        toolCbs.push(cb)
        return { dispose: async () => void disposed++ }
      },
      async reload() {},
    },
    command: {
      async transform(cb: (e: any) => void) {
        commandCbs.push(cb)
        return { dispose: async () => void disposed++ }
      },
      async reload() {
        reloads++
      },
      async list() {
        return []
      },
    },
  }

  return {
    fake,
    ctx: ctx as any,
    synthetic,
    prompts,
    tools: () => collect<Registered>(toolCbs),
    commands: () => collect<{ name: string; description?: string; execute: (i: any) => Promise<void> }>(commandCbs),
    reloads: () => reloads,
    disposed: () => disposed,
  }
}

// ---------------------------------------------------------------------------------------------

let base: string
let projectDir: string
let configHome: string
let dataDir: string
let cleanups: (() => unknown)[] = []

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "wf-plugin-"))
  projectDir = join(base, "proj")
  configHome = join(base, "config")
  dataDir = join(base, "data")
  mkdirSync(join(projectDir, ".git"), { recursive: true })
  mkdirSync(configHome, { recursive: true })
  cleanups = []
})

afterEach(async () => {
  for (const c of cleanups.reverse()) await c()
  await rm(base, { recursive: true, force: true })
})

const SESSION = "ses_parent0000000000000000000"

function tctx(sessionID = SESSION) {
  return { sessionID, agent: "build", messageID: "msg_1", id: "call_1", progress: async () => {}, signal: new AbortController().signal }
}

async function setup(
  opts: { runner?: FakeRunner; deps?: Partial<PluginDeps>; env?: Record<string, string>; options?: Record<string, unknown>; fake?: FakeCtxOptions } = {},
) {
  const p = makePluginCtx({ directory: projectDir, options: opts.options, ...opts.fake })
  const runner = opts.runner ?? new FakeRunner()
  const deps: PluginDeps = {
    env: { XDG_CONFIG_HOME: configHome, ...opts.env },
    dataDir,
    registryOptions: { configHome },
    watch: false,
    summaryThrottleMs: 5,
    createRunner: () => runner,
    ...opts.deps,
  }
  const cleanup = await createPlugin(deps).setup(p.ctx)
  if (typeof cleanup === "function") cleanups.push(cleanup)
  return { ...p, runner, cleanup: typeof cleanup === "function" ? cleanup : undefined }
}

async function call(p: Awaited<ReturnType<typeof setup>>, input: any, sessionID = SESSION): Promise<WorkflowOutput> {
  const tool = p.tools().get("workflow")!
  const res = await tool.execute(input, tctx(sessionID))
  expect(typeof res.content).toBe("string")
  return JSON.parse(res.content)
}

async function control(p: Awaited<ReturnType<typeof setup>>, input: any, sessionID = SESSION): Promise<string> {
  const res = await p.tools().get("workflow_control")!.execute(input, tctx(sessionID))
  return typeof res.content === "string" ? res.content : res.content.map((c: any) => c.text).join("")
}

async function waitFor(cond: () => boolean, what = "condition", ms = 5000) {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`)
    await sleep(5)
  }
}

function script(body: string, meta = `{ name: "t-wf", description: "test workflow" }`) {
  return `export const meta = ${meta}\n${body}`
}

const notifications = (p: { synthetic: any[] }) => p.synthetic.filter((s) => String(s.text).includes("<task-notification>"))

// ---------------------------------------------------------------------------------------------

describe("plugin entry", () => {
  test("default export is a plain {id, setup} object", () => {
    expect(plugin.id).toBe("dynamic-workflows")
    expect(typeof plugin.setup).toBe("function")
  })

  test("registers workflow, workflow_submit and workflow_control tools with codemode:false", async () => {
    const p = await setup()
    const tools = p.tools()
    expect([...tools.keys()].sort()).toEqual(["workflow", "workflow_control", "workflow_submit"])
    for (const t of tools.values()) expect(t.options?.codemode).toBe(false)
    const wf = tools.get("workflow")!
    expect(wf.description.startsWith(TOOL_DESCRIPTION)).toBe(true)
    expect(Object.keys(wf.input.properties).sort()).toEqual(
      ["args", "budget", "description", "name", "resumeFromRunId", "script", "scriptPath", "title"].sort(),
    )
    const ctl = tools.get("workflow_control")!
    expect(ctl.input.properties.action.enum).toEqual(["list", "status", "stop", "stop_agent", "pause", "resume", "message", "save"])
    // X01/X05/X08: message targets and options
    for (const k of ["agentIndex", "label", "phase", "all", "text", "urgent"]) expect(ctl.input.properties[k]).toBeDefined()
  })

  test("P57 OPENCODE_DISABLE_WORKFLOWS=1 registers nothing", async () => {
    const p = await setup({ env: { OPENCODE_DISABLE_WORKFLOWS: "1" } })
    expect(p.tools().size).toBe(0)
    expect(p.commands().size).toBe(0)
  })

  test("P57 plugin option disabled:true registers nothing", async () => {
    const p = await setup({ options: { disabled: true } })
    expect(p.tools().size).toBe(0)
    expect(p.commands().size).toBe(0)
  })

  test("P57 OPENCODE_DISABLE_WORKFLOWS=0 keeps the plugin enabled", async () => {
    const p = await setup({ env: { OPENCODE_DISABLE_WORKFLOWS: "0" } })
    expect(p.tools().size).toBe(3)
  })
})

describe("workflow tool", () => {
  test("P01 requires at least one of script/name/scriptPath", async () => {
    const p = await setup()
    const out = await call(p, { args: 1 })
    expect(out.status).toBe("async_launched")
    expect(out.taskType).toBe("local_workflow")
    expect(out.error).toMatch(/script, name, or scriptPath/)
    expect(p.runner.calls.length).toBe(0)
  })

  test("P02 returns async_launched immediately while agents still run", async () => {
    const runner = new FakeRunner().on("slow", { hold: true })
    const p = await setup({ runner })
    const out = await call(p, { script: script(`return await agent("slow task")`) })
    expect(out).toMatchObject({ status: "async_launched", taskType: "local_workflow", workflowName: "t-wf" })
    expect(out.error).toBeUndefined()
    expect(typeof out.taskId).toBe("string")
    expect(out.runId).toMatch(/^wf_/)
    expect(out.summary).toContain(out.runId!)
    expect(out.transcriptDir).toBeTruthy()
    expect(out.scriptPath).toBeTruthy()
    await runner.waitForHeld(1)
    expect(isRunActive(out.runId!)).toBe(true)
    expect(notifications(p).length).toBe(0)
    runner.release("slow")
    await waitFor(() => notifications(p).length === 1, "notification")
  })

  test("P03 a script failing its syntax check returns error and never runs", async () => {
    const p = await setup()
    const out = await call(p, { script: script(`const x: number = 1\nreturn agent("a")`) })
    expect(out.status).toBe("async_launched")
    expect(out.error).toMatch(/SyntaxError|Unexpected/)
    expect(out.scriptPath).toBeTruthy()
    await sleep(30)
    expect(p.runner.calls.length).toBe(0)
    expect(notifications(p).length).toBe(0)
  })

  test("P03 a non-literal meta returns error and never runs", async () => {
    const p = await setup()
    const out = await call(p, { script: `export const meta = { name: "x" + "y", description: "d" }\nreturn 1` })
    expect(out.error).toMatch(/pure literal/)
    expect(p.runner.calls.length).toBe(0)
  })

  test("P04 persists the script; re-invoking with scriptPath runs the edited file", async () => {
    const p = await setup()
    const out = await call(p, { script: script(`return "v1"`) })
    await waitFor(() => notifications(p).length === 1, "first notification")
    expect(readFileSync(out.scriptPath!, "utf8")).toContain(`return "v1"`)
    expect(notifications(p)[0].text).toContain("v1")

    writeFileSync(out.scriptPath!, script(`return "v2-edited"`))
    const out2 = await call(p, { scriptPath: out.scriptPath })
    expect(out2.error).toBeUndefined()
    expect(out2.scriptPath).toBe(out.scriptPath)
    expect(out2.runId).not.toBe(out.runId)
    await waitFor(() => notifications(p).length === 2, "second notification")
    expect(notifications(p)[1].text).toContain("v2-edited")
  })

  test("P01 scriptPath takes precedence over script and name", async () => {
    const p = await setup()
    const file = join(projectDir, "mine.js")
    writeFileSync(file, script(`return "from-file"`))
    const out = await call(p, { scriptPath: file, script: script(`return "inline"`), name: "deep-research" })
    expect(out.error).toBeUndefined()
    await waitFor(() => notifications(p).length === 1, "notification")
    expect(notifications(p)[0].text).toContain("from-file")
  })

  test("P01 relative scriptPath resolves against the project directory", async () => {
    const p = await setup()
    writeFileSync(join(projectDir, "rel.js"), script(`return "rel-ok"`))
    const out = await call(p, { scriptPath: "rel.js" })
    expect(out.error).toBeUndefined()
    await waitFor(() => notifications(p).length === 1, "notification")
    expect(notifications(p)[0].text).toContain("rel-ok")
  })

  test("P01 unreadable scriptPath returns an error", async () => {
    const p = await setup()
    const out = await call(p, { scriptPath: join(projectDir, "missing.js") })
    expect(out.error).toMatch(/cannot read scriptPath/)
  })

  test("P01 script also takes precedence over name", async () => {
    const p = await setup()
    const out = await call(p, { script: script(`return "inline"`), name: "deep-research" })
    expect(out.workflowName).toBe("t-wf")
  })

  test("P01 title/description inputs are ignored (meta wins)", async () => {
    const p = await setup()
    const out = await call(p, { script: script(`return 1`), title: "Other", description: "other desc" })
    expect(out.workflowName).toBe("t-wf")
    await waitFor(() => notifications(p).length === 1, "notification")
    expect(notifications(p)[0].text).toContain(`Dynamic workflow "test workflow" completed`)
  })

  test("P05 args are exposed verbatim as the global args", async () => {
    const p = await setup()
    const args = { files: ["a.ts", "b.ts"], n: 2, nested: { ok: true } }
    await call(p, { script: script(`return { args, isArray: Array.isArray(args.files) }`), args })
    await waitFor(() => notifications(p).length === 1, "notification")
    const text = notifications(p)[0].text as string
    const result = JSON.parse(text.match(/<result>([\s\S]*)<\/result>/)![1]!)
    expect(result).toEqual({ args, isArray: true })
  })

  test("P05 args is undefined when omitted", async () => {
    const p = await setup()
    await call(p, { script: script(`return typeof args`) })
    await waitFor(() => notifications(p).length === 1, "notification")
    expect(notifications(p)[0].text).toContain("<result>undefined</result>")
  })

  test("P06 completion notifies the parent session with a task notification that wakes it", async () => {
    const p = await setup()
    const out = await call(p, { script: script(`const a = await agent("x"); const b = await agent("y"); return [a, b]`) })
    await waitFor(() => notifications(p).length === 1, "notification")
    const n = notifications(p)[0]
    expect(n.sessionID).toBe(SESSION)
    expect(n.resume).toBe(true)
    const text = n.text as string
    expect(text).toContain(`<task-id>${out.taskId}</task-id>`)
    expect(text).toContain("<status>completed</status>")
    expect(text).toContain(`<summary>Dynamic workflow "test workflow" completed</summary>`)
    expect(text).toContain(`"done: x"`)
    expect(text).toMatch(/<usage>agent_count: 2\ntokens: 220\nduration_ms: \d+<\/usage>/)
    expect(n.metadata).toMatchObject({ workflowRunId: out.runId, status: "completed" })
  })

  test("P06 a failing script notifies with status failed and the error", async () => {
    const p = await setup()
    await call(p, { script: script(`throw new Error("kaboom")`) })
    await waitFor(() => notifications(p).length === 1, "notification")
    const text = notifications(p)[0].text as string
    expect(text).toContain("<status>failed</status>")
    expect(text).toContain("kaboom")
    expect(text).toContain(`Dynamic workflow "test workflow" failed`)
  })

  test("name runs a saved project workflow; unknown name errors", async () => {
    const p = await setup()
    mkdirSync(join(projectDir, ".opencode", "workflows"), { recursive: true })
    writeFileSync(
      join(projectDir, ".opencode", "workflows", "greet.js"),
      script(`return "hello " + args`, `{ name: "greet", description: "greets" }`),
    )
    const out = await call(p, { name: "greet", args: "bob" })
    expect(out.error).toBeUndefined()
    expect(out.workflowName).toBe("greet")
    await waitFor(() => notifications(p).length === 1, "notification")
    expect(notifications(p)[0].text).toContain("hello bob")
    // persisted copy under the run dir, not the saved file
    expect(out.scriptPath!.startsWith(out.transcriptDir!)).toBe(true)

    const bad = await call(p, { name: "nope-nothing" })
    expect(bad.error).toMatch(/unknown workflow "nope-nothing"/)
    expect(bad.error).toContain("greet")
  })

  test("P35 workflow(name) inside a script resolves saved workflows", async () => {
    const p = await setup()
    mkdirSync(join(projectDir, ".opencode", "workflows"), { recursive: true })
    writeFileSync(
      join(projectDir, ".opencode", "workflows", "inner.js"),
      script(`return "inner:" + args`, `{ name: "inner", description: "inner wf" }`),
    )
    await call(p, { script: script(`return await workflow("inner", "z")`) })
    await waitFor(() => notifications(p).length === 1, "notification")
    expect(notifications(p)[0].text).toContain("inner:z")
  })

  test("P35 workflow() with an unknown name fails the run", async () => {
    const p = await setup()
    await call(p, { script: script(`return await workflow("ghost")`) })
    await waitFor(() => notifications(p).length === 1, "notification")
    expect(notifications(p)[0].text).toContain("<status>failed</status>")
    expect(notifications(p)[0].text).toContain(`unknown workflow "ghost"`)
  })

  test("parse warnings are returned as warning", async () => {
    const p = await setup()
    const out = await call(p, {
      script: script(`phase("Other"); return 1`, `{ name: "w", description: "d", phases: [{ title: "Plan" }] }`),
    })
    expect(out.warning).toBeTruthy()
  })

  test("budget input sets budget.total", async () => {
    const p = await setup()
    await call(p, { script: script(`return [budget.total, budget.remaining()]`), budget: 500 })
    await waitFor(() => notifications(p).length === 1, "notification")
    expect(notifications(p)[0].text).toContain("[\n  500,\n  500\n]")
  })
})

describe("resume", () => {
  test("P42 resuming an unknown run fails with nothing to resume", async () => {
    const p = await setup()
    const out = await call(p, { script: script(`return 1`), resumeFromRunId: "wf_doesnotexist" })
    expect(out.error).toMatch(/nothing to resume/)
    await sleep(20)
    expect(notifications(p).length).toBe(0)
  })

  test("P41 resume replays completed agents from the journal", async () => {
    const p = await setup()
    const src = script(`const a = await agent("one"); const b = await agent("two"); return [a, b]`)
    const first = await call(p, { script: src })
    await waitFor(() => notifications(p).length === 1, "first")
    await waitFor(() => !isRunActive(first.runId!), "settled")
    expect(p.runner.calls.length).toBe(2)

    const second = await call(p, { script: src, resumeFromRunId: first.runId })
    expect(second.error).toBeUndefined()
    expect(second.runId).not.toBe(first.runId)
    await waitFor(() => notifications(p).length === 2, "second")
    expect(p.runner.calls.length).toBe(2) // all cached
    expect(notifications(p)[1].text).toContain(`"done: one"`)
  })

  test("P43 resume is refused while the old run's agents are still running", async () => {
    const runner = new FakeRunner().on("slow", { hold: true, lingerMs: 150 })
    const p = await setup({ runner })
    const src = script(`return await agent("slow")`)
    const first = await call(p, { script: src })
    await runner.waitForHeld(1)
    const refused = await call(p, { script: src, resumeFromRunId: first.runId })
    expect(refused.error).toMatch(/still running/)
    expect(await control(p, { action: "stop", runId: first.runId })).toMatch(/stop/i)
    // agents linger after the stop: still refused
    const refused2 = await call(p, { script: src, resumeFromRunId: first.runId })
    expect(refused2.error).toMatch(/still running/)
    await waitFor(() => !isRunActive(first.runId!), "old run settled")
  })

  test("resume from another session's run is refused (same session only)", async () => {
    const p = await setup()
    const src = script(`return await agent("one")`)
    const first = await call(p, { script: src })
    await waitFor(() => notifications(p).length === 1, "first")
    await waitFor(() => !isRunActive(first.runId!), "settled")
    const other = await call(p, { script: src, resumeFromRunId: first.runId }, "ses_other")
    expect(other.error).toMatch(/nothing to resume/)
  })
})

describe("location keep-alive (opencode evicts a location after 60 min without session events)", () => {
  test("an active run periodically touches its parent session with the unchanged title; it stops once the run settles", async () => {
    const runner = new FakeRunner().on("slow", { hold: true })
    const p = await setup({ runner, deps: { keepAliveMs: 10 } })
    const out = await call(p, { script: script(`return await agent("slow")`) })
    await runner.waitForHeld(1)
    await control(p, { action: "pause", runId: out.runId }) // a paused run produces no session events itself
    await waitFor(() => p.fake.calls.update.length >= 2, "keep-alive touches")
    for (const u of p.fake.calls.update) expect(u).toEqual({ sessionID: SESSION, title: "parent" })
    expect(p.fake.sessions.get(SESSION)!.info.title).toBe("parent")
    await control(p, { action: "stop", runId: out.runId })
    await waitFor(() => notifications(p).length === 1, "notification")
    await waitFor(() => !isRunActive(out.runId!), "settled")
    await sleep(30)
    const n = p.fake.calls.update.length
    await sleep(50)
    expect(p.fake.calls.update.length).toBe(n)
  })

  test("the default keep-alive period is well under the 60-minute eviction; keepAliveMs 0 disables it", async () => {
    const { KEEP_ALIVE_MS } = await import("../../src/plugin/host.ts")
    expect(KEEP_ALIVE_MS).toBeLessThanOrEqual(30 * 60_000)
    const runner = new FakeRunner().on("slow", { hold: true })
    const p = await setup({ runner, deps: { keepAliveMs: 0 } })
    const out = await call(p, { script: script(`return await agent("slow")`) })
    await runner.waitForHeld(1)
    await sleep(40)
    expect(p.fake.calls.update.length).toBe(0)
    await control(p, { action: "stop", runId: out.runId })
    await waitFor(() => notifications(p).length === 1, "notification")
  })
})

describe("workflow_control tool", () => {
  test("P77 a finished run on disk (e.g. the process died before notifying): model-facing status points to run.json, not the result", async () => {
    const store = new RunStore({ root: dataDir })
    const { runId, dir } = await store.createRun(SESSION)
    await store.writeSummary({
      runId, taskId: "t", workflowName: "n", description: "d", parentSessionID: SESSION, status: "completed",
      startedAt: 1, endedAt: 2, agentCount: 0, usage: ZERO_USAGE, phases: [], logs: [], warnings: [],
      result: "ORPHAN-RESULT", scriptPath: join(dir, "script.js"), transcriptDir: dir,
    })
    const p = await setup()
    const status = await control(p, { action: "status", runId })
    expect(status).not.toContain("ORPHAN-RESULT")
    expect(status).toContain("run.json")
  })

  test("P51 stop stops the whole run and notifies status stopped", async () => {
    const runner = new FakeRunner().on("slow", { hold: true })
    const p = await setup({ runner })
    const out = await call(p, { script: script(`return await agent("slow")`) })
    await runner.waitForHeld(1)
    const msg = await control(p, { action: "stop", runId: out.runId })
    expect(msg).toContain(out.runId!)
    await waitFor(() => notifications(p).length === 1, "notification")
    expect(notifications(p)[0].text).toContain("<status>stopped</status>")
    expect(notifications(p)[0].text).toContain("resumeFromRunId")
  })

  test("P51 stop_agent makes that agent() resolve null", async () => {
    const runner = new FakeRunner().on("slow", { hold: true })
    const p = await setup({ runner })
    const out = await call(p, { script: script(`const r = await agent("slow"); return r === null ? "was-null" : r`) })
    await runner.waitForHeld(1)
    const msg = await control(p, { action: "stop_agent", runId: out.runId, agentIndex: 0 })
    expect(msg).toMatch(/stopped agent 0/i)
    await waitFor(() => notifications(p).length === 1, "notification")
    expect(notifications(p)[0].text).toContain("was-null")
  })

  test("pause and resume a run", async () => {
    const runner = new FakeRunner().on("slow", { hold: true })
    const p = await setup({ runner })
    const out = await call(p, { script: script(`return await agent("slow")`) })
    await runner.waitForHeld(1)
    expect(await control(p, { action: "pause", runId: out.runId })).toMatch(/paused/i)
    expect(await control(p, { action: "status", runId: out.runId })).toMatch(/paused/)
    expect(await control(p, { action: "resume", runId: out.runId })).toMatch(/resumed/i)
    runner.release("slow")
    await waitFor(() => notifications(p).length === 1, "notification")
  })

  test("P50 a stored running/paused run with no live engine (process exited) is shown as stopped", async () => {
    const p = await setup()
    const store = new RunStore({ root: dataDir })
    const loc = await store.createRun(SESSION)
    const orphan: RunSummary = {
      runId: loc.runId,
      taskId: "t_orphan",
      workflowName: "orphan-wf",
      description: "left behind",
      parentSessionID: SESSION,
      status: "running",
      startedAt: Date.now() - 60_000,
      agentCount: 0,
      usage: { ...ZERO_USAGE },
      phases: [],
      logs: [],
      warnings: [],
      scriptPath: join(loc.dir, "script.js"),
      transcriptDir: loc.dir,
    }
    await store.writeSummary(orphan)
    expect(isRunActive(loc.runId)).toBe(false)
    const list = await control(p, { action: "list" })
    expect(list).toContain(loc.runId)
    expect(list).toContain("(1; 0 active)")
    expect(list).toMatch(new RegExp(`${loc.runId}  stopped  `))
    const status = await control(p, { action: "status", runId: loc.runId })
    expect(status).toMatch(/stopped/)
    expect(status).toMatch(/interrupted|exited/i)
    expect(status).toContain("resumeFromRunId")
    // paused too
    await store.writeSummary({ ...orphan, status: "paused" })
    expect(await control(p, { action: "status", runId: loc.runId })).toMatch(/stopped/)
  })

  test("P50 the agents of an orphaned run (process exited) are shown stopped, not running; finished ones keep their status", async () => {
    const p = await setup()
    const store = new RunStore({ root: dataDir })
    const loc = await store.createRun(SESSION)
    const base = { key: "k", opts: {}, usage: { ...ZERO_USAGE } }
    await store.writeSummary({
      runId: loc.runId,
      taskId: "t_orphan",
      workflowName: "orphan-wf",
      description: "left behind",
      parentSessionID: SESSION,
      status: "running",
      startedAt: Date.now() - 60_000,
      agentCount: 3,
      usage: { ...ZERO_USAGE },
      phases: [],
      logs: [],
      warnings: [],
      scriptPath: join(loc.dir, "script.js"),
      transcriptDir: loc.dir,
    })
    await store.writeAgentRecord(loc.runId, { ...base, index: 0, label: "done-one", prompt: "a", status: "completed", result: "r" } as any)
    await store.writeAgentRecord(loc.runId, { ...base, index: 1, label: "live-one", prompt: "b", status: "running", sessionID: "ses_orphan1", startedAt: Date.now() - 50_000 } as any)
    await store.writeAgentRecord(loc.runId, { ...base, index: 2, label: "queued-one", prompt: "c", status: "queued" } as any)
    const status = await control(p, { action: "status", runId: loc.runId })
    expect(status).toMatch(/#0 done-one {2}completed/)
    expect(status).toMatch(/#1 live-one {2}stopped/)
    expect(status).toContain("ses_orphan1") // the suspended child session stays findable
    expect(status).toMatch(/#2 queued-one {2}stopped/)
    expect(status).not.toMatch(/ {2}(running|queued) /)
    // stored records are left untouched (resume reads the journal)
    expect((await store.readAgentRecord(loc.runId, 1))?.status).toBe("running")
  })

  test("errors: unknown run, missing runId, finished run", async () => {
    const p = await setup()
    expect(await control(p, { action: "stop" })).toMatch(/runId is required/)
    expect(await control(p, { action: "stop", runId: "wf_nope" })).toMatch(/not found in this session/)
    expect(await control(p, { action: "status", runId: "wf_nope" })).toMatch(/not found in this session/)
  })

  test("P50 list and status show phases, agents, tokens and elapsed time", async () => {
    const runner = new FakeRunner().on("slow", { hold: true })
    const p = await setup({ runner })
    const out = await call(p, {
      script: script(
        `phase("Scan"); await agent("fast one", {label: "fast"}); return await agent("slow", {label: "slowpoke"})`,
        `{ name: "lister", description: "list me", phases: [{ title: "Scan" }] }`,
      ),
    })
    await runner.waitForHeld(1)
    const list = await control(p, { action: "list" })
    expect(list).toContain("lister")
    expect(list).toContain(out.runId!)
    expect(list).toContain("running")
    expect(list).toMatch(/Scan\s+1\/2/)
    expect(list).toMatch(/tokens/)
    const status = await control(p, { action: "status", runId: out.runId })
    expect(status).toContain("slowpoke")
    expect(status).toContain("fast")
    expect(status).toMatch(/#0 .*completed/)
    expect(status).toMatch(/#1 .*running/)
    runner.release("slow")
    await waitFor(() => notifications(p).length === 1, "notification")
    await waitFor(() => !isRunActive(out.runId!), "settled")
    // finished runs are listed from disk
    const list2 = await control(p, { action: "list" })
    expect(list2).toContain(out.runId!)
    expect(list2).toContain("completed")
    const status2 = await control(p, { action: "status", runId: out.runId })
    expect(status2).toContain("slowpoke")
  })

  test("list is scoped to the calling session", async () => {
    const p = await setup()
    const out = await call(p, { script: script(`return 1`) })
    await waitFor(() => notifications(p).length === 1, "notification")
    await waitFor(() => !isRunActive(out.runId!), "settled")
    expect(await control(p, { action: "list" }, "ses_other")).not.toContain(out.runId!)
    expect(await control(p, { action: "list" }, "ses_other")).toMatch(/no workflow runs/i)
  })

  test("P52 save writes the run's script to the project and reloads commands", async () => {
    const p = await setup()
    const out = await call(p, { script: script(`return "saved!"`, `{ name: "my-flow", description: "my saved flow" }`) })
    await waitFor(() => notifications(p).length === 1, "notification")
    const before = p.reloads()
    const msg = await control(p, { action: "save", runId: out.runId })
    const target = join(projectDir, ".opencode", "workflows", "my-flow.js")
    expect(msg).toContain(target)
    expect(existsSync(target)).toBe(true)
    expect(p.reloads()).toBeGreaterThan(before)
    expect(p.commands().has("my-flow")).toBe(true)
  })

  test("P52 save to personal location with a custom name", async () => {
    const p = await setup()
    const out = await call(p, { script: script(`return 1`, `{ name: "flow-x", description: "x" }`) })
    await waitFor(() => notifications(p).length === 1, "notification")
    const msg = await control(p, { action: "save", runId: out.runId, name: "renamed", location: "personal" })
    const target = join(configHome, "opencode", "workflows", "renamed.js")
    expect(msg).toContain(target)
    expect(existsSync(target)).toBe(true)
  })

  test("P52 save refuses an invalid name", async () => {
    const p = await setup()
    const out = await call(p, { script: script(`return 1`) })
    await waitFor(() => notifications(p).length === 1, "notification")
    expect(await control(p, { action: "save", runId: out.runId, name: "../evil" })).toMatch(/invalid name|cannot save/i)
  })
})

describe("commands", () => {
  test("P58 /workflow-authoring injects the authoring reference without waking the model", async () => {
    const p = await setup()
    const cmd = p.commands().get("workflow-authoring")!
    expect(cmd).toBeTruthy()
    await cmd.execute({ sessionID: SESSION, prompt: { text: "" }, delivery: "steer" })
    expect(p.synthetic.length).toBe(1)
    expect(p.synthetic[0].text).toContain(AUTHORING_REFERENCE)
    expect(p.synthetic[0].resume).toBe(false)
    expect(p.prompts.length).toBe(0)
  })

  test("P58 /workflow-authoring with text also prompts the model with that text", async () => {
    const p = await setup()
    await p.commands().get("workflow-authoring")!.execute({ sessionID: SESSION, prompt: { text: "write a sweep" }, delivery: "steer" })
    expect(p.synthetic.length).toBe(1)
    expect(p.prompts.length).toBe(1)
    expect(p.prompts[0].text).toBe("write a sweep")
  })

  test("P54 /deep-research is registered and asks the model to run the workflow tool", async () => {
    const p = await setup()
    const cmd = p.commands().get("deep-research")!
    expect(cmd).toBeTruthy()
    expect(cmd.description).toBeTruthy()
    await cmd.execute({ sessionID: SESSION, prompt: { text: "why is the sky blue?" }, delivery: "steer" })
    expect(p.prompts.length).toBe(1)
    const text = p.prompts[0].text as string
    expect(p.prompts[0].sessionID).toBe(SESSION)
    expect(text).toContain("`workflow` tool")
    expect(text).toContain(JSON.stringify({ name: "deep-research", args: "why is the sky blue?" }))
  })

  test("P53 saved workflows become /<name> commands; project beats personal; args omitted when empty", async () => {
    mkdirSync(join(projectDir, ".opencode", "workflows"), { recursive: true })
    mkdirSync(join(configHome, "opencode", "workflows"), { recursive: true })
    writeFileSync(join(projectDir, ".opencode", "workflows", "a.js"), script(`return 1`, `{ name: "shared", description: "project one" }`))
    writeFileSync(join(configHome, "opencode", "workflows", "b.js"), script(`return 1`, `{ name: "shared", description: "personal one" }`))
    writeFileSync(join(configHome, "opencode", "workflows", "c.js"), script(`return 1`, `{ name: "mine", description: "personal only" }`))
    const p = await setup()
    const cmds = p.commands()
    expect(cmds.get("shared")!.description).toContain("project one")
    expect(cmds.has("mine")).toBe(true)
    await cmds.get("mine")!.execute({ sessionID: SESSION, prompt: { text: "   " }, delivery: "queue" })
    expect(p.prompts[0].text).toContain(JSON.stringify({ name: "mine" }))
    expect(p.prompts[0].delivery).toBe("queue")
  })

  test("P11 a saved workflow with non-literal meta gets no command", async () => {
    mkdirSync(join(projectDir, ".opencode", "workflows"), { recursive: true })
    writeFileSync(join(projectDir, ".opencode", "workflows", "bad.js"), `const n = "bad"\nexport const meta = { name: n, description: "d" }\n`)
    writeFileSync(join(projectDir, ".opencode", "workflows", "bad2.js"), `export const meta = { name: "bad2", description: "d" + "" }\n`)
    const p = await setup()
    expect(p.commands().has("bad")).toBe(false)
    expect(p.commands().has("bad2")).toBe(false)
  })

  test("saved workflows cannot shadow the built-in commands", async () => {
    mkdirSync(join(projectDir, ".opencode", "workflows"), { recursive: true })
    writeFileSync(join(projectDir, ".opencode", "workflows", "w.js"), script(`return 1`, `{ name: "workflows", description: "evil" }`))
    const p = await setup()
    expect(p.commands().get("workflows")!.description).not.toContain("evil")
  })

  test("commands pick up newly saved workflows on reload", async () => {
    const p = await setup()
    expect(p.commands().has("later")).toBe(false)
    mkdirSync(join(projectDir, ".opencode", "workflows"), { recursive: true })
    writeFileSync(join(projectDir, ".opencode", "workflows", "later.js"), script(`return 1`, `{ name: "later", description: "added later" }`))
    // the fake re-runs transforms on every read, like opencode does on command.reload()
    expect(p.commands().has("later")).toBe(true)
  })

  test("P50 /workflows shows the run list as a synthetic message and reloads commands", async () => {
    const p = await setup()
    const out = await call(p, { script: script(`return 1`, `{ name: "shown", description: "d" }`) })
    await waitFor(() => notifications(p).length === 1, "notification")
    const before = p.reloads()
    await p.commands().get("workflows")!.execute({ sessionID: SESSION, prompt: { text: "" }, delivery: "steer" })
    const view = p.synthetic.at(-1)
    expect(view.resume).toBe(false)
    expect(view.text).toContain("shown")
    expect(view.text).toContain(out.runId!)
    expect(p.reloads()).toBeGreaterThan(before)
  })

  test("P50 /workflows <runId> shows that run's status", async () => {
    const p = await setup()
    const out = await call(p, { script: script(`return await agent("hello", {label: "greeter"})`) })
    await waitFor(() => notifications(p).length === 1, "notification")
    await p.commands().get("workflows")!.execute({ sessionID: SESSION, prompt: { text: out.runId }, delivery: "steer" })
    expect(p.synthetic.at(-1).text).toContain("greeter")
  })
})

describe("robustness", () => {
  test("P53 file watcher reloads commands when a saved workflow is added", async () => {
    mkdirSync(join(projectDir, ".opencode", "workflows"), { recursive: true })
    const p = await setup({ deps: { watch: true } })
    const before = p.reloads()
    writeFileSync(join(projectDir, ".opencode", "workflows", "w.js"), script(`return 1`, `{ name: "watched", description: "d" }`))
    await waitFor(() => p.reloads() > before, "reload after file change", 5000)
  })

  test("P06 a failing session.synthetic does not break the run", async () => {
    const p = await setup()
    p.ctx.session.synthetic = async () => {
      throw new Error("session gone")
    }
    const out = await call(p, { script: script(`return 1`) })
    await waitFor(() => !isRunActive(out.runId!), "settled")
    const summary = await new RunStore({ root: dataDir }).readSummary(out.runId!)
    expect(summary?.status).toBe("completed")
  })

  test("/workflows falls back to throwing the text when synthetic is unavailable", async () => {
    const p = await setup()
    p.ctx.session.synthetic = async () => {
      throw new Error("nope")
    }
    await expect(
      p.commands().get("workflows")!.execute({ sessionID: SESSION, prompt: { text: "" }, delivery: "steer" }),
    ).rejects.toThrow(/no workflow runs/i)
  })
})

describe("lifecycle", () => {
  test("cleanup stops active runs and still notifies the parent (stopped, with the unload reason)", async () => {
    const runner = new FakeRunner().on("slow", { hold: true })
    const p = await setup({ runner })
    const out = await call(p, { script: script(`return await agent("slow")`) })
    await runner.waitForHeld(1)
    await p.cleanup!()
    await waitFor(() => !isRunActive(out.runId!), "stopped")
    const summary = await new RunStore({ root: dataDir }).readSummary(out.runId!)
    expect(summary?.status).toBe("stopped")
    expect(notifications(p).length).toBe(1)
    expect(notifications(p)[0].text).toContain("<status>stopped</status>")
    expect(summary?.warnings.join(" ")).toMatch(/plugin was unloaded/)
  })

  test("P60 real opencode runner: children get workflow and workflow_control denied", async () => {
    const p = await setup({ deps: { createRunner: undefined } })
    const out = await call(p, { script: script(`return await agent("say hi")`) })
    await waitFor(() => notifications(p).length === 1, "notification")
    expect(notifications(p)[0].text).toContain("<status>completed</status>")
    expect(notifications(p)[0].text).toContain("ok")
    const create = p.fake.calls.create[0]
    const denied = create.permissions.filter((r: any) => r.effect === "deny").map((r: any) => r.action)
    expect(denied).toContain("workflow")
    expect(denied).toContain("workflow_control")
    expect(create.metadata.workflowRunId).toBe(out.runId)
  })
})

describe("format", () => {
  const summary: RunSummary = {
    runId: "wf_1",
    taskId: "task_1",
    workflowName: "n",
    description: "desc",
    status: "completed",
    startedAt: 1000,
    endedAt: 4500,
    agentCount: 3,
    usage: { ...ZERO_USAGE, input: 100, output: 20 },
    phases: [],
    logs: [],
    warnings: [],
    result: "plain text",
    scriptPath: "/s.js",
    transcriptDir: "/t",
  }

  test("P06 formatTaskNotification: string results are inlined verbatim", () => {
    const t = formatTaskNotification(summary)
    expect(t.startsWith("<task-notification>")).toBe(true)
    expect(t.trimEnd().endsWith("</task-notification>")).toBe(true)
    expect(t).toContain("<task-id>task_1</task-id>")
    expect(t).toContain("<status>completed</status>")
    expect(t).toContain("<result>plain text</result>")
    expect(t).toContain("<usage>agent_count: 3\ntokens: 120\nduration_ms: 3500</usage>")
    expect(t).toContain("wf_1")
  })

  test("P06 formatTaskNotification: failed runs carry the error", () => {
    const t = formatTaskNotification({ ...summary, status: "failed", result: undefined, error: "boom" })
    expect(t).toContain("<status>failed</status>")
    expect(t).toContain(`Dynamic workflow "desc" failed`)
    expect(t).toContain("boom")
  })

  const phased: RunSummary = {
    ...summary,
    phases: [
      { title: "Used", agents: 2, done: 2, tokens: 5 },
      { title: "Empty", agents: 0, done: 0, tokens: 0 },
    ],
  }

  test("P50 formatRunLine hides declared phases with 0 agents in a finished run, keeps them while running", () => {
    for (const status of ["completed", "failed", "stopped"] as const) {
      const line = formatRunLine({ ...phased, status })
      expect(line).toMatch(/Used\s+2\/2/)
      expect(line).not.toContain("Empty")
    }
    for (const status of ["running", "paused"] as const) expect(formatRunLine({ ...phased, status })).toMatch(/Empty\s+0\/0/)
  })

  test("P77 formatRunStatus forModel: never a Result section or agent result previews, a note instead", () => {
    const agent = { index: 0, label: "a", status: "completed", prompt: "p", result: "agent says hi", usage: summary.usage } as any
    const shown = formatRunStatus(summary, [agent])
    expect(shown).toContain("Result:")
    expect(shown).toContain("plain text")
    expect(shown).toContain("agent says hi")
    const model = formatRunStatus(summary, [agent], 5000, { forModel: true })
    expect(model).not.toContain("Result:")
    expect(model).not.toContain("plain text")
    expect(model).not.toContain("agent says hi")
    expect(model).toContain("Finished. Its result is not shown here: it is delivered to this session as a task notification")
    expect(model).toContain("/t")
    expect(model).toContain("run.json")
    const running = formatRunStatus({ ...summary, status: "running", result: undefined }, [], 5000, { forModel: true })
    expect(running).toContain("Still running. The result is delivered to this session as a task notification")
    expect(running).toContain("end your turn now; do not poll, sleep, or run shell commands to wait")
  })

  test("formatDuration", () => {
    expect(formatDuration(900)).toBe("0.9s")
    expect(formatDuration(65_000)).toBe("1m05s")
    expect(formatDuration(3_725_000)).toBe("1h02m")
  })
})
