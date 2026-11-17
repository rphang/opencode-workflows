// Parity: Claude Code workflow behaviors outside the main script API (P70–P76): the size
// guideline, the fan-out prefix stagger, plugin-namespaced workflows, restarting one agent, and
// what the transcript dir holds, session-scoped run management and scriptPath read permissions.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { listWorkflows } from "../../src/registry.ts"
import { FakeRunner } from "../helpers/fake-runner.ts"
import { createHarness, script, SESSION, tag, tctx, type Harness } from "../helpers/plugin-harness.ts"

let h: Harness
beforeEach(async () => {
  h = await createHarness()
})
afterEach(async () => {
  await h.dispose()
})

const fanOut = (n: number) => script(`return (await parallel(Array.from({ length: ${n} }, (_, i) => () => agent("a" + i)))).length`)

describe("P70 size guideline", () => {
  test("P70 the default guideline is medium: the tool advises fewer than 10 agents and the Large workflow threshold stays 25", async () => {
    const p = await h.setup()
    expect(p.tools().get("workflow")!.description).toMatch(/fewer than 10 agents/)
    await p.call({ script: fanOut(20) })
    expect(String((await p.notification(0)).text)).not.toMatch(/Large workflow/)
  })

  test("P70 a guideline the user chose (plugin option sizeGuideline) is advised and its agent count replaces the 25-agent threshold", async () => {
    const p = await h.setup({ options: { sizeGuideline: "small" } })
    expect(p.tools().get("workflow")!.description).toMatch(/fewer than 5 agents/)
    await p.call({ script: fanOut(5) })
    expect(String((await p.notification(0)).text)).not.toMatch(/Large workflow/)
    await p.call({ script: fanOut(6) })
    const n = await p.notification(1)
    expect(p.resultOf(n)).toBe(6) // advisory only
    expect(tag(String(n.text), "warnings")).toMatch(/Large workflow: more than 5 agents/)
  })

  test("P70 env OPENCODE_WORKFLOW_SIZE_GUIDELINE=unrestricted: no size advice, threshold 25", async () => {
    const p = await h.setup({ env: { OPENCODE_WORKFLOW_SIZE_GUIDELINE: "unrestricted" } })
    expect(p.tools().get("workflow")!.description).not.toMatch(/fewer than \d+ agents/)
    await p.call({ script: fanOut(26) })
    expect(tag(String((await p.notification(0)).text), "warnings")).toMatch(/more than 25 agents/)
  })

  test("P70 an unknown value falls back to the default guideline", async () => {
    const p = await h.setup({ options: { sizeGuideline: "huge" } })
    expect(p.tools().get("workflow")!.description).toMatch(/fewer than 10 agents/)
  })
})

describe("P71 fan-out prefix stagger", () => {
  test("P71 DEGRADED: agents sharing a prompt-cache prefix all start at once (no hold behind the first)", async () => {
    const runner = new FakeRunner().on("held", { hold: true })
    const p = await h.setup({ runner })
    await p.call({ script: script(`return await parallel([1, 2, 3].map((i) => () => agent("held " + i)))`) })
    await runner.waitForRunning(3)
    runner.release()
    expect(p.resultOf(await p.notification(0))).toEqual(["done: held 1", "done: held 2", "done: held 3"])
  })
})

describe("P72 plugin-namespaced workflows", () => {
  test("P72 N/A: workflows load only from project, personal and bundled dirs; a `plugin:name` is never a command", async () => {
    const dir = join(h.projectDir, ".opencode", "workflows")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "ns.js"), script(`return 1`, `{ name: "acme-tools:release-audit", description: "d" }`))
    const origins = new Set(listWorkflows(h.projectDir, { configHome: h.configHome }).map((w) => w.origin))
    for (const o of origins) expect(["project", "personal", "bundled"]).toContain(o)
    const p = await h.setup()
    expect(p.commands().has("acme-tools:release-audit")).toBe(false)
  })
})

describe("P73 restart one agent", () => {
  test("P73 DEGRADED: there is no restart action; stop_agent then a resume reruns that agent instead", async () => {
    const runner = new FakeRunner().on("slow", { hold: true })
    const p = await h.setup({ runner })
    const out = await p.call({ script: script(`return await agent("slow")`) })
    await runner.waitForHeld(1)
    expect(await p.control({ action: "restart_agent", runId: out.runId, agentIndex: 0 } as any)).toMatch(/unknown action/)
    await p.control({ action: "stop", runId: out.runId })
    await p.notification(0)
  })
})

