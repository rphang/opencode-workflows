// Unit: the ctx.permission.assert adapter behind P76 (src/opencode/permission-assert.ts).

import { describe, expect, test } from "bun:test"
import {
  ASSERT_ID_METADATA_KEY,
  createPermissionAsserter,
  createUnattendedAskGuard,
  isPermissionCancelled,
  isPermissionDecline,
  UNATTENDED_ASK_MESSAGE,
  UNATTENDED_METADATA_KEY,
} from "../../src/opencode/permission-assert.ts"

const request = {
  sessionID: "ses_1",
  agent: "build",
  action: "external_directory",
  resources: ["/x/*"],
  save: ["/x/*"],
  source: { type: "tool" as const, messageID: "msg_1", id: "call_1" },
}

describe("P76 permission.assert adapter", () => {
  test("P76 no adapter without assert, or without the evaluate hook an unattended check relies on", () => {
    expect(createPermissionAsserter({} as any)).toBeUndefined()
    expect(createPermissionAsserter({ permission: { hook: async () => ({}) } } as any)).toBeUndefined()
    expect(createPermissionAsserter({ permission: { assert: async () => {} } } as any)).toBeUndefined()
  })

  test("P76 an interactive check passes the tool call as source; a background one drops it and adds the marker", async () => {
    const seen: any[] = []
    const assert = createPermissionAsserter({ permission: { assert: async (i: any) => void seen.push(i), hook: async () => ({}), list: async () => [] } } as any)!
    await assert(request, { interactive: true })
    await assert({ ...request, agent: undefined, save: undefined }, { interactive: false })
    expect(seen[0]).toEqual({ sessionID: "ses_1", agent: "build", action: "external_directory", resources: ["/x/*"], save: ["/x/*"], source: request.source })
    // No undefined-valued keys: opencode's AssertInput decodes optional keys strictly.
    expect(seen[1]).toEqual({
      sessionID: "ses_1",
      action: "external_directory",
      resources: ["/x/*"],
      metadata: { [UNATTENDED_METADATA_KEY]: true, [ASSERT_ID_METADATA_KEY]: expect.any(String) },
    })
  })

  test("P76 the evaluate guard turns only a marked ask into a deny", () => {
    const guard = createUnattendedAskGuard()
    const marked = { effect: "ask", metadata: { [UNATTENDED_METADATA_KEY]: true } } as any
    guard(marked)
    expect(marked).toMatchObject({ effect: "deny", message: UNATTENDED_ASK_MESSAGE })
    for (const e of [{ effect: "ask" }, { effect: "allow", metadata: { [UNATTENDED_METADATA_KEY]: true } }] as any[]) {
      const before = { ...e }
      guard(e)
      expect(e).toEqual(before)
    }
  })

  test("P76 a plain rejection is recognised by its tag; a Tool.Error is not one", () => {
    expect(isPermissionDecline(Object.assign(new Error("x"), { _tag: "Permission.DeclinedError" }))).toBe(true)
    expect(isPermissionDecline(Object.assign(new Error("x"), { _tag: "Tool.Error" }))).toBe(false)
    expect(isPermissionDecline(undefined)).toBe(false)
  })

  // A fake permission API: assert waits until reply(); list answers as `{data}` (the HTTP endpoint shape).
  const fakePermission = (opts: { createAfterMs?: number } = {}) => {
    const pending = new Map<string, { request: any; settle: (ok: boolean) => void }>()
    const replies: any[] = []
    let n = 0
    const permission = {
      hook: async () => ({}),
      list: async () => ({ data: [...pending.values()].map((p) => p.request) }),
      reply: async (i: any) => {
        replies.push(i)
        pending.get(i.requestID)?.settle(i.decision !== "reject")
      },
      assert: async (input: any) => {
        if (opts.createAfterMs) await new Promise((r) => setTimeout(r, opts.createAfterMs))
        const id = `per_${++n}`
        const ok = await new Promise<boolean>((settle) => pending.set(id, { request: { ...input, id }, settle }))
        pending.delete(id)
        if (!ok) throw Object.assign(new Error("rejected"), { _tag: "Permission.DeclinedError" })
      },
    }
    return { permission, pending, replies }
  }

  test("P76 an aborted signal rejects at once and withdraws the prompt, also one that appears after the abort", async () => {
    const f = fakePermission({ createAfterMs: 30 })
    const assert = createPermissionAsserter({ permission: f.permission } as any, { withdrawIntervalMs: 5 })!
    const ac = new AbortController()
    const p = assert(request, { interactive: true, signal: ac.signal })
    ac.abort()
    const err: any = await p.catch((e) => e)
    expect(isPermissionCancelled(err)).toBe(true)
    await new Promise((r) => setTimeout(r, 80))
    expect(f.pending.size).toBe(0)
    expect(f.replies).toEqual([{ sessionID: "ses_1", requestID: "per_1", decision: "reject" }])
    expect(isPermissionCancelled(await assert(request, { interactive: true, signal: ac.signal }).catch((e) => e))).toBe(true)
  })

  test("P76 an unattended check that is still waiting after its timeout is refused and its prompt withdrawn", async () => {
    const f = fakePermission()
    const assert = createPermissionAsserter({ permission: f.permission } as any, { unattendedTimeoutMs: 20, withdrawIntervalMs: 5 })!
    const err: any = await assert(request, { interactive: false }).catch((e) => e)
    expect(err.message).toBe(UNATTENDED_ASK_MESSAGE)
    await new Promise((r) => setTimeout(r, 30))
    expect(f.pending.size).toBe(0)
    expect(f.replies.map((r) => r.decision)).toEqual(["reject"])
  })
})
