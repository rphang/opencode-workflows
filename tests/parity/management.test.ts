// Parity: management & UX (P50–P59), through the plugin's tools and slash commands.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { AUTHORING_REFERENCE, TOOL_DESCRIPTION } from "../../src/authoring.ts"
import { LARGE_WORKFLOW_AGENT_THRESHOLD } from "../../src/engine.ts"
import { parseScript } from "../../src/meta.ts"
import { BUNDLED_WORKFLOWS_DIR } from "../../src/registry.ts"
import { FakeRunner, sleep } from "../helpers/fake-runner.ts"
import { createHarness, script, SESSION, tag, type Harness } from "../helpers/plugin-harness.ts"

let h: Harness
beforeEach(async () => {
  h = await createHarness()
})
afterEach(async () => {
  await h.dispose()
})

describe("P50 /workflows", () => {
  test("P50 lists running and completed runs with per-phase agent counts, token totals and elapsed time", async () => {
    const runner = new FakeRunner().on("slow", { hold: true })
    const p = await h.setup({ runner })
    const done = await p.call({ script: script(`phase("Only"); return await agent("quick")`, `{ name: "finished-one", description: "d" }`) })
    await p.notification(0)
    await p.settled(done.runId!)
    const live = await p.call({
      script: script(
        `phase("Scan"); await agent("fast one"); await agent("slow"); return 1`,
        `{ name: "running-one", description: "d", phases: [{ title: "Scan" }, { title: "Report" }] }`,
      ),
    })
    await runner.waitForHeld(1)
    await p.command("workflows")
    const view = p.synthetic.at(-1)
    expect(view.resume).toBe(false)
    const text = String(view.text)
    expect(text).toContain("running-one")
    expect(text).toContain(live.runId!)
    expect(text).toContain("finished-one")
    expect(text).toContain(done.runId!)
    expect(text).toMatch(/running/)
    expect(text).toMatch(/completed/)
    expect(text).toMatch(/Scan\s+1\/2/) // per-phase done/agents
    expect(text).toMatch(/Report\s+0\/0/)
    expect(text).toMatch(/tokens/)
    expect(text).toMatch(/\d+(\.\d)?s|\dm\d\ds/) // elapsed
    runner.release()
    await p.notification(1)
  })

  test("P50 /workflows <runId> drills into one run's agents (label, status, phase, tokens, session)", async () => {
    const p = await h.setup()
    const out = await p.call({ script: script(`phase("P"); await agent("hello", { label: "greeter" }); return 1`) })
    await p.notification(0)
    await p.settled(out.runId!)
    await p.command("workflows", out.runId!)
    const text = String(p.synthetic.at(-1).text)
    expect(text).toContain("greeter")
    expect(text).toMatch(/#0 .*completed/)
    expect(text).toContain("P")
    expect(text).toContain("ses_fake_0")
  })

  test("P50 each phase line shows its own elapsed time", async () => {
    const runner = new FakeRunner().on("slow", { delayMs: 300 })
    const p = await h.setup({ runner })
    const out = await p.call({
      script: script(`phase("Alpha"); await agent("slow one"); phase("Beta"); await agent("quick"); return 1`, `{ name: "timed", description: "d", phases: [{ title: "Alpha" }, { title: "Beta" }, { title: "Gamma" }] }`),
    })
    await p.notification(0)
    await p.settled(out.runId!)
    await p.command("workflows")
    const text = String(p.synthetic.at(-1).text)
    expect(text).toMatch(/Alpha\s+1\/1\s+\S+ tokens\s+0\.[3-9]s/)
    expect(text).toMatch(/Beta\s+1\/1\s+\S+ tokens\s+0\.[0-2]s/)
    expect(text).not.toMatch(/Gamma\s+0\/0/) // declared, never used, run finished: hidden (the launch warning stays)
  })

  test("P50 a declared phase that ended with 0 agents is hidden once the run finished, and shown while it runs", async () => {
    const runner = new FakeRunner().on("slow", { hold: true })
    const p = await h.setup({ runner })
    const meta = `{ name: "unused-phase", description: "d", phases: [{ title: "Used" }, { title: "NeverUsed" }] }`
    const out = await p.call({ script: script(`phase("Used"); await agent("slow"); return 1`, meta) })
    await runner.waitForCalls(1)
    await p.command("workflows")
    expect(String(p.synthetic.at(-1).text)).toMatch(/NeverUsed\s+0\/0/)
    expect(await p.control({ action: "status", runId: out.runId })).toMatch(/NeverUsed\s+0\/0/)
    runner.release()
    await p.notification(0)
    await p.settled(out.runId!)
    await p.command("workflows")
    expect(String(p.synthetic.at(-1).text)).not.toMatch(/NeverUsed\s+0\/0/)
    await p.command("workflows", out.runId!)
    expect(String(p.synthetic.at(-1).text)).not.toMatch(/NeverUsed\s+0\/0/)
    expect(String(p.synthetic.at(-1).text)).toMatch(/Used\s+1\/1/)
    expect(await p.control({ action: "status", runId: out.runId })).not.toMatch(/NeverUsed\s+0\/0/)
  })

  test("P50 agents outside any phase are shown in a group of their own", async () => {
    const p = await h.setup()
    const grouped = await p.call({ script: script(`await agent("pre"); phase("A"); await agent("in A"); return 1`, `{ name: "g", description: "d", phases: [{ title: "A" }] }`) })
    await p.notification(0)
    await p.settled(grouped.runId!)
    const flat = await p.call({ script: script(`await agent("x"); await agent("y"); return 1`, `{ name: "flat", description: "d" }`) })
    await p.notification(1)
    await p.settled(flat.runId!)
    await p.command("workflows")
    const text = String(p.synthetic.at(-1).text)
    const block = (name: string) => text.split(/\n(?=\S)/).find((b) => b.includes(` ${name} `))!
    expect(block("g")).toMatch(/A\s+1\/1/)
    expect(block("g")).toMatch(/\(no phase\)\s+1\/1/)
    expect(block("flat")).toMatch(/\(no phase\)\s+2\/2/)
  })

  test("P50 the agent detail shows each agent's prompt and result", async () => {
    const p = await h.setup()
    const out = await p.call({ script: script(`await agent("hello there\\nsecond line", { label: "greeter" }); return 1`) })
    await p.notification(0)
    await p.settled(out.runId!)
    await p.command("workflows", out.runId!)
    const text = String(p.synthetic.at(-1).text)
    expect(text).toMatch(/prompt: hello there/)
    expect(text).toMatch(/result: done: hello there/)
    const rec = await h.store.readAgentRecord(out.runId!, 0)
    expect(rec?.result).toBe("done: hello there\nsecond line")
  })

  test("P50 DEGRADED: the same views are available to the model via workflow_control list/status", async () => {
    const p = await h.setup()
    const out = await p.call({ script: script(`return await agent("x", { label: "lbl" })`) })
    await p.notification(0)
    await p.settled(out.runId!)
    expect(await p.control({ action: "list" })).toContain(out.runId!)
    expect(await p.control({ action: "status", runId: out.runId })).toContain("lbl")
  })
})

describe("P51 stop", () => {
  test("P51 stop the whole run", async () => {
    const runner = new FakeRunner().on("slow", { hold: true })
    const p = await h.setup({ runner })
    const out = await p.call({ script: script(`return await agent("slow")`) })
    await runner.waitForHeld(1)
    expect(await p.control({ action: "stop", runId: out.runId })).toContain(out.runId!)
    const text = String((await p.notification(0)).text)
    expect(tag(text, "status")).toBe("stopped")
    expect(text).toMatch(/resumeFromRunId/)
  })

  test("P51 stop a single agent: it counts as failed and its agent() resolves to null; the run continues", async () => {
    const runner = new FakeRunner().on("slow", { hold: true })
    const p = await h.setup({ runner })
    const out = await p.call({ script: script(`const r = await agent("slow"); const n = await agent("next"); return [r, n]`) })
    await runner.waitForHeld(1)
    expect(await p.control({ action: "stop_agent", runId: out.runId, agentIndex: 0 })).toMatch(/counts as failed/)
    const n = await p.notification(0)
    expect(tag(String(n.text), "status")).toBe("completed")
    expect(p.resultOf(n)).toEqual([null, "done: next"])
    await p.settled(out.runId!)
    const rec = await h.store.readAgentRecord(out.runId!, 0)
    expect(rec).toMatchObject({ status: "failed", error: "stopped by user" })
    const journal = readFileSync(join(out.transcriptDir!, "journal.jsonl"), "utf8")
    expect(JSON.parse(journal.split("\n")[0]!)).toMatchObject({ index: 0, status: "failed" })
  })

  test("P51 a single-agent stop counts as failing for resume: it and every later agent rerun", async () => {
    const runner = new FakeRunner().on("slow", { hold: true })
    const p = await h.setup({ runner })
    const src = script(`const a = await agent("A"); const r = await agent("slow"); const n = await agent("next"); return [a, r, n]`)
    const out = await p.call({ script: src })
    await runner.waitForHeld(1)
    await p.control({ action: "stop_agent", runId: out.runId, agentIndex: 1 })
    await p.notification(0)
    await p.settled(out.runId!)
    const r2 = new FakeRunner()
    const p2 = await h.setup({ runner: r2 })
    await p2.call({ script: src, resumeFromRunId: out.runId })
    await p2.notification(0)
    expect(r2.prompts).toEqual(["slow", "next"])
  })

  test("P51 stop_agent on a queued agent: it never starts and resolves to null", async () => {
    const prev = process.env.OPENCODE_WORKFLOW_MAX_CONCURRENT_AGENTS
    process.env.OPENCODE_WORKFLOW_MAX_CONCURRENT_AGENTS = "1"
    try {
      const runner = new FakeRunner().on("slow", { hold: true })
      const p = await h.setup({ runner })
      const out = await p.call({ script: script(`return await parallel([() => agent("slow"), () => agent("queued")])`) })
      await runner.waitForHeld(1)
      expect(await p.control({ action: "stop_agent", runId: out.runId, agentIndex: 1 })).toMatch(/Stopped agent 1/)
      runner.release()
      expect(p.resultOf(await p.notification(0))).toEqual(["done: slow", null])
      expect(runner.prompts).toEqual(["slow"])
    } finally {
      if (prev === undefined) delete process.env.OPENCODE_WORKFLOW_MAX_CONCURRENT_AGENTS
      else process.env.OPENCODE_WORKFLOW_MAX_CONCURRENT_AGENTS = prev
    }
  })

  test("P51 pause stops new agents from starting; resume continues", async () => {
    const runner = new FakeRunner().on("slow", { hold: true })
    const p = await h.setup({ runner })
    const out = await p.call({ script: script(`await agent("slow"); return await agent("after")`) })
    await runner.waitForHeld(1)
    expect(await p.control({ action: "pause", runId: out.runId })).toMatch(/Paused/)
    runner.release()
    await sleep(50)
    expect(runner.prompts).toEqual(["slow"])
    expect(await p.control({ action: "resume", runId: out.runId })).toMatch(/Resumed/)
    expect(p.resultOf(await p.notification(0))).toBe("done: after")
  })
})

describe("P52 save", () => {
  async function finishedRun(p: Awaited<ReturnType<Harness["setup"]>>, name = "my-flow") {
    const out = await p.call({ script: script(`return "saved!"`, `{ name: "${name}", description: "my saved flow" }`) })
    await p.notification(p.notifications().length)
    await p.settled(out.runId!)
    return out
  }

  test("P52 save to the project location .opencode/workflows/ registers /<name>", async () => {
    const p = await h.setup()
    const out = await finishedRun(p)
    const msg = await p.control({ action: "save", runId: out.runId })
    const target = join(h.projectDir, ".opencode", "workflows", "my-flow.js")
    expect(msg).toContain(target)
    expect(readFileSync(target, "utf8")).toBe(readFileSync(out.scriptPath!, "utf8"))
    expect(p.commands().has("my-flow")).toBe(true)
  })

  test("P52 save to the personal location <config>/opencode/workflows/", async () => {
    const p = await h.setup()
    const out = await finishedRun(p)
    const msg = await p.control({ action: "save", runId: out.runId, location: "personal" })
    const target = join(h.configHome, "opencode", "workflows", "my-flow.js")
    expect(msg).toContain(target)
    expect(existsSync(target)).toBe(true)
  })

  test("P52 project save goes to the closest existing .opencode/workflows between cwd and repo root", async () => {
    const pkg = join(h.projectDir, "packages", "app")
    mkdirSync(join(h.projectDir, "packages", ".opencode", "workflows"), { recursive: true })
    mkdirSync(pkg, { recursive: true })
    const p = await h.setup({ fake: { directory: pkg } })
    const out = await finishedRun(p)
    const msg = await p.control({ action: "save", runId: out.runId })
    expect(msg).toContain(join(h.projectDir, "packages", ".opencode", "workflows", "my-flow.js"))
  })

  test("P52 project save refuses to write through a symlinked .opencode", async () => {
    const real = join(h.base, "elsewhere")
    mkdirSync(join(real, "workflows"), { recursive: true })
    symlinkSync(real, join(h.projectDir, ".opencode"), "junction")
    const p = await h.setup()
    const out = await finishedRun(p)
    expect(await p.control({ action: "save", runId: out.runId })).toMatch(/symlink/)
    expect(existsSync(join(real, "workflows", "my-flow.js"))).toBe(false)
  })

  test("P52 project save refuses a symlinked .opencode/workflows", async () => {
    const real = join(h.base, "elsewhere")
    mkdirSync(real, { recursive: true })
    mkdirSync(join(h.projectDir, ".opencode"), { recursive: true })
    symlinkSync(real, join(h.projectDir, ".opencode", "workflows"), "junction")
    const p = await h.setup()
    const out = await finishedRun(p)
    expect(await p.control({ action: "save", runId: out.runId })).toMatch(/symlink/)
    expect(existsSync(join(real, "my-flow.js"))).toBe(false)
  })

  test("P52 personal save follows a linked config dir but refuses a symlinked target file", async () => {
    // A dotfiles-managed personal dir (link) is fine.
    const real = join(h.base, "dotfiles")
    mkdirSync(real, { recursive: true })
    mkdirSync(join(h.configHome, "opencode"), { recursive: true })
    symlinkSync(real, join(h.configHome, "opencode", "workflows"), "junction")
    const p = await h.setup()
    const out = await finishedRun(p)
    expect(await p.control({ action: "save", runId: out.runId, location: "personal" })).toMatch(/Saved/)
    expect(existsSync(join(real, "my-flow.js"))).toBe(true)
    // The target file itself being a link is refused.
    const out2 = await finishedRun(p, "linked")
    symlinkSync(join(h.base, "somewhere"), join(real, "linked.js"), "junction")
    expect(await p.control({ action: "save", runId: out2.runId, location: "personal" })).toMatch(/symlink/)
  })
})

describe("P53 saved workflows as commands", () => {
  function saveAt(dir: string, file: string, name: string, description: string, body = `return args`) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, file), script(body, `{ name: "${name}", description: "${description}" }`))
  }

  test("P53 project and personal workflows run as /<name>; project wins a name clash", async () => {
    saveAt(join(h.projectDir, ".opencode", "workflows"), "a.js", "shared", "project one")
    saveAt(join(h.configHome, "opencode", "workflows"), "b.js", "shared", "personal one")
    saveAt(join(h.configHome, "opencode", "workflows"), "c.js", "mine", "personal only")
    const p = await h.setup()
    const cmds = p.commands()
    expect(cmds.get("shared")!.description).toContain("project one")
    expect(cmds.get("mine")!.description).toContain("personal only")
  })

  test("P53 the closest .opencode/workflows to the working directory wins", async () => {
    const pkg = join(h.projectDir, "packages", "app")
    saveAt(join(h.projectDir, ".opencode", "workflows"), "x.js", "lint", "root lint")
    saveAt(join(pkg, ".opencode", "workflows"), "x.js", "lint", "package lint")
    saveAt(join(h.projectDir, ".opencode", "workflows"), "y.js", "rootonly", "root only")
    const p = await h.setup({ fake: { directory: pkg } })
    expect(p.commands().get("lint")!.description).toContain("package lint")
    expect(p.commands().has("rootonly")).toBe(true)
  })

  test("P53 /<name> passes the rest of the line as args and launches through the workflow tool", async () => {
    saveAt(join(h.projectDir, ".opencode", "workflows"), "t.js", "triage", "triage issues", `return "triaged: " + args`)
    const p = await h.setup()
    await p.command("triage", "issues 1024, 1025 and 1030")
    const prompt = p.prompts.at(-1)
    expect(prompt.sessionID).toBe(SESSION)
    const input = JSON.parse(String(prompt.text).match(/\{"name".*\}/)![0])
    expect(input).toEqual({ name: "triage", args: "issues 1024, 1025 and 1030" })
    // What the model then does with that instruction:
    await p.call(input)
    expect(p.resultOf(await p.notification(0))).toBe("triaged: issues 1024, 1025 and 1030")
  })

  test("P53 /<name> hands the model the raw line and asks it to pass structured args when the workflow expects them", async () => {
    mkdirSync(join(h.projectDir, ".opencode", "workflows"), { recursive: true })
    writeFileSync(
      join(h.projectDir, ".opencode", "workflows", "t.js"),
      script(`return args.map((n) => n * 2)`, `{ name: "triage-issues", description: "triage GitHub issues", whenToUse: "args is an array of issue numbers" }`),
    )
    const p = await h.setup()
    await p.command("triage-issues", "on issues 1024, 1025, and 1030")
    const text = String(p.prompts.at(-1).text)
    expect(text).toContain("on issues 1024, 1025, and 1030")
    expect(text).toContain("args is an array of issue numbers") // whenToUse guides the shape
    expect(text).toMatch(/structured/i)
    expect(text).toMatch(/array/i)
    // What the model then does (as Claude does): pass the list as real JSON.
    await p.call({ name: "triage-issues", args: [1024, 1025, 1030] })
    expect(p.resultOf(await p.notification(0))).toEqual([2048, 2050, 2060])
  })

  test("P53 /<name> with an empty line omits args (the global is undefined)", async () => {
    saveAt(join(h.projectDir, ".opencode", "workflows"), "t.js", "noargs", "d", `return typeof args`)
    const p = await h.setup()
    await p.command("noargs", "   ")
    const input = JSON.parse(String(p.prompts.at(-1).text).match(/\{"name".*\}/)![0])
    expect(input).toEqual({ name: "noargs" })
    await p.call(input)
    expect(p.resultOf(await p.notification(0))).toBe("undefined")
  })
})