describe("P74 transcripts", () => {
  test("P74 DEGRADED: agents/<i>.json holds the prompt, result, usage and the child session id (the transcript itself stays in that opencode session)", async () => {
    const p = await h.setup()
    const out = await p.call({ script: script(`return await agent("hello")`) })
    await p.notification(0)
    await p.settled(out.runId!)
    const rec = JSON.parse(readFileSync(join(out.transcriptDir!, "agents", "0.json"), "utf8"))
    expect(rec).toMatchObject({ prompt: "hello", result: "done: hello", sessionID: "ses_fake_0", status: "completed" })
    expect(rec.usage.output).toBe(10)
  })
})

describe("P75 run management is scoped to the launching session", () => {
  const OTHER = "ses_other00000000000000000000"

  test("P75 status/stop/stop_agent/pause/resume/save and /workflows <runId> refuse another session's run", async () => {
    const runner = new FakeRunner().on("held", { hold: true })
    const p = await h.setup({ runner })
    const out = await p.call({ script: script(`log("SECRET-TOKEN-123"); return await agent("held")`, `{ name: "secret", description: "s" }`) })
    await runner.waitForHeld(1)
    for (const action of ["status", "stop", "pause", "resume", "save", "result"]) {
      const msg = await p.control({ action, runId: out.runId }, OTHER)
      expect(msg).toMatch(/not found in this session/)
      expect(msg).not.toContain("SECRET-TOKEN-123")
    }
    expect(await p.control({ action: "stop_agent", runId: out.runId, agentIndex: 0 }, OTHER)).toMatch(/not found in this session/)
    expect(existsSync(join(h.projectDir, ".opencode", "workflows"))).toBe(false)
    await p.command("workflows", out.runId!, OTHER)
    const shown = String(p.synthetic.at(-1)!.text)
    expect(shown).toMatch(/not found in this session/)
    expect(shown).not.toContain("SECRET-TOKEN-123")
    // The run was untouched and its own session still manages it.
    expect(await p.control({ action: "status", runId: out.runId })).toContain("SECRET-TOKEN-123")
    expect(await p.control({ action: "stop", runId: out.runId })).toContain("Stopping run")
  })

  test("P75 a finished run of another session is not readable either (run.json on disk)", async () => {
    const p = await h.setup()
    const out = await p.call({ script: script(`log("SECRET-TOKEN-123"); return "done"`) })
    await p.notification(0)
    await p.settled(out.runId!)
    expect(await p.control({ action: "status", runId: out.runId }, OTHER)).toMatch(/not found in this session/)
    expect(await p.control({ action: "status", runId: out.runId })).toContain("SECRET-TOKEN-123")
  })
})

