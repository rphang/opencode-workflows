// Unit: the ctx.permission.assert adapter behind P76 (src/opencode/permission-assert.ts).

import { describe, expect, test } from "bun:test"
import {
  createPermissionAsserter,
  createUnattendedAskGuard,
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
    const assert = createPermissionAsserter({ permission: { assert: async (i: any) => void seen.push(i), hook: async () => ({}) } } as any)!
    await assert(request, { interactive: true })
    await assert({ ...request, agent: undefined, save: undefined }, { interactive: false })
    expect(seen[0]).toEqual({ sessionID: "ses_1", agent: "build", action: "external_directory", resources: ["/x/*"], save: ["/x/*"], source: request.source })
    // No undefined-valued keys: opencode's AssertInput decodes optional keys strictly.
    expect(seen[1]).toEqual({ sessionID: "ses_1", action: "external_directory", resources: ["/x/*"], metadata: { [UNATTENDED_METADATA_KEY]: true } })
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
})