describe("P54 bundled /deep-research", () => {
  test("P54 /deep-research is registered from the bundled workflows dir and its script is valid", async () => {
    const p = await h.setup()
    expect(p.commands().has("deep-research")).toBe(true)
    const parsed = parseScript(readFileSync(join(BUNDLED_WORKFLOWS_DIR, "deep-research.js"), "utf8"))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.meta.name).toBe("deep-research")
      expect(parsed.warnings).toEqual([])
    }
  })

  test("P54 /deep-research <question> launches it with the question as args", async () => {
    const p = await h.setup()
    await p.command("deep-research", "What changed in the Node.js permission model between v20 and v22?")
    const text = String(p.prompts.at(-1).text)
    expect(text).toContain(JSON.stringify({ name: "deep-research", args: "What changed in the Node.js permission model between v20 and v22?" }))
  })

  test("P54 deep-research without a question fails with a helpful error", async () => {
    const p = await h.setup()
    await p.call({ name: "deep-research" })
    const text = String((await p.notification(0)).text)
    expect(tag(text, "status")).toBe("failed")
    expect(text).toMatch(/needs a question/)
  })
})

describe("P55 large-workflow warning", () => {
  test(`P55 more than ${LARGE_WORKFLOW_AGENT_THRESHOLD} scheduled agents → one Large workflow warning in status and the notification`, async () => {
    const p = await h.setup()
    const out = await p.call({ script: script(`return (await parallel(Array.from({ length: 30 }, (_, i) => () => agent("a" + i)))).length`) })
    const n = await p.notification(0)
    expect(p.resultOf(n)).toBe(30) // advisory only: nothing is limited
    const warnings = tag(String(n.text), "warnings") ?? ""
    expect(warnings.match(/Large workflow/g)?.length).toBe(1)
    await p.settled(out.runId!)
    expect(await p.control({ action: "status", runId: out.runId })).toMatch(/Large workflow/)
  })

  test("P55 exactly 25 agents does not warn", async () => {
    const p = await h.setup()
    await p.call({ script: script(`return (await parallel(Array.from({ length: 25 }, (_, i) => () => agent("a" + i)))).length`) })
    const n = await p.notification(0)
    expect(String(n.text)).not.toMatch(/Large workflow/)
  })
})