describe("P76 scriptPath reads follow opencode's file permissions", () => {
  const body = (v: string) => script(`return ${JSON.stringify(v)}`)

  test("P76 UNC and device paths are refused before any file access", async () => {
    const p = await h.setup()
    for (const sp of ["\\\\attacker.example\\share\\x.js", "//attacker.example/share/x.js", "\\\\?\\C:\\Windows\\win.ini", "\\\\.\\C:\\x.js"]) {
      const out = await p.call({ scriptPath: sp })
      expect(out.error).toMatch(/UNC|device/)
      expect(out.transcriptDir).toBeUndefined()
    }
  })

  test("P76 a path outside the project (absolute or ../) is refused unless external_directory allows it; nothing is copied", async () => {
    writeFileSync(join(h.base, "outside.js"), body("outside"))
    const p = await h.setup()
    for (const sp of [join(h.base, "outside.js"), "../outside.js"]) {
      const out = await p.call({ scriptPath: sp })
      expect(out.error).toMatch(/outside the project.*external_directory/)
      expect(out.transcriptDir).toBeUndefined()
    }
    expect(p.notifications().length).toBe(0)
  })

  test("P76 an external_directory allow rule in the parent's rules admits the outside path", async () => {
    writeFileSync(join(h.base, "outside.js"), body("outside-ok"))
    const p = await h.setup({ fake: { parent: { permissions: [{ action: "external_directory", resource: join(h.base, "*"), effect: "allow" }] } } })
    const out = await p.call({ scriptPath: join(h.base, "outside.js") })
    expect(out.error).toBeUndefined()
    expect(p.resultOf(await p.notification(0))).toBe("outside-ok")
  })

  test("P76 a read deny rule refuses a project file", async () => {
    writeFileSync(join(h.projectDir, "flow.secret.js"), body("secret"))
    const p = await h.setup({ fake: { parent: { permissions: [{ action: "read", resource: "*.secret.js", effect: "deny" }] } } })
    const out = await p.call({ scriptPath: "flow.secret.js" })
    expect(out.error).toMatch(/read permission/)
    expect(out.transcriptDir).toBeUndefined()
  })

  test("P76 a junction inside the project that points outside is judged by its real target", async () => {
    const real = join(h.base, "elsewhere")
    mkdirSync(real, { recursive: true })
    writeFileSync(join(real, "x.js"), body("via-link"))
    symlinkSync(real, join(h.projectDir, "linked"), "junction")
    const p = await h.setup()
    const out = await p.call({ scriptPath: "linked/x.js" })
    expect(out.error).toMatch(/outside the project/)
  })

  // A path can have several spellings that resolve to the same place: a Windows 8.3 short name
  // (C:\Users\RUNNER~1), macOS /var -> /private/var, a junction or symlinked directory. The user writes
  // rules and paths with the spelling they see, so it must not matter which one reaches the plugin.
  // A directory junction/symlink reproduces the alias portably.
  const aliasOf = (dir: string) => {
    const alias = `${dir}-alias`
    symlinkSync(dir, alias, "junction")
    return alias
  }

  test("P76 an external_directory rule spelled through a directory alias admits the outside path", async () => {
    writeFileSync(join(h.base, "outside.js"), body("alias-ok"))
    const alias = aliasOf(h.base)
    try {
      const p = await h.setup({ fake: { parent: { permissions: [{ action: "external_directory", resource: join(alias, "*"), effect: "allow" }] } } })
      const out = await p.call({ scriptPath: join(alias, "outside.js") })
      expect(out.error).toBeUndefined()
      expect(p.resultOf(await p.notification(0))).toBe("alias-ok")
    } finally {
      rmSync(alias, { recursive: false, force: true })
    }
  })

  test("P76 a missing file inside the project, reached through an alias, is reported as unreadable (not outside)", async () => {
    const alias = aliasOf(h.base)
    try {
      const p = await h.setup()
      const out = await p.call({ scriptPath: join(alias, "proj", "missing.js") })
      expect(out.error).toMatch(/cannot read scriptPath/)
    } finally {
      rmSync(alias, { recursive: false, force: true })
    }
  })

  test("P76 project files and the run's own script copy are accepted", async () => {
    writeFileSync(join(h.projectDir, "in.js"), body("inside"))
    const p = await h.setup()
    const out = await p.call({ scriptPath: "in.js" })
    expect(out.error).toBeUndefined()
    expect(p.resultOf(await p.notification(0))).toBe("inside")
    const first = await p.call({ script: body("copy") })
    await p.notification(1)
    const again = await p.call({ scriptPath: first.scriptPath })
    expect(again.error).toBeUndefined()
    expect(p.resultOf(await p.notification(2))).toBe("copy")
  })

  test("P76 workflow({scriptPath}) inside a script applies the same rules", async () => {
    writeFileSync(join(h.base, "outside.js"), body("outside"))
    const p = await h.setup()
    await p.call({
      script: script(
        `const out = []; for (const sp of [${JSON.stringify(join(h.base, "outside.js"))}, ${JSON.stringify("\\\\host\\share\\x.js")}]) { try { await workflow({ scriptPath: sp }); out.push("ran") } catch (e) { out.push(e.message) } } return out`,
      ),
    })
    const res = p.resultOf(await p.notification(0)) as string[]
    expect(res[0]).toMatch(/outside the project/)
    expect(res[1]).toMatch(/UNC|device/)
  })
})

