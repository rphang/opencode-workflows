// ActivityTap (src/plugin/activity.ts): the display-only live overlay for running agents (X11), built
// from opencode's global event stream. Event shapes are the ones recorded live on 2.0.15 (spike A,
// docs/design/steering-and-live-tree.md §B.2), with paths replaced by placeholders.

import { describe, expect, test } from "bun:test"
import { ActivityTap, reduceActivity, summarizeToolInput, type AgentActivity } from "../../src/plugin/activity.ts"
import { sleep } from "../helpers/fake-runner.ts"

const S = "ses_child000000000000000000001"
const loc = { directory: "<project>" }

const ev = {
  stepStarted: (at = 1000) => ({
    type: "session.step.started",
    created: at,
    location: loc,
    data: { sessionID: S, assistantMessageID: "msg_1", agent: "build", model: { id: "gpt-5.4-mini", providerID: "openai", variant: "default" } },
  }),
  toolInputStarted: (name: string, id = "call_1", at = 1100) => ({
    type: "session.tool.input.started",
    created: at,
    location: loc,
    data: { sessionID: S, assistantMessageID: "msg_1", id, name },
  }),
  toolCalled: (input: unknown, id = "call_1", at = 1200) => ({
    type: "session.tool.called",
    created: at,
    location: loc,
    data: { sessionID: S, assistantMessageID: "msg_1", id, input, executed: false },
  }),
  textStarted: (at = 1300) => ({ type: "session.text.started", created: at, data: { sessionID: S, assistantMessageID: "msg_2", ordinal: 0 } }),
  textDelta: (delta: string, at = 1310) => ({ type: "session.text.delta", created: at, data: { sessionID: S, assistantMessageID: "msg_2", ordinal: 0, delta } }),
  textEnded: (text: string, at = 1400) => ({ type: "session.text.ended", created: at, data: { sessionID: S, assistantMessageID: "msg_2", ordinal: 0, text } }),
  reasoningStarted: (at = 1250) => ({ type: "session.reasoning.started", created: at, data: { sessionID: S, assistantMessageID: "msg_2", ordinal: 0 } }),
  usage: (input: number, output: number, cost: number, at = 1500) => ({
    type: "session.usage.updated",
    created: at,
    data: { sessionID: S, cost, tokens: { input, output, reasoning: 5, cache: { read: 10, write: 0 } } },
  }),
  delivered: (at = 1600) => ({ type: "session.inbox.delivered", created: at, location: loc, data: { sessionID: S, inboxID: "msg_x" } }),
  executionSucceeded: (at = 1700) => ({ type: "session.execution.succeeded", created: at, data: { sessionID: S } }),
}

function fold(events: any[]): AgentActivity | undefined {
  let a: AgentActivity | undefined
  for (const e of events) a = reduceActivity(a, e) ?? a
  return a
}

describe("X11 terminal-safe activity", () => {
  test("X11 control characters and bidi overrides never reach the activity text (tool names, inputs, streamed text)", () => {
    const esc = String.fromCharCode(27)
    const tool = fold([ev.toolInputStarted(`bash${esc}[2J`), ev.toolCalled({ command: `rm -rf x${esc}]0;title${String.fromCharCode(7)}` })])
    expect(tool?.text).toBe("bash[2J rm -rf x]0;title")
    const text = fold([ev.textStarted(), ev.textDelta(`hello${esc}[31m red‮ evil`)])
    expect(text?.text).toBe("hello[31m red evil")
  })
})