describe("P56 approval", () => {
  test("P56 DEGRADED: launching is an ordinary `workflow` tool call, so opencode permission rules for `workflow` gate it", async () => {
    const p = await h.setup()
    const tool = p.tools().get("workflow")!
    expect(tool.name).toBe("workflow")
    expect(tool.options?.codemode).toBe(false)
  })

  test("P56 DEGRADED: /<name> commands never bypass the tool (and its permission check): they only prompt the model", async () => {
    const p = await h.setup()
    await p.command("deep-research", "a question")
    await sleep(30)
    expect(p.runner.calls.length).toBe(0)
    expect(await h.store.listRuns()).toEqual([])
    expect(String(p.prompts.at(-1).text)).toContain("`workflow` tool")
  })

  test("P56 the planned phases are shown to the user in the launch summary/tool description context", async () => {
    // No approval dialog: the phases are visible in /workflows as soon as the run starts.
    const runner = new FakeRunner().on("slow", { hold: true })
    const p = await h.setup({ runner })
    const out = await p.call({
      script: script(`return await agent("slow")`, `{ name: "phased", description: "d", phases: [{ title: "Plan" }, { title: "Build" }] }`),
    })
    await runner.waitForHeld(1)
    const status = await p.control({ action: "status", runId: out.runId })
    expect(status).toContain("Plan")
    expect(status).toContain("Build")
    runner.release()
    await p.notification(0)
  })
})

