// AgentMailbox (src/mailbox.ts): the per-agent steer window behind steering (X01–X04).
import { describe, expect, test } from "bun:test"
import {
  AgentMailbox,
  MAX_HELD_MESSAGES,
  MAX_MESSAGE_CHARS,
  MAX_MESSAGES_PER_AGENT,
  RECORD_TEXT_CHARS,
  type AgentMessage,
} from "../../src/mailbox.ts"

let n = 0
function msg(text = "hello", extra: Partial<AgentMessage> = {}): AgentMessage {
  n++
  return { id: `wm_0_${n}`, from: "user", via: "command", text, urgent: false, at: 1000 + n, ...extra }
}

function sender() {
  const sent: AgentMessage[] = []
  let k = 0
  const send = async (m: AgentMessage) => {
    sent.push(m)
    return { id: `del_${++k}` }
  }
  return { sent, send }
}

describe("AgentMailbox states", () => {
  test("pending (queued agent): messages are held and returned by attach()", async () => {
    const mb = new AgentMailbox()
    expect(mb.state).toBe("pending")
    const r = await mb.post(msg("first"))
    expect(r).toEqual({ ok: true, state: "held" })
    expect(mb.records().map((x) => x.status)).toEqual(["held"])
    const { send } = sender()
    const held = mb.attach(send)
    expect(held.map((m) => m.text)).toEqual(["first"])
    expect(mb.state).toBe("between")
  })

  test("pending: at most MAX_HELD_MESSAGES held messages", async () => {
    const mb = new AgentMailbox()
    for (let i = 0; i < MAX_HELD_MESSAGES; i++) expect((await mb.post(msg())).ok).toBe(true)
    const r = await mb.post(msg())
    expect(r).toMatchObject({ ok: false, reason: "limit" })
  })

  test("open: the message is sent through the runner's sender and reported sent", async () => {
    const mb = new AgentMailbox()
    const { sent, send } = sender()
    mb.attach(send)
    mb.open()
    const r = await mb.post(msg("go left"))
    expect(r).toEqual({ ok: true, state: "sent", deliveryId: "del_1" })
    expect(sent.map((m) => m.text)).toEqual(["go left"])
    expect(mb.records()[0]).toMatchObject({ status: "sent", text: "go left", from: "user", via: "command" })
  })

  test("between (attached, first prompt not sent yet): the message waits and is sent at open()", async () => {
    const mb = new AgentMailbox()
    const { sent, send } = sender()
    mb.attach(send)
    const p = mb.post(msg("early"))
    await Promise.resolve()
    expect(sent).toHaveLength(0)
    mb.open()
    expect(await p).toMatchObject({ ok: true, state: "sent" })
    expect(sent.map((m) => m.text)).toEqual(["early"])
  })

  test("finishing (after close) refuses with `finishing`; closed refuses with `finished`", async () => {
    const mb = new AgentMailbox()
    const { send } = sender()
    mb.attach(send)
    mb.open()
    await mb.close()
    expect(mb.state).toBe("finishing")
    expect(await mb.post(msg())).toMatchObject({ ok: false, reason: "finishing" })
    mb.seal()
    expect(mb.state).toBe("closed")
    expect(await mb.post(msg())).toMatchObject({ ok: false, reason: "finished" })
  })

  test("seal() refuses messages still waiting for open()", async () => {
    const mb = new AgentMailbox()
    mb.attach(sender().send)
    const p = mb.post(msg())
    mb.seal()
    expect(await p).toMatchObject({ ok: false, reason: "finished" })
  })

  test("a later turn re-opens the window (schema retry)", async () => {
    const mb = new AgentMailbox()
    const { sent, send } = sender()
    mb.attach(send)
    mb.open()
    await mb.close()
    mb.open()
    expect((await mb.post(msg("retry-time"))).ok).toBe(true)
    expect(sent).toHaveLength(1)
  })
})