// opencode 2.3.0 ctx.permission.assert: the plugin asks through opencode's own prompt in the calling
// session (a root session the user sees), with the same resources opencode's read tool uses, and
// honours saved "always" approvals. Without it (older hosts) the rules are evaluated as above.
describe("P76 scriptPath approval through ctx.permission.assert", () => {
  const body = (v: string) => script(`return ${JSON.stringify(v)}`)
  const outsideDir = () => join(h.base, "outside")
  const writeOutside = (v: string) => {
    mkdirSync(outsideDir(), { recursive: true })
    const file = join(outsideDir(), "flow.js")
    writeFileSync(file, body(v))
    return file
  }
  const slash = (p: string) => p.replaceAll("\\", "/")
  // opencode's default agents allow reading everything (except .env files).
  const readAll = { action: "read", resource: "*", effect: "allow" }

  test("P76 an outside path asks for external_directory in the calling session, tied to the tool call; approving runs it", async () => {
    const file = writeOutside("approved")
    const p = await h.setup({ fake: { permissionAsk: () => "once", parent: { permissions: [readAll] } } })
    const out = await p.call({ scriptPath: file })
    expect(out.error).toBeUndefined()
    expect(p.resultOf(await p.notification(0))).toBe("approved")
    const asked = p.fake.calls.asked
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({
      sessionID: SESSION,
      agent: "build",
      action: "external_directory",
      resources: [slash(join(realpathSync(outsideDir()), "*"))],
      save: [slash(join(realpathSync(outsideDir()), "*"))],
      source: { type: "tool", messageID: "msg_1", id: "call_1" },
    })
    // The read check goes through opencode too (allowed by the read rule, so no second prompt).
    expect(p.fake.calls.assert.map((a) => a.action)).toEqual(["external_directory", "read"])
  })

  test("P76 an \"always\" approval is saved: the next launch from that directory does not ask again", async () => {
    const file = writeOutside("again")
    const p = await h.setup({ fake: { permissionAsk: () => "always", parent: { permissions: [readAll] } } })
    expect((await p.call({ scriptPath: file })).error).toBeUndefined()
    await p.notification(0)
    const asked = p.fake.calls.asked.filter((r) => r.action === "external_directory").length
    expect((await p.call({ scriptPath: file })).error).toBeUndefined()
    await p.notification(1)
    expect(p.fake.calls.asked.filter((r) => r.action === "external_directory").length).toBe(asked)
  })

  test("P76 a rejected prompt fails the tool call itself, as for opencode's own tools; nothing runs or is copied", async () => {
    const file = writeOutside("never")
    const p = await h.setup({ fake: { permissionAsk: () => "reject" } })
    const tool = p.tools().get("workflow")!
    let thrown: any
    try {
      await tool.execute({ scriptPath: file }, tctx())
    } catch (e) {
      thrown = e
    }
    expect(thrown?._tag).toBe("Permission.DeclinedError")
    expect(await h.store.listRuns()).toEqual([])
    expect(p.notifications()).toHaveLength(0)
  })

  test("P76 a rejection with feedback, or a deny rule, is the tool's error (a deny never prompts)", async () => {
    const file = writeOutside("never")
    const p = await h.setup({ fake: { permissionAsk: () => ({ reject: "use the project copy" }) } })
    const out = await p.call({ scriptPath: file })
    expect(out.error).toMatch(/outside the project.*external_directory/)
    expect(out.error).toContain("use the project copy")
    expect(out.transcriptDir).toBeUndefined()

    const denyRule = { action: "external_directory", resource: slash(join(outsideDir(), "*")), effect: "deny" }
    const q = await h.setup({ fake: { permissionAsk: () => "once", parent: { permissions: [denyRule] } } })
    const denied = await q.call({ scriptPath: file })
    expect(denied.error).toMatch(/outside the project.*external_directory/)
    expect(q.fake.calls.asked).toHaveLength(0)
  })

  test("P76 a read rule that asks prompts for the project file; a read deny refuses without a prompt", async () => {
    writeFileSync(join(h.projectDir, "flow.secret.js"), body("secret-ok"))
    const ask = { action: "read", resource: "*.secret.js", effect: "ask" }
    const p = await h.setup({ fake: { permissionAsk: () => "once", parent: { permissions: [readAll, ask] } } })
    const out = await p.call({ scriptPath: "flow.secret.js" })
    expect(out.error).toBeUndefined()
    expect(p.fake.calls.asked).toMatchObject([{ action: "read", resources: ["flow.secret.js"] }])
    expect(p.resultOf(await p.notification(0))).toBe("secret-ok")

    const deny = { action: "read", resource: "*.secret.js", effect: "deny" }
    const q = await h.setup({ fake: { permissionAsk: () => "once", parent: { permissions: [deny] } } })
    expect((await q.call({ scriptPath: "flow.secret.js" })).error).toMatch(/read permission/)
    expect(q.fake.calls.asked).toHaveLength(0)
  })

  test("P76 workflow({scriptPath}) inside a running script never prompts: an ask is refused, a saved approval admits it", async () => {
    const file = writeOutside("nested-ok")
    const p = await h.setup({ fake: { permissionAsk: () => "always", parent: { permissions: [readAll] } } })
    const nested = script(`try { return await workflow({ scriptPath: ${JSON.stringify(file)} }) } catch (e) { return "refused: " + e.message }`)
    await p.call({ script: nested })
    expect(String(p.resultOf(await p.notification(0)))).toMatch(/^refused: .*outside the project/)
    expect(p.fake.calls.asked).toHaveLength(0)
    // Approved "always" from a tool call (the user saw that prompt): the nested call is admitted.
    expect((await p.call({ scriptPath: file })).error).toBeUndefined()
    await p.notification(1)
    await p.call({ script: nested })
    expect(p.resultOf(await p.notification(2))).toBe("nested-ok")
  })

  test("P76 a rule spelled through a directory alias still admits the path without a prompt", async () => {
    writeFileSync(join(h.base, "outside.js"), body("alias-ok"))
    const alias = `${h.base}-alias`
    symlinkSync(h.base, alias, "junction")
    try {
      const rule = { action: "external_directory", resource: join(alias, "*"), effect: "allow" }
      const p = await h.setup({
        fake: {
          permissionAsk: () => {
            throw new Error("unexpected prompt")
          },
          parent: { permissions: [readAll, rule] },
        },
      })
      const out = await p.call({ scriptPath: join(alias, "outside.js") })
      expect(out.error).toBeUndefined()
      expect(p.resultOf(await p.notification(0))).toBe("alias-ok")
    } finally {
      rmSync(alias, { recursive: false, force: true })
    }
  })
})
