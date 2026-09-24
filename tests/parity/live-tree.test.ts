// Extensions beyond Claude Code (docs/PARITY.md "Extensions", X10–X13): the phase model label, live
// agent activity, and the `dynamic-workflows` RPC + coalesced events that feed the TUI progress tree,
// through the real plugin over the fake opencode ctx.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { MAX_MESSAGE_CHARS } from "../../src/mailbox.ts"
import { FakeRunner, sleep } from "../helpers/fake-runner.ts"
import { createHarness, script, SESSION, waitFor, type Harness, type Plugged } from "../helpers/plugin-harness.ts"

let h: Harness
beforeEach(async () => {
  h = await createHarness()
})
afterEach(async () => {
  await h.dispose()
})

const OTHER = "ses_other00000000000000000000"
const LABELED = `{ name: "labeled", description: "d", phases: [{ title: "Scan", model: "openai/gpt-5.4" }, { title: "Judge", model: "strong" }] }`
const shown = (p: Plugged) => String(p.synthetic.at(-1)?.text ?? "")

/** True when `v` survives a JSON round trip unchanged and holds no undefined anywhere. */
function strictJson(v: unknown): boolean {
  const walk = (x: unknown): boolean => {
    if (x === undefined || typeof x === "function") return false
    if (typeof x === "number") return Number.isFinite(x)
    if (Array.isArray(x)) return x.every(walk)
    if (x && typeof x === "object") return Object.values(x).every(walk)
    return true
  }
  return walk(v) && JSON.stringify(JSON.parse(JSON.stringify(v))) === JSON.stringify(v)
}

const childEvent = (sessionID: string, type: string, data: Record<string, unknown> = {}) => ({
  type,
  created: Date.now(),
  location: { directory: "<project>" },
  data: { sessionID, assistantMessageID: "msg_1", ...data },
})

describe("X10 phase model label", () => {
  test("X10 P50 /workflows and /workflows <runId> show meta.phases[].model next to the phase", async () => {
    const runner = new FakeRunner().on("slow", { hold: true })
    const p = await h.setup({ runner })
    const out = await p.call({ script: script(`phase("Scan"); await agent("slow scan"); phase("Judge"); return await agent("judge")`, LABELED) })
    await runner.waitForHeld(1)
    await p.command("workflows")
    expect(shown(p)).toMatch(/Scan \(openai\/gpt-5\.4\)\s+0\/1\s+1 running/)
    expect(shown(p)).toMatch(/Judge \(strong\)\s+0\/0/)
    await p.command("workflows", out.runId!)
    expect(shown(p)).toMatch(/Scan \(openai\/gpt-5\.4\)/)
    runner.release()
    await p.notification(0)
    await p.settled(out.runId!)
    await p.command("workflows", out.runId!)
    expect(shown(p)).toMatch(/Scan \(openai\/gpt-5\.4\)\s+1\/1/)
    expect(shown(p)).toMatch(/Judge \(strong\)\s+1\/1/)
    // Display only: no agent ran on the label.
    expect(runner.calls.map((c) => c.opts.model)).toEqual([undefined, undefined])
  })

  test("X10 P50 workflow_control status and list show the label to the model (still without the result, P77)", async () => {
    const runner = new FakeRunner().on("slow", { hold: true })
    const p = await h.setup({ runner })
    const out = await p.call({ script: script(`phase("Scan"); return await agent("slow scan")`, LABELED) })
    await runner.waitForHeld(1)
    expect(await p.control({ action: "status", runId: out.runId })).toMatch(/Scan \(openai\/gpt-5\.4\)/)
    expect(await p.control({ action: "list" })).toMatch(/Scan \(openai\/gpt-5\.4\)/)
    runner.release()
    await p.notification(0)
    await p.settled(out.runId!)
    const status = await p.control({ action: "status", runId: out.runId })
    expect(status).toMatch(/Scan \(openai\/gpt-5\.4\)/)
    expect(status).not.toMatch(/Result:/)
  })

  test("X10 P50 the RPC views carry the label and run.json keeps it", async () => {
    const runner = new FakeRunner().on("slow", { hold: true })
    const p = await h.setup({ runner })
    const out = await p.call({ script: script(`phase("Scan"); return await agent("slow scan")`, LABELED) })
    await runner.waitForHeld(1)
    const st = await p.rpcCall("status", { runId: out.runId })
    expect(st.ok).toBe(true)
    expect(st.run.phases.map((x: any) => [x.title, x.model])).toEqual([
      ["Scan", "openai/gpt-5.4"],
      ["Judge", "strong"],
    ])
    runner.release()
    await p.notification(0)
    await p.settled(out.runId!)
    const stored = await h.store.readSummary(out.runId!)
    expect(stored?.phases[0]).toMatchObject({ title: "Scan", model: "openai/gpt-5.4" })
  })
})

