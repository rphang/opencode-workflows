// Live e2e (opencode 2.0.15): workflow_control stop_agent (single agent -> failed, agent() -> null)
// and stop (whole run -> stopped, no agent counted as failed) (P51, P44). Enable with OPENCODE_E2E=1.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  createProject,
  e2eEnabled,
  launchPrompt,
  readTranscript,
  recordRunCost,
  runPrompt,
  sleep,
  startServer,
  waitForNotification,
  waitUntil,
  workflowToolCalls,
  type E2EProject,
  type E2EServer,
} from "./harness.ts"

const ESSAY = (topic: string) =>
  `Write a very long, detailed essay of at least 5000 words about the history of ${topic}. Do not use any tools. Do not stop early.`

const SCRIPT = `export const meta = { name: "e2e-stop", description: "stop test" }
const first = await agent(${JSON.stringify(ESSAY("the oceans"))}, { label: "long1" })
log("first=" + JSON.stringify(first))
const second = await agent(${JSON.stringify(ESSAY("mountains"))}, { label: "long2" })
return { first, second }
`

function controlPrompt(input: Record<string, unknown>): string {
  return [
    "Call the `workflow_control` tool exactly once with exactly this JSON input:",
    "```json",
    JSON.stringify(input),
    "```",
    "Then reply with the single word DONE and stop. Do not call any other tool.",
  ].join("\n")
}

async function waitRunning(dir: string, index: number) {
  return waitUntil(
    () => {
      const a = readTranscript(dir).agents.find((x) => x.index === index)
      return a?.status === "running" ? a : undefined
    },
    { timeoutMs: 120_000, intervalMs: 500, what: `agent ${index} running` },
  )
}

describe.skipIf(!e2eEnabled())("e2e stop", () => {
  let server: E2EServer
  let project: E2EProject
  beforeAll(async () => {
    server = await startServer({ label: "stop" })
  }, 120_000)
  afterAll(async () => {
    await server?.stop()
  }, 30_000)

  test(
    "P51 P44 stop_agent makes one agent fail (null); stop ends the run as stopped without failing agents",
    async () => {
      project = createProject("stop")
      const r = await runPrompt(server, project, launchPrompt({ script: SCRIPT }), { label: "stop-launch" })
      const [call] = workflowToolCalls(r.events)
      expect(call?.output?.error).toBeUndefined()
      const runId = call.output!.runId!
      const dir = call.output!.transcriptDir!

      // 1. stop_agent 0 while its essay is streaming.
      await waitRunning(dir, 0)
      await sleep(2000)
      const s1 = await runPrompt(server, project, controlPrompt({ action: "stop_agent", runId, agentIndex: 0 }), {
        session: r.sessionID,
        label: "stop-agent",
      })
      const [ctl1] = workflowToolCalls(s1.events, "workflow_control")
      expect(ctl1?.raw).toContain("Stopped agent 0")

      // 2. agent 1 starts (the script continued with first === null); stop the whole run.
      await waitRunning(dir, 1)
      await sleep(2000)
      const s2 = await runPrompt(server, project, controlPrompt({ action: "stop", runId }), { session: r.sessionID, label: "stop-run" })
      const [ctl2] = workflowToolCalls(s2.events, "workflow_control")
      expect(ctl2?.raw).toContain(`Stopping run ${runId}`)

      const { notification } = await waitForNotification(server, project, r.sessionID!, runId)
      expect(notification.status).toBe("stopped")
      expect(notification.resultRaw).toContain("resumeFromRunId")

      const t = await waitUntil(
        () => {
          const x = readTranscript(dir)
          return x.journal.length >= 2 && x.summary?.status === "stopped" ? x : undefined
        },
        { timeoutMs: 60_000, what: "journal with 2 entries" },
      )
      recordRunCost("stop", t.summary)
      expect(t.summary?.logs).toContain("first=null")
      const j0 = t.journal.find((j) => j.index === 0)!
      const j1 = t.journal.find((j) => j.index === 1)!
      expect(j0.status).toBe("failed") // P51: single-agent stop counts as failed
      expect(j0.error).toContain("stopped by user")
      expect(j1.status).toBe("stopped") // P44: whole-run stop does not count as failed
      expect(t.agents.map((a) => a.status)).toEqual(["failed", "stopped"])

      // The child sessions were really interrupted.
      for (const a of t.agents) {
        const s = await server.session(project, a.sessionID!)
        expect((s?.data ?? s).outcome).toBe("interrupted")
      }
    },
    600_000,
  )
})