describe("AgentMailbox close / report", () => {
  test("close() awaits an in-flight send and returns the ids sent in that window", async () => {
    const mb = new AgentMailbox()
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    mb.attach(async () => {
      await gate
      return { id: "del_slow" }
    })
    mb.open()
    const posted = mb.post(msg("slow"))
    let closed: unknown
    const closing = mb.close().then((ids) => (closed = ids))
    await Promise.resolve()
    expect(closed).toBeUndefined()
    release()
    await closing
    const m = await posted
    expect(m).toMatchObject({ ok: true, state: "sent", deliveryId: "del_slow" })
    expect(closed).toEqual([{ id: mb.records()[0]!.id, deliveryId: "del_slow" }])
    // the next window starts empty
    mb.open()
    expect(await mb.close()).toEqual([])
  })

  test("report() moves sent/held messages to delivered or undelivered and fires onChange", async () => {
    let changes = 0
    const mb = new AgentMailbox({ onChange: () => changes++ })
    await mb.post(msg("held one"))
    const held = mb.attach(sender().send)
    mb.report(held[0]!.id, "delivered")
    mb.open()
    await mb.post(msg("sent one"))
    const [s] = await mb.close()
    mb.report(s!.id, "undelivered")
    expect(mb.records().map((r) => r.status)).toEqual(["delivered", "undelivered"])
    expect(changes).toBeGreaterThanOrEqual(4)
  })

  test("a sender that throws gives send_failed and records the message as refused", async () => {
    const mb = new AgentMailbox()
    mb.attach(async () => {
      throw new Error("Session not found")
    })
    mb.open()
    const r = await mb.post(msg("x"))
    expect(r).toMatchObject({ ok: false, reason: "send_failed", detail: "Session not found" })
    expect(mb.records()[0]).toMatchObject({ status: "refused", error: "Session not found" })
    expect(await mb.close()).toEqual([])
  })

  test("guard (schema agent already submitted) refuses with `submitted` before sending", async () => {
    const mb = new AgentMailbox()
    const { sent, send } = sender()
    mb.attach(send, async () => "submitted")
    mb.open()
    expect(await mb.post(msg())).toMatchObject({ ok: false, reason: "submitted" })
    expect(sent).toHaveLength(0)
    expect(mb.records()).toEqual([])
  })
})

describe("AgentMailbox limits", () => {
  test(`at most ${MAX_MESSAGES_PER_AGENT} accepted messages per agent`, async () => {
    const mb = new AgentMailbox()
    mb.attach(sender().send)
    mb.open()
    for (let i = 0; i < MAX_MESSAGES_PER_AGENT; i++) expect((await mb.post(msg())).ok).toBe(true)
    expect(await mb.post(msg())).toMatchObject({ ok: false, reason: "limit" })
  })

  test(`a text over ${MAX_MESSAGE_CHARS} characters is refused (limit); an empty one too`, async () => {
    const mb = new AgentMailbox()
    mb.attach(sender().send)
    mb.open()
    expect(await mb.post(msg("x".repeat(MAX_MESSAGE_CHARS + 1)))).toMatchObject({ ok: false, reason: "limit" })
    expect(await mb.post(msg("   "))).toMatchObject({ ok: false, reason: "limit" })
    expect((await mb.post(msg("x".repeat(MAX_MESSAGE_CHARS)))).ok).toBe(true)
  })

  test(`records clip the text to ${RECORD_TEXT_CHARS} characters; the sender gets it whole`, async () => {
    const mb = new AgentMailbox()
    const { sent, send } = sender()
    mb.attach(send)
    mb.open()
    await mb.post(msg("y".repeat(1200)))
    expect(sent[0]!.text).toHaveLength(1200)
    expect(mb.records()[0]!.text.length).toBeLessThanOrEqual(RECORD_TEXT_CHARS)
  })

  test("accepted() counts held, sent, delivered and undelivered messages", async () => {
    const mb = new AgentMailbox()
    expect(mb.accepted()).toBe(0)
    await mb.post(msg())
    expect(mb.accepted()).toBe(1)
  })
})