describe("X11 reduceActivity", () => {
  test("X11 step.started records the child's model and a waiting activity", () => {
    const a = fold([ev.stepStarted(1000)])
    expect(a).toMatchObject({ model: "openai/gpt-5.4-mini", kind: "waiting", at: 1000 })
  })

  test("X11 a tool call shows the tool name, then its one-line input summary", () => {
    let a = fold([ev.stepStarted(), ev.toolInputStarted("webfetch")])
    expect(a).toMatchObject({ kind: "tool", text: "webfetch" })
    a = reduceActivity(a, ev.toolCalled({ url: "https://docs.example.com/api/payments", format: "markdown" }))!
    expect(a).toMatchObject({ kind: "tool", text: "webfetch https://docs.example.com/api/payments", at: 1200 })
  })

  test("X11 streamed text keeps the last 80 characters on one line; text.ended settles it", () => {
    const long = "The main risk is that the retry loop\nnever backs off. ".repeat(4)
    let a = fold([ev.stepStarted(), ev.textStarted(), ev.textDelta("The main "), ev.textDelta("risk is")])
    expect(a).toMatchObject({ kind: "text", text: "The main risk is" })
    a = reduceActivity(a, ev.textDelta(long))!
    expect(a.text.length).toBeLessThanOrEqual(80)
    expect(a.text).not.toContain("\n")
    expect(a.text.startsWith("…")).toBe(true)
    a = reduceActivity(a, ev.textEnded("FINAL-ANSWER"))!
    expect(a).toMatchObject({ kind: "text", text: "FINAL-ANSWER" })
  })

  test("X11 reasoning shows as reasoning; usage.updated carries cumulative tokens and cost", () => {
    const a = fold([ev.stepStarted(), ev.reasoningStarted(), ev.usage(1000, 200, 0.0123)])!
    expect(a.kind).toBe("reasoning")
    expect(a.tokens).toBe(1000 + 200 + 5 + 10)
    expect(a.cost).toBeCloseTo(0.0123)
  })

  test("X11 inbox.delivered counts delivered messages; unrelated events change nothing", () => {
    const base = fold([ev.stepStarted()])!
    const d = reduceActivity(base, ev.delivered())!
    expect(d.delivered).toBe(1)
    expect(reduceActivity(d, ev.executionSucceeded())).toBeUndefined()
    expect(reduceActivity(d, { type: "session.created", data: { sessionID: S } })).toBeUndefined()
  })

  test("X11 tool input summaries: path, command, url, pattern; clipped to 80 characters", () => {
    expect(summarizeToolInput("read", { filePath: "/repo/src/auth/login.ts" })).toBe("read /repo/src/auth/login.ts")
    expect(summarizeToolInput("bash", { command: "npm test\n  --watch", description: "run" })).toBe("bash npm test --watch")
    expect(summarizeToolInput("grep", { pattern: "TODO", path: "src" })).toBe("grep TODO")
    expect(summarizeToolInput("custom", { n: 1 })).toBe('custom {"n":1}')
    expect(summarizeToolInput("custom", undefined)).toBe("custom")
    const s = summarizeToolInput("webfetch", { url: `https://x.example/${"a".repeat(200)}` })
    expect(s.length).toBeLessThanOrEqual(80)
    expect(s.endsWith("…")).toBe(true)
  })
})

/** A controllable event stream: push() events, end() closes it. */
function stream() {
  const queue: any[] = []
  let wake: (() => void) | undefined
  let done = false
  return {
    push(e: any) {
      queue.push(e)
      wake?.()
    },
    end() {
      done = true
      wake?.()
    },
    async *iterate() {
      for (;;) {
        while (queue.length) yield queue.shift()
        if (done) return
        await new Promise<void>((r) => (wake = r))
        wake = undefined
      }
    },
  }
}

describe("X11 ActivityTap", () => {
  test("X11 keeps events of tracked child sessions only and reports changes per agent", async () => {
    const s = stream()
    const changes: string[] = []
    const tap = new ActivityTap({ subscribe: () => s.iterate(), onChange: (runId, index) => changes.push(`${runId}#${index}`) })
    tap.start()
    tap.track(S, "wf_1", 2)
    s.push(ev.stepStarted())
    s.push({ ...ev.stepStarted(), data: { ...ev.stepStarted().data, sessionID: "ses_unrelated" } })
    s.push(ev.toolInputStarted("bash"))
    await sleep(5)
    expect(changes).toEqual(["wf_1#2", "wf_1#2"])
    expect(tap.get("wf_1", 2)).toMatchObject({ kind: "tool", text: "bash", model: "openai/gpt-5.4-mini" })
    expect([...tap.forRun("wf_1").keys()]).toEqual([2])
    tap.untrack(S)
    s.push(ev.textStarted())
    await sleep(5)
    expect(changes).toHaveLength(2)
    expect(tap.get("wf_1", 2)).toBeUndefined()
    await tap.stop()
    s.end()
  })

  test("X11 a missing or failing subscribe leaves the tap empty and never throws", async () => {
    const none = new ActivityTap({ subscribe: undefined, onChange: () => {} })
    none.start()
    none.track(S, "wf_1", 0)
    expect(none.get("wf_1", 0)).toBeUndefined()
    await none.stop()
    const failing = new ActivityTap({
      subscribe: () => {
        throw new Error("no events")
      },
      onChange: () => {},
    })
    failing.start()
    await sleep(5)
    await failing.stop()
  })

  test("X11 stop() ends the subscription loop", async () => {
    const s = stream()
    let returned = false
    const tap = new ActivityTap({
      subscribe: () => {
        const it = s.iterate()
        return {
          [Symbol.asyncIterator]: () => ({
            next: () => it.next(),
            return: async () => {
              returned = true
              s.end()
              return { done: true as const, value: undefined }
            },
          }),
        }
      },
      onChange: () => {},
    })
    tap.start()
    await sleep(5)
    await tap.stop()
    expect(returned).toBe(true)
  })
})
