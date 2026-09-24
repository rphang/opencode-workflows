// Live e2e (opencode 2.0.15): an inline script with parallel + pipeline + a schema agent.
// P02 tool output shape, P06 task notification to the parent, P40 transcript dir + journal,
// plus P20/P21/P29/P30/P32/P33 on the real runtime. Enable with OPENCODE_E2E=1 (docs/E2E.md).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { formatModelRef } from "../../src/opencode/model.ts"
import { STRUCTURED_SUBAGENT_PREAMBLE, SUBAGENT_PREAMBLE } from "../../src/opencode/runner.ts"
import {
  assistantText,
  createProject,
  e2eEnabled,
  launchPrompt,
  readTranscript,
  recordRunCost,
  runPrompt,
  startServer,
  waitForAssistantAfter,
  waitForNotification,
  workflowToolCalls,
  type E2EServer,
} from "./harness.ts"

const SCRIPT = `export const meta = { name: "e2e-basic", description: "e2e basic fan-out", phases: [{ title: "Fan" }, { title: "Pipe" }, { title: "Shape" }] }
phase("Fan")
const fan = await parallel([1, 2, 3].map((n) => () => agent("Reply with exactly: FAN-" + n + " (nothing else, no tools)", { label: "fan-" + n })))
phase("Pipe")
const piped = await pipeline(["a", "b"],
  (x) => agent("Reply with exactly: UP-" + x + " (nothing else, no tools)", { label: "up-" + x }),
  (prev, item, i) => prev + "|" + item + "|" + i)
phase("Shape")
const shaped = await agent("The city is Paris and the number is 7. Report them.", {
  label: "shape",
  schema: { type: "object", properties: { city: { type: "string" }, n: { type: "number" } }, required: ["city", "n"], additionalProperties: false },
})
log("basic done")
return { fan, piped, shaped }
`

