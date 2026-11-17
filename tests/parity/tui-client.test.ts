// Extensions beyond Claude Code (docs/PARITY.md "Extensions", X25–X27): the TUI's agent dialog, its
// sidebar summary and the cold-start resync, tested through the pure client logic (src/client/,
// src/tui/store.ts) without a renderer.

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { listErrorKind, retryDelay } from "../../src/client/sync.ts"
import { driver, run, tick } from "../helpers/fake-tree-rpc.ts"

const root = join(import.meta.dir, "..", "..")
const UNAVAILABLE = { type: "rpc.unavailable", message: "RPC is unavailable: dynamic-workflows" }

describe("X27 cold-start resync", () => {
  test("X27 retryDelay: 250, 500, 1000, 2000, 4000 ms, then null (give up)", () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(retryDelay)).toEqual([250, 500, 1000, 2000, 4000, null, null])
    expect(retryDelay(-1)).toBe(250)
  })

  test("X27 listErrorKind: rpc.unavailable (as thrown by the client, an RpcError or its message) vs any other error", () => {
    expect(listErrorKind(UNAVAILABLE)).toBe("unavailable")
    expect(listErrorKind({ _tag: "RpcError", type: "rpc.unavailable", message: "x" })).toBe("unavailable")
    expect(listErrorKind(new Error("RPC is unavailable: dynamic-workflows"))).toBe("unavailable")
    expect(listErrorKind({ type: "rpc.invalid_input", message: "Expected object" })).toBe("error")
    expect(listErrorKind(new TypeError("fetch failed"))).toBe("error")
    expect(listErrorKind(undefined)).toBe("error")
  })

  test("X27 a first list that fails with rpc.unavailable (plugins still loading) is retried quietly until it succeeds", async () => {
    const d = driver()
    d.sync.start()
    d.calls[0]!.reject(UNAVAILABLE)
    await tick()
    expect(d.sync.status).toBe("loading…")
    expect(d.sync.state).toBe("loading")
    expect(d.sync.available).toBe(false)
    expect(d.timers.fire()).toBe(250)
    expect(d.calls).toHaveLength(2)
    d.calls[1]!.reject(UNAVAILABLE)
    await tick()
    expect(d.sync.status).toBe("loading…")
    expect(d.timers.fire()).toBe(500)
    d.calls[2]!.resolve({ ok: true, seq: 1, epoch: "e", runs: [run()], agents: [] })
    await tick()
    expect(d.sync.state).toBe("ready")
    expect(d.sync.status).toBe("")
    expect(d.sync.available).toBe(true)
    expect(d.sync.tree.runs.has("wf_ab12")).toBe(true)
    expect(d.timers.pending()).toHaveLength(0)
    // Attempts were reset by the success: a later failure starts over at 250 ms.
    void d.sync.resync()
    d.calls[3]!.reject(UNAVAILABLE)
    await tick()
    expect(d.timers.fire()).toBe(250)
  })

  test("X27 after 5 retries it gives up and says so; a target change or a refresh (plugin.updated) starts over", async () => {
    const d = driver()
    d.sync.start()
    const delays: number[] = []
    for (let i = 0; i < 6; i++) {
      d.calls[i]!.reject(UNAVAILABLE)
      await tick()
      if (i < 5) delays.push(d.timers.fire())
    }
    expect(delays).toEqual([250, 500, 1000, 2000, 4000])
    expect(d.calls).toHaveLength(6)
    expect(d.timers.pending()).toHaveLength(0)
    expect(d.sync.state).toBe("unavailable")
    expect(d.sync.status).toBe("workflows RPC unavailable (RPC is unavailable: dynamic-workflows); use /workflows")
    // plugin.updated → refresh(): attempts reset.
    void d.sync.refresh()
    expect(d.calls).toHaveLength(7)
    d.calls[6]!.reject(UNAVAILABLE)
    await tick()
    expect(d.sync.status).toBe("loading…")
    expect(d.timers.fire()).toBe(250)
    d.calls[7]!.reject(UNAVAILABLE)
    await tick()
    // A target change cancels the pending retry and starts over against the new target.
    d.target.sessionID = "ses_two"
    expect(d.sync.checkTarget()).toBe(true)
    expect(d.timers.pending()).toHaveLength(0)
    expect(d.calls[8]!.input).toEqual({ sessionID: "ses_two" })
    d.calls[8]!.reject(UNAVAILABLE)
    await tick()
    expect(d.timers.fire()).toBe(250)
  })

  test("X27 another error is shown while retrying, and once the retries run out", async () => {
    const d = driver()
    d.sync.start()
    d.calls[0]!.reject(new TypeError("fetch failed"))
    await tick()
    expect(d.sync.state).toBe("loading")
    expect(d.sync.status).toBe("workflows: fetch failed (retrying)")
    for (let i = 1; i < 6; i++) {
      d.timers.fire()
      d.calls[i]!.reject(new TypeError("fetch failed"))
      await tick()
    }
    expect(d.sync.state).toBe("error")
    expect(d.sync.status).toBe("workflows list failed (fetch failed); use /workflows")
  })

  test("X27 a delta from the target Location while the list is not ready resyncs right away (the plugin has loaded)", async () => {
    const d = driver()
    d.sync.start()
    d.calls[0]!.reject(UNAVAILABLE)
    await tick()
    expect(d.timers.pending()).toHaveLength(1)
    d.emit("delta", { seq: 3, epoch: "e", runs: [run()], agents: [] })
    expect(d.calls).toHaveLength(2)
    expect(d.timers.pending()).toHaveLength(0)
    expect(d.sync.available).toBe(true)
    d.calls[1]!.resolve({ ok: true, seq: 3, epoch: "e", runs: [run()], agents: [] })
    await tick()
    expect(d.sync.state).toBe("ready")
    // Once ready, deltas in sequence do not list again.
    d.emit("delta", { seq: 4, epoch: "e", runs: [run({ tokens: 9 })], agents: [] })
    expect(d.calls).toHaveLength(2)
  })

  test("X27 the TUI refreshes (attempts reset) when the host reports plugin.updated", () => {
    const src = readFileSync(join(root, "src", "tui", "index.tsx"), "utf8")
    expect(src).toMatch(/\.on(\?\.)?\("plugin\.updated", \(\) => void sync\.refresh\(\)\)/)
  })
})