describe("X11 live activity", () => {
  test("X11 /workflows <runId> shows what a running agent is doing and its live tokens; recorded usage is unchanged", async () => {
    const runner = new FakeRunner().on("slow", { hold: true, usage: { output: 7 } })
    const p = await h.setup({ runner })
    const out = await p.call({ script: script(`const r = await agent("slow one", { label: "worker" }); return budget.spent()`) })
    await runner.waitForHeld(1)
    await waitFor(() => p.eventSubscribers() > 0, "event subscription")
    p.pushEvent(childEvent("ses_fake_0", "session.step.started", { model: { id: "m1", providerID: "prov" } }))
    p.pushEvent(childEvent("ses_fake_0", "session.tool.input.started", { id: "call_1", name: "bash" }))
    p.pushEvent(childEvent("ses_fake_0", "session.tool.called", { id: "call_1", input: { command: "npm test" } }))
    p.pushEvent(childEvent("ses_fake_0", "session.usage.updated", { cost: 0.5, tokens: { input: 12000, output: 345, reasoning: 0, cache: { read: 0, write: 0 } } }))
    // Events of sessions that are not workflow agents are ignored.
    p.pushEvent(childEvent("ses_unrelated", "session.tool.input.started", { id: "c", name: "webfetch" }))
    await sleep(20)
    await p.command("workflows", out.runId!)
    const text = shown(p)
    expect(text).toMatch(/#0 worker\s+running\s+12\.3k tokens/)
    expect(text).toMatch(/now: » bash npm test\s+\(\d+(\.\d)?s ago\)/)
    expect(text).toMatch(/model: prov\/m1/)
    expect(text).not.toMatch(/webfetch/)
    runner.release()
    const n = await p.notification(0)
    // The overlay is display only: budget.spent() and the record use the settled usage.
    expect(p.resultOf(n)).toBe(7)
    await p.settled(out.runId!)
    expect((await h.store.readAgentRecord(out.runId!, 0))?.usage.output).toBe(7)
    await p.command("workflows", out.runId!)
    expect(shown(p)).not.toMatch(/now:/)
  })

  test("P77 X11 workflow_control status never shows what a running agent is writing (no text preview); /workflows <runId> does", async () => {
    const runner = new FakeRunner().on("slow", { hold: true })
    const p = await h.setup({ runner })
    const out = await p.call({ script: script(`return await agent("slow one", { label: "worker" })`) })
    await runner.waitForHeld(1)
    await waitFor(() => p.eventSubscribers() > 0, "event subscription")
    p.pushEvent(childEvent("ses_fake_0", "session.text.started"))
    p.pushEvent(childEvent("ses_fake_0", "session.text.delta", { delta: "SECRET PARTIAL ANSWER" }))
    await sleep(20)
    const model = await p.control({ action: "status", runId: out.runId })
    expect(model).not.toMatch(/SECRET/)
    expect(model).not.toMatch(/now: “/)
    expect(model).toMatch(/now: writing…/)
    await p.command("workflows", out.runId!)
    expect(shown(p)).toMatch(/now: “SECRET PARTIAL ANSWER”/)
    // Reasoning is hidden from the model the same way; a tool call is not a result preview and stays.
    p.pushEvent(childEvent("ses_fake_0", "session.reasoning.started"))
    p.pushEvent(childEvent("ses_fake_0", "session.reasoning.delta", { delta: "SECRET THOUGHT" }))
    await sleep(20)
    expect(await p.control({ action: "status", runId: out.runId })).toMatch(/now: thinking…/)
    p.pushEvent(childEvent("ses_fake_0", "session.tool.input.started", { id: "c1", name: "bash" }))
    await sleep(20)
    expect(await p.control({ action: "status", runId: out.runId })).toMatch(/now: » bash/)
    runner.release()
    await p.notification(0)
  })

  test("X11 the RPC agent view overlays activity, tokens and cost while running, and drops them once settled", async () => {
    const runner = new FakeRunner().on("slow", { hold: true })
    const p = await h.setup({ runner })
    const out = await p.call({ script: script(`return await agent("slow one")`) })
    await runner.waitForHeld(1)
    await waitFor(() => p.eventSubscribers() > 0, "event subscription")
    p.pushEvent(childEvent("ses_fake_0", "session.text.started"))
    p.pushEvent(childEvent("ses_fake_0", "session.text.delta", { delta: "The main risk is" }))
    p.pushEvent(childEvent("ses_fake_0", "session.usage.updated", { cost: 0.25, tokens: { input: 900, output: 100, reasoning: 0, cache: { read: 0, write: 0 } } }))
    await sleep(20)
    let st = await p.rpcCall("status", { runId: out.runId })
    expect(st.agents[0]).toMatchObject({ status: "running", tokens: 1000, cost: 0.25, activity: { kind: "text", text: "The main risk is" } })
    expect(st.run.tokens).toBe(1000)
    runner.release()
    await p.notification(0)
    await p.settled(out.runId!)
    st = await p.rpcCall("status", { runId: out.runId })
    expect(st.agents[0]).toMatchObject({ status: "completed", activity: null })
  })
})

describe("X12 RPC", () => {
  test("X12 registers dynamic-workflows with list/status/control and delta/finished events; every output is strict JSON", async () => {
    const runner = new FakeRunner().on("slow", { hold: true })
    const p = await h.setup({ runner })
    const reg = p.rpc()!
    expect(reg.definition.id).toBe("dynamic-workflows")
    expect(Object.keys(reg.definition.methods).sort()).toEqual(["control", "list", "status"])
    expect(Object.keys(reg.definition.events).sort()).toEqual(["delta", "finished"])
    const out = await p.call({ script: script(`phase("A"); return await agent("slow one")`) })
    await runner.waitForHeld(1)
    const list = await p.rpcCall("list", { sessionID: SESSION })
    const status = await p.rpcCall("status", { runId: out.runId })
    const missing = await p.rpcCall("status", { runId: "wf_nope" })
    for (const v of [list, status, missing]) expect(strictJson(v)).toBe(true)
    expect(list).toMatchObject({ ok: true, directory: h.projectDir })
    expect(list.runs[0]).toMatchObject({ runId: out.runId, status: "running", parentSessionID: SESSION, directory: h.projectDir })
    expect(list.agents[0]).toMatchObject({ runId: out.runId, index: 0, status: "running", sessionID: "ses_fake_0" })
    expect(missing).toMatchObject({ ok: false })
    runner.release()
    await p.notification(0)
  })

  test("X12 list is scoped to the given session by default; all:true lists every run of this Location; limit caps it", async () => {
    const runner = new FakeRunner().on("slow", { hold: true })
    const p = await h.setup({ runner })
    const mine = await p.call({ script: script(`return await agent("slow mine")`) })
    const theirs = await p.call({ script: script(`return await agent("slow theirs")`) }, OTHER)
    await runner.waitForHeld(2)
    const ids = (r: any) => r.runs.map((x: any) => x.runId).sort()
    expect(ids(await p.rpcCall("list", { sessionID: SESSION }))).toEqual([mine.runId])
    expect(ids(await p.rpcCall("list", { sessionID: OTHER }))).toEqual([theirs.runId])
    expect(ids(await p.rpcCall("list", { all: true }))).toEqual([mine.runId, theirs.runId].sort())
    expect((await p.rpcCall("list", { all: true, limit: 1 })).runs).toHaveLength(1)
    runner.release()
    await p.notification(1)
  })

  test("X12 control runs stop_agent, pause/resume, message and stop through the host (user surface, not session-scoped)", async () => {
    const runner = new FakeRunner().on("slow", { hold: true, value: (_r, msgs) => (msgs?.length ? `got: ${msgs[0]!.text}` : "plain") })
    const p = await h.setup({ runner })
    const out = await p.call({
      script: script(`const [a, b] = await parallel([() => agent("slow a"), () => agent("slow b")]); return [a, b]`),
      OTHER,
    })
    await runner.waitForHeld(2)
    const runId = out.runId!
    const paused = await p.rpcCall("control", { runId, action: "pause" })
    expect(paused).toMatchObject({ ok: true })
    expect((await p.rpcCall("status", { runId })).run.status).toBe("paused")
    expect(await p.rpcCall("control", { runId, action: "resume" })).toMatchObject({ ok: true })
    const msg = await p.rpcCall("control", { runId, action: "message", agentIndex: 1, text: "hurry up" })
    expect(msg.ok).toBe(true)
    expect(msg.message).toMatch(/#1 .*sent/)
    // The RPC cannot tell the TUI from another server-API client: the record says "rpc".
    expect(runner.steers[0]!.message).toMatchObject({ from: "user", via: "rpc", text: "hurry up" })
    const stopA = await p.rpcCall("control", { runId, action: "stop_agent", agentIndex: 0 })
    expect(stopA).toMatchObject({ ok: true })
    const bad = await p.rpcCall("control", { runId, action: "message", text: "no target" })
    expect(bad.ok).toBe(false)
    runner.release()
    const n = await p.notification(0)
    expect(p.resultOf(n)).toEqual([null, "got: hurry up"])
    for (const v of [paused, msg, stopA, bad]) expect(strictJson(v)).toBe(true)
    // A finished run cannot be controlled.
    await p.settled(runId)
    expect(await p.rpcCall("control", { runId, action: "stop" })).toMatchObject({ ok: false })
  })

  test("X12 the RPC only reaches runs of its own Location: another instance's run (live or stored) is unknown to status, list and control", async () => {
    const runner = new FakeRunner().on("slow", { hold: true })
    const p = await h.setup({ runner })
    // A second plugin instance: another project (Location) in the same process, same run store.
    const q = await h.setup({ runner, fake: { directory: join(h.base, "other-project") } })
    const theirs = await q.call({ script: script(`return await agent("slow theirs")`) })
    const mine = await p.call({ script: script(`return await agent("slow mine")`) })
    await runner.waitForHeld(2)
    const runId = theirs.runId!
    expect(await q.rpcCall("status", { runId })).toMatchObject({ ok: true })
    expect(await p.rpcCall("status", { runId })).toMatchObject({ ok: false, message: `unknown run: ${runId}` })
    for (const action of ["stop", "pause", "stop_agent"]) {
      expect(await p.rpcCall("control", { runId, action, agentIndex: 0 })).toMatchObject({ ok: false })
    }
    expect(await p.rpcCall("control", { runId, action: "message", agentIndex: 0, text: "hi" })).toMatchObject({ ok: false })
    expect(runner.steers).toHaveLength(0)
    expect((await q.rpcCall("status", { runId })).run.status).toBe("running")
    const listed = (r: any) => r.runs.map((x: any) => x.runId)
    expect(listed(await p.rpcCall("list", { sessionID: SESSION }))).toEqual([mine.runId])
    expect(listed(await p.rpcCall("list", { all: true }))).toEqual([mine.runId])
    runner.release()
    await p.notification(0)
    await q.notification(0)
    await p.settled(runId)
    // Stored (run.json) runs record their Location: after the instance forgets them, only it lists them.
    const fresh = await h.setup({ runner })
    expect(await fresh.rpcCall("status", { runId })).toMatchObject({ ok: false })
    expect(listed(await fresh.rpcCall("list", { sessionID: SESSION }))).toEqual([mine.runId])
    expect((await fresh.rpcCall("status", { runId: mine.runId! })).run.status).toBe("completed")
    expect((await h.store.readSummary(runId))?.directory).toBe(join(h.base, "other-project"))
  })

  test("X17 OPENCODE_WORKFLOW_RPC_CONTROL=0 or the rpcControl:false option makes the RPC read-only: control is refused, list and status work", async () => {
    for (const setup of [{ env: { OPENCODE_WORKFLOW_RPC_CONTROL: "0" } }, { options: { rpcControl: false } }]) {
      const runner = new FakeRunner().on("slow", { hold: true })
      const p = await h.setup({ runner, ...setup })
      const out = await p.call({ script: script(`return await agent("slow one")`) })
      await runner.waitForHeld(1)
      const res = await p.rpcCall("control", { runId: out.runId, action: "stop" })
      expect(res).toMatchObject({ ok: false })
      expect(res.message).toMatch(/read-only/)
      expect((await p.rpcCall("status", { runId: out.runId })).run.status).toBe("running")
      expect((await p.rpcCall("list", { sessionID: SESSION })).runs.map((r: any) => r.runId)).toContain(out.runId)
      // The session's own surfaces still work.
      expect(await p.control({ action: "stop", runId: out.runId })).toMatch(/Stopping run/)
      await p.notification(0)
    }
  })

  test("X12 X02 the RPC and workflow_control schemas bound string sizes, so oversized input is rejected before it is parsed", async () => {
    const p = await h.setup()
    const rpc = p.rpc()!.definition.methods
    const tool = p.tools().get("workflow_control")!.input.properties
    for (const props of [rpc.control.input.properties, tool]) {
      expect(props.text.maxLength).toBe(MAX_MESSAGE_CHARS)
      expect(props.label.maxLength).toBe(200)
      expect(props.phase.maxLength).toBe(200)
      expect(props.runId.maxLength).toBeLessThanOrEqual(200)
    }
    expect(rpc.status.input.properties.runId.maxLength).toBeLessThanOrEqual(200)
    expect(rpc.list.input.properties.sessionID.maxLength).toBeLessThanOrEqual(200)
  })

  test("X12 when a later setup step fails, the RPC registration, the event subscription and earlier registrations are disposed", async () => {
    const disposed: string[] = []
    let aborted: AbortSignal | undefined
    await expect(
      h.setup({
        ctx: (c) => {
          const register = c.rpc.register
          c.rpc.register = async (...args: any[]) => {
            const reg = await register(...args)
            return { ...reg, dispose: async () => (disposed.push("rpc"), reg.dispose()) }
          }
          const subscribe = c.event.subscribe
          c.event.subscribe = (o: { signal?: AbortSignal }) => ((aborted = o?.signal), subscribe(o))
          c.tool.transform = async () => ({ dispose: async () => void disposed.push("tools") })
          c.command.transform = async () => {
            throw new Error("command registry unavailable")
          }
        },
      }),
    ).rejects.toThrow(/command registry unavailable/)
    expect(disposed.sort()).toEqual(["rpc", "tools"])
    expect(aborted?.aborted).toBe(true)
  })

  test("X12 P57 no RPC when the plugin is disabled; without ctx.rpc the plugin still works; cleanup disposes the registration", async () => {
    const off = await h.setup({ env: { OPENCODE_DISABLE_WORKFLOWS: "1" } })
    expect(off.rpcRegs).toHaveLength(0)
    const noRpc = await h.setup({
      ctx: (ctx) => {
        delete ctx.rpc
        delete ctx.event
      },
    })
    const out = await noRpc.call({ script: script(`return await agent("x")`) })
    expect(noRpc.resultOf(await noRpc.notification(0))).toBe("done: x")
    expect(out.error).toBeUndefined()
    const on = await h.setup()
    expect(on.rpcRegs).toHaveLength(1)
    await on.cleanup!()
    expect(on.rpcRegs[0]!.disposed).toBe(true)
  })
})

describe("X13 events", () => {
  test("X13 delta events are coalesced (≤4 Hz), have increasing seq and carry directory and parentSessionID", async () => {
    const runner = new FakeRunner().on(/^q/, { delayMs: 15 })
    const p = await h.setup({ runner })
    const out = await p.call({ script: script(`const r = []; for (let i = 0; i < 40; i++) r.push(await agent("q" + i)); return r.length`) })
    await p.notification(0)
    await sleep(300)
    const deltas = p.rpcEvents.filter((e) => e.name === "delta")
    expect(deltas.length).toBeGreaterThan(1)
    const seqs = deltas.map((d) => d.data.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(new Set(seqs).size).toBe(seqs.length)
    // 40 agents × several engine events each would be >100 events uncoalesced. Coalesced deltas are
    // ≥250 ms apart; only the final flush when the run ends may come sooner.
    for (let i = 1; i < deltas.length - 1; i++) expect(deltas[i]!.at - deltas[i - 1]!.at).toBeGreaterThanOrEqual(200)
    for (const d of deltas) expect(deltas.filter((x) => x.at >= d.at && x.at < d.at + 1000).length).toBeLessThanOrEqual(5)
    const run = deltas.flatMap((d) => d.data.runs).find((r: any) => r.runId === out.runId)
    expect(run).toMatchObject({ directory: h.projectDir, parentSessionID: SESSION })
    for (const d of deltas) expect(strictJson(d.data)).toBe(true)
  })

  test("X13 X15 list and every delta carry the plugin instance's epoch; a new instance has a new one and starts over at seq 1", async () => {
    const runner = new FakeRunner().on("slow", { hold: true })
    const p = await h.setup({ runner })
    const out = await p.call({ script: script(`return await agent("slow one")`) })
    await runner.waitForHeld(1)
    await waitFor(() => p.rpcEvents.some((e) => e.name === "delta"), "a delta")
    const list = await p.rpcCall("list", { sessionID: SESSION })
    expect(typeof list.epoch).toBe("string")
    for (const d of p.rpcEvents.filter((e) => e.name === "delta")) expect(d.data.epoch).toBe(list.epoch)
    runner.release()
    await p.notification(0)
    await p.settled(out.runId!)
    const q = await h.setup({ runner })
    await q.call({ script: script(`return await agent("x")`) })
    await q.notification(0)
    await waitFor(() => q.rpcEvents.some((e) => e.name === "delta"), "a delta from the new instance")
    const first = q.rpcEvents.find((e) => e.name === "delta")!.data
    expect(first.seq).toBe(1)
    expect(first.epoch).not.toBe(list.epoch)
    expect((await q.rpcCall("list", { all: true })).epoch).toBe(first.epoch)
  })

  test("X13 finished is emitted right away when a run ends, with its totals", async () => {
    const p = await h.setup()
    const out = await p.call({ script: script(`await agent("a"); return await agent("b")`) })
    await p.notification(0)
    await waitFor(() => p.rpcEvents.some((e) => e.name === "finished"), "finished event")
    const fin = p.rpcEvents.find((e) => e.name === "finished")!.data
    expect(fin).toMatchObject({ runId: out.runId, status: "completed", agents: 2, parentSessionID: SESSION, directory: h.projectDir, workflowName: "t-wf" })
    expect(fin.tokens).toBeGreaterThan(0)
    expect(strictJson(fin)).toBe(true)
  })
})

describe("X18 X19 the model each agent runs on", () => {
  test("X18 real runner: the child's actual model lands in agents/<i>.json and the journal; a mismatch with the request is a warning", async () => {
    const p = await h.setup({
      real: true,
      fake: {
        respond: () => ({ text: "ok" }),
        childModel: (m: any) => (m?.providerID === "anthropic" ? { providerID: "opencode", id: "free-fallback" } : m ? { variant: "default", ...m } : undefined),
      },
    })
    const out = await p.call({
      script: script(`return [await agent("a", { effort: "high" }), await agent("b", { model: "anthropic/claude-haiku-4-5" })]`),
    })
    await p.notification(0)
    await p.settled(out.runId!)
    const a = await h.store.readAgentRecord(out.runId!, 0)
    const b = await h.store.readAgentRecord(out.runId!, 1)
    expect(a?.model).toBe("openai/gpt-5.4-mini#high")
    expect(a?.warnings ?? []).toEqual([])
    expect(b?.model).toBe("opencode/free-fallback")
    expect((b?.warnings ?? []).join("\n")).toMatch(/requested anthropic\/claude-haiku-4-5.*opencode\/free-fallback/)
    const journal = await h.store.readJournal(out.runId!)
    expect(journal.map((e) => e.model)).toEqual(expect.arrayContaining(["openai/gpt-5.4-mini#high", "opencode/free-fallback"]))
  })

  test("X18 P41 a cached agent keeps its model (from the journal, or an older run's agent record); agent keys are unchanged", async () => {
    const runner = new FakeRunner().on("A", { model: "openai/gpt-5.4-mini#high" }).on("B", { model: "openai/gpt-5.4" })
    const p = await h.setup({ runner })
    const src = script(`return [await agent("A", { effort: "high" }), await agent("B")]`)
    const first = await p.call({ script: src })
    await p.notification(0)
    await p.settled(first.runId!)
    const rec0 = await h.store.readAgentRecord(first.runId!, 0)
    const { agentKey } = await import("../../src/journal.ts")
    expect(rec0?.key).toBe(agentKey("A", { effort: "high" }))
    const second = await p.call({ script: src, resumeFromRunId: first.runId })
    await p.notification(1)
    await p.settled(second.runId!)
    expect(runner.calls).toHaveLength(2)
    const cached = await h.store.readAgentRecord(second.runId!, 0)
    expect(cached).toMatchObject({ status: "cached", model: "openai/gpt-5.4-mini#high", key: rec0!.key })
    expect((await h.store.readAgentRecord(second.runId!, 1))?.model).toBe("openai/gpt-5.4")
    // An older journal without `model`: the model comes from that run's agent record.
    const loc = await h.store.findRun(second.runId!)
    const { readFileSync, writeFileSync } = await import("node:fs")
    const jpath = join(loc!.dir, "journal.jsonl")
    const stripped = readFileSync(jpath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const e = JSON.parse(l)
        delete e.model
        return JSON.stringify(e)
      })
      .join("\n")
    writeFileSync(jpath, stripped + "\n")
    const third = await p.call({ script: src, resumeFromRunId: second.runId })
    await p.notification(2)
    await p.settled(third.runId!)
    expect(runner.calls).toHaveLength(2)
    expect((await h.store.readAgentRecord(third.runId!, 0))?.model).toBe("openai/gpt-5.4-mini#high")
    expect((await h.store.readAgentRecord(third.runId!, 1))?.model).toBe("openai/gpt-5.4")
  })

  test("X19 /workflows <runId> and workflow_control status show each agent's model; a phase without a label shows the model its agents share", async () => {
    const runner = new FakeRunner()
      .on("s", { model: "openai/gpt-5.4-mini#high" })
      .on("mixed", { model: "anthropic/claude-haiku-4-5" })
      .on("slow", { hold: true, model: "openai/gpt-5.4-mini#high" })
    const p = await h.setup({ runner })
    const out = await p.call({
      script: script(
        `phase("Scan"); await agent("s1"); await agent("s2"); phase("Mix"); await agent("s3"); await agent("mixed"); phase("Scan2"); return await agent("slow")`,
        LABELED.replace(`{ title: "Judge", model: "strong" }`, `{ title: "Mix" }`),
      ),
    })
    await runner.waitForHeld(1)
    await p.command("workflows", out.runId!)
    let text = shown(p)
    expect(text).toMatch(/#0 s1\s+completed.*\n\s+model: openai\/gpt-5\.4-mini#high/)
    expect(text).toMatch(/#3 mixed\s+completed.*\n\s+model: anthropic\/claude-haiku-4-5/)
    // Declared label wins; no label + one shared model → that model; mixed → none.
    expect(text).toMatch(/Scan \(openai\/gpt-5\.4\)\s+2\/2/)
    expect(text).toMatch(/Scan2 \(openai\/gpt-5\.4-mini#high\)\s+0\/1/)
    expect(text).toMatch(/Mix\s+2\/2/)
    const forModel = await p.control({ action: "status", runId: out.runId })
    expect(forModel).toMatch(/#4 slow\s+running.*\n\s+model: openai\/gpt-5\.4-mini#high/)
    runner.release()
    await p.notification(0)
    await p.settled(out.runId!)
    const stored = await h.store.readSummary(out.runId!)
    expect(stored?.phases.find((x) => x.title === "Scan2")?.agentModel).toBe("openai/gpt-5.4-mini#high")
    expect(stored?.phases.find((x) => x.title === "Mix")?.agentModel).toBeUndefined()
    await p.command("workflows", out.runId!)
    text = shown(p)
    expect(text).toMatch(/#4 slow\s+completed.*\n\s+model: openai\/gpt-5\.4-mini#high/)
  })

  test("X19 RPC list, status and delta carry each agent's model; the live step model wins when it differs; phases fall back to the shared model", async () => {
    const runner = new FakeRunner().on("slow", { hold: true, model: "openai/gpt-5.4-mini#high" })
    const p = await h.setup({ runner })
    const out = await p.call({ script: script(`phase("Work"); return await Promise.all([agent("slow a"), agent("slow b")])`) })
    await runner.waitForHeld(2)
    await sleep(300)
    const list = await p.rpcCall("list", { sessionID: SESSION })
    expect(list.agents.map((a: any) => a.model)).toEqual(["openai/gpt-5.4-mini#high", "openai/gpt-5.4-mini#high"])
    expect(list.runs[0].phases[0]).toMatchObject({ title: "Work", model: "openai/gpt-5.4-mini#high" })
    const deltaAgents = p.rpcEvents.filter((e) => e.name === "delta").flatMap((e) => e.data.agents)
    expect(deltaAgents.some((a: any) => a.model === "openai/gpt-5.4-mini#high")).toBe(true)
    // Same model as recorded (no variant in the event): the recorded ref with its variant stays.
    await waitFor(() => p.eventSubscribers() > 0, "event subscription")
    p.pushEvent(childEvent("ses_fake_0", "session.step.started", { model: { id: "gpt-5.4-mini", providerID: "openai" } }))
    // A different model on the live step (fallback): the live one is shown.
    p.pushEvent(childEvent("ses_fake_1", "session.step.started", { model: { id: "free", providerID: "opencode" } }))
    await sleep(20)
    const st = await p.rpcCall("status", { runId: out.runId })
    expect(st.agents.map((a: any) => a.model)).toEqual(["openai/gpt-5.4-mini#high", "opencode/free"])
    runner.release()
    await p.notification(0)
  })
})