describe.skipIf(!e2eEnabled())("e2e basic", () => {
  let server: E2EServer
  beforeAll(async () => {
    server = await startServer({ label: "basic" })
  }, 120_000)
  afterAll(async () => {
    await server?.stop()
  }, 30_000)

  test(
    "P02 P06 P40 inline script: parallel + pipeline + schema agent, notification, transcript",
    async () => {
      const project = createProject("basic")
      const r = await runPrompt(server, project, launchPrompt({ script: SCRIPT }), { label: "basic" })
      expect(r.sessionID).toBeDefined()
      const calls = workflowToolCalls(r.events)
      expect(calls.length).toBe(1)
      const call = calls[0]
      expect(call.input.script.replace(/\s+/g, " ").trim()).toBe(SCRIPT.replace(/\s+/g, " ").trim())

      // P02: shape, returned immediately (before any agent finished).
      const out = call.output!
      expect(out).toBeDefined()
      expect(out.error).toBeUndefined()
      expect(out.status).toBe("async_launched")
      expect(out.taskType).toBe("local_workflow")
      expect(out.workflowName).toBe("e2e-basic")
      expect(out.runId).toMatch(/^wf_[A-Za-z0-9_-]+$/)
      expect(out.taskId).toMatch(/^task_/)
      expect(typeof out.summary).toBe("string")
      expect(out.transcriptDir && existsSync(out.transcriptDir)).toBeTruthy()
      expect(out.scriptPath).toBe(join(out.transcriptDir!, "script.js"))
      const runId = out.runId!

      // P06: the notification arrives in the parent session and wakes it.
      const { message, notification } = await waitForNotification(server, project, r.sessionID!, runId, 300_000)
      expect(message.time?.created ?? 0).toBeGreaterThan(call.timestamp ?? 0)
      expect(notification.status).toBe("completed")
      expect(notification.runId).toBe(runId)
      expect(notification.taskId).toBe(out.taskId)
      expect(notification.usage.agent_count).toBe(6)
      expect(notification.usage.tokens).toBeGreaterThan(0)
      expect(notification.usage.duration_ms).toBeGreaterThan(0)
      const result = notification.result as any
      expect(result.fan).toHaveLength(3)
      result.fan.forEach((v: string, i: number) => expect(v).toContain(`FAN-${i + 1}`))
      expect(result.piped[0]).toMatch(/UP-a.*\|a\|0$/)
      expect(result.piped[1]).toMatch(/UP-b.*\|b\|1$/)
      expect(result.shaped).toEqual({ city: "Paris", n: 7 })
      const reply = await waitForAssistantAfter(server, project, r.sessionID!, message.time?.created ?? 0)
      expect(assistantText(reply).length).toBeGreaterThan(0)

      // P40: transcript dir contents.
      const t = readTranscript(out.transcriptDir!)
      recordRunCost("basic", t.summary)
      expect(t.script).toBe(call.input.script)
      expect(t.summary?.status).toBe("completed")
      expect(t.summary?.agentCount).toBe(6)
      expect(t.summary?.phases.map((p) => [p.title, p.agents, p.done])).toEqual([
        ["Fan", 3, 3],
        ["Pipe", 2, 2],
        ["Shape", 1, 1],
      ])
      expect(t.summary?.logs).toContain("basic done")
      expect(t.journal).toHaveLength(6)
      expect(t.journal.map((j) => j.index).sort()).toEqual([0, 1, 2, 3, 4, 5])
      for (const j of t.journal) {
        expect(j.type).toBe("result")
        expect(j.status).toBe("completed")
        expect(j.key).toMatch(/^[0-9a-f]{64}$/)
        expect(j.sessionID).toMatch(/^ses_/)
      }
      expect(t.agents.map((a) => a.status)).toEqual(Array(6).fill("completed"))
      expect(t.agents.map((a) => a.phase)).toEqual(["Fan", "Fan", "Fan", "Pipe", "Pipe", "Shape"])
      expect(t.agents[5].label).toBe("shape")

      // P62: child sessions are tagged.
      const child = await server.session(project, t.agents[0].sessionID!)
      const info = child?.data ?? child
      expect(String(info.title)).toStartWith(`[wf:${runId}]`)
      expect(info.metadata?.workflowRunId).toBe(runId)
      expect(info.metadata?.parentSessionID).toBe(r.sessionID)
      // X18: every agent records the model its child session reports.
      expect(t.agents.every((a) => typeof a.model === "string" && a.model.includes("/"))).toBe(true)
      expect(t.agents[0].model).toBe(formatModelRef(info.model))

      // P78: a plain child's first user message starts with SUBAGENT_PREAMBLE, the schema child's with
      // STRUCTURED_SUBAGENT_PREAMBLE; both then carry the script's own prompt.
      const firstUserText = async (sessionID: string) => {
        const m = (await server.messages(project, sessionID)).find((x) => x.type === "user")
        if (typeof m?.text === "string") return m.text
        return (m?.content ?? []).filter((c: any) => c?.type === "text").map((c: any) => c.text).join("")
      }
      const plainText = await firstUserText(t.agents[0].sessionID!)
      expect(plainText).toStartWith(`${SUBAGENT_PREAMBLE}\n\n`)
      expect(plainText).toContain(t.agents[0].prompt)
      const schemaText = await firstUserText(t.agents[5].sessionID!)
      expect(schemaText).toStartWith(`${STRUCTURED_SUBAGENT_PREAMBLE}\n\n`)
      expect(schemaText).toContain(t.agents[5].prompt)
    },
    600_000,
  )

  test(
    "P03 P13 P14 a script failing its static check returns async_launched with error and never runs",
    async () => {
      const project = createProject("badscript")
      const bad = `export const meta = { name: "e2e-bad", description: "bad" }\nimport fs from "node:fs"\nconst x: number = 1\nreturn await agent("never")\n`
      const r = await runPrompt(server, project, launchPrompt({ script: bad }, "reply with the single word REPORTED and stop"), {
        label: "badscript",
      })
      const [call] = workflowToolCalls(r.events)
      expect(call?.output?.status).toBe("async_launched")
      expect(call.output!.error).toMatch(/import|SyntaxError/)
      expect(call.output!.scriptPath).toBeDefined() // P04 even for a failing script
      if (call.output!.transcriptDir) {
        const t = readTranscript(call.output!.transcriptDir)
        expect(t.summary).toBeUndefined()
        expect(t.journal).toEqual([])
        expect(t.agents).toEqual([])
      }
    },
    300_000,
  )
})