describe("P57 disable switch", () => {
  for (const v of ["1", "true", "yes", "on"]) {
    test(`P57 OPENCODE_DISABLE_WORKFLOWS=${v} removes the tools and commands`, async () => {
      const p = await h.setup({ env: { OPENCODE_DISABLE_WORKFLOWS: v } })
      expect(p.tools().size).toBe(0)
      expect(p.commands().size).toBe(0)
    })
  }

  test("P57 plugin option disabled:true removes the tools and commands (incl. /deep-research and /workflow-authoring)", async () => {
    const p = await h.setup({ options: { disabled: true } })
    expect(p.tools().has("workflow")).toBe(false)
    expect(p.commands().has("deep-research")).toBe(false)
    expect(p.commands().has("workflow-authoring")).toBe(false)
  })

  test("P57 enabled by default", async () => {
    const p = await h.setup({ env: { OPENCODE_DISABLE_WORKFLOWS: "0" } })
    expect([...p.tools().keys()].sort()).toEqual(["workflow", "workflow_control", "workflow_submit"])
    expect(p.commands().has("workflows")).toBe(true)
    expect(p.commands().has("workflow-authoring")).toBe(true)
  })
})

describe("P59 whenToUse and the saved-workflow list", () => {
  function save(file: string, meta: string) {
    const dir = join(h.projectDir, ".opencode", "workflows")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, file), script(`return 1`, meta))
  }

  test("P59 the /<name> command description includes meta.whenToUse", async () => {
    save("w.js", `{ name: "audit", description: "audit routes", whenToUse: "WHEN-MARKER after adding routes" }`)
    const p = await h.setup()
    const d = p.commands().get("audit")!.description
    expect(d).toContain("audit routes")
    expect(d).toContain("WHEN-MARKER after adding routes")
  })

  test("P59 the workflow tool description lists saved and bundled workflows (name, description, whenToUse)", async () => {
    save("w.js", `{ name: "audit", description: "audit routes", whenToUse: "WHEN-MARKER after adding routes" }`)
    const p = await h.setup()
    const d = p.tools().get("workflow")!.description
    expect(d).toContain("audit")
    expect(d).toContain("audit routes")
    expect(d).toContain("WHEN-MARKER after adding routes")
    expect(d).toContain("deep-research")
  })

  test("P59 the list is rebuilt on reload: a workflow saved after setup appears in the tool description", async () => {
    const p = await h.setup()
    expect(p.tools().get("workflow")!.description).not.toContain("late-one")
    save("late.js", `{ name: "late-one", description: "saved later" }`)
    expect(p.tools().get("workflow")!.description).toContain("late-one")
  })
})

describe("P58 authoring reference", () => {
  test("P58 the tool description tells the model when to use it and points to /workflow-authoring", async () => {
    const p = await h.setup()
    const d = p.tools().get("workflow")!.description
    expect(d.startsWith(TOOL_DESCRIPTION)).toBe(true)
    for (const s of ["ultracode", "agent(", "pipeline(", "parallel(", "/workflow-authoring", "export const meta"]) expect(d).toContain(s)
  })

  test("P58 tool description and reference say meta.phases only labels groups and phase() must be called per stage", () => {
    for (const text of [TOOL_DESCRIPTION, AUTHORING_REFERENCE]) {
      expect(text).toMatch(/meta\.phases only LABELS/)
      expect(text).toMatch(/call phase\(title\)/i)
      expect(text).toContain("agent({phase})")
      expect(text).toContain("(no phase)")
    }
    // The tool description's script shape uses phase() itself.
    expect(TOOL_DESCRIPTION).toMatch(/phase\('[^']+'\)[\s\S]*agent\(/)
  })

  test("P58 the reference documents the whole script API, limits and resume", () => {
    for (const s of ["agent(", "pipeline(", "parallel(", "phase(", "log(", "budget", "workflow(", "args", "schema", "resumeFromRunId", "4096", "1000", "Date.now", "Math.random"]) {
      expect(AUTHORING_REFERENCE).toContain(s)
    }
  })

  test("P58 /workflow-authoring loads the reference into the session without waking the model", async () => {
    const p = await h.setup()
    await p.command("workflow-authoring")
    expect(p.synthetic.length).toBe(1)
    expect(p.synthetic[0].text).toContain(AUTHORING_REFERENCE)
    expect(p.synthetic[0].resume).toBe(false)
    expect(p.prompts.length).toBe(0)
  })

  test("P58 /workflow-authoring <text> also prompts the model with the text", async () => {
    const p = await h.setup()
    await p.command("workflow-authoring", "edit my saved flow")
    expect(p.prompts.at(-1).text).toBe("edit my saved flow")
  })
})
