// Live e2e (opencode 2.0.15): resume from the journal (P41), nothing-to-resume (P42), and
// iterating on a script through scriptPath (P04). Enable with OPENCODE_E2E=1 (docs/E2E.md).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import {
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

const V1 = `export const meta = { name: "e2e-resume", description: "resume test" }
const a = await agent("Reply with exactly: R-A (nothing else, no tools)", { label: "a" })
const b = await agent("Reply with exactly: R-B (nothing else, no tools)", { label: "b" })
return { a, b }
`
// Same first call (cached on resume), changed second call, plus a new third call (both live).
const V2 = `export const meta = { name: "e2e-resume", description: "resume test" }
const a = await agent("Reply with exactly: R-A (nothing else, no tools)", { label: "a" })
const b = await agent("Reply with exactly: R-B2 (nothing else, no tools)", { label: "b" })
const c = await agent("Reply with exactly: R-C (nothing else, no tools)", { label: "c" })
return { a, b, c }
`

describe.skipIf(!e2eEnabled())("e2e resume", () => {
  let server: E2EServer
  beforeAll(async () => {
    server = await startServer({ label: "resume" })
  }, 120_000)
  afterAll(async () => {
    await server?.stop()
  }, 30_000)

  test(
    "P41 P04 resumeFromRunId replays the unchanged prefix from the journal; changed calls run live",
    async () => {
      const project = createProject("resume", { "wf/resume.js": V1 })

      // Run 1 via scriptPath (relative to the project dir).
      const r1 = await runPrompt(server, project, launchPrompt({ scriptPath: "wf/resume.js" }), { label: "resume-1" })
      const [c1] = workflowToolCalls(r1.events)
      expect(c1?.output?.error).toBeUndefined()
      const run1 = c1.output!.runId!
      expect(c1.output!.scriptPath).toBe(join(project.dir, "wf", "resume.js")) // P04: the given path is kept
      const n1 = await waitForNotification(server, project, r1.sessionID!, run1)
      expect(n1.notification.status).toBe("completed")
      expect((n1.notification.result as any).a).toContain("R-A")
      const t1 = readTranscript(c1.output!.transcriptDir!)
      recordRunCost("resume-1", t1.summary)
      expect(t1.journal.map((j) => j.status)).toEqual(["completed", "completed"])
      // let the notification turn finish before prompting the same session again
      await waitForAssistantAfter(server, project, r1.sessionID!, n1.message.time?.created ?? 0)

      // Edit the script (P04 iterate) and resume in the same session (P41).
      project.write("wf/resume.js", V2)
      const r2 = await runPrompt(
        server,
        project,
        launchPrompt({ scriptPath: "wf/resume.js", resumeFromRunId: run1 }),
        { session: r1.sessionID, label: "resume-2" },
      )
      const [c2] = workflowToolCalls(r2.events)
      expect(c2?.input?.resumeFromRunId).toBe(run1)
      expect(c2?.output?.error).toBeUndefined()
      const run2 = c2.output!.runId!
      expect(run2).not.toBe(run1) // resumed run gets a new id
      const n2 = await waitForNotification(server, project, r1.sessionID!, run2)
      expect(n2.notification.status).toBe("completed")
      const res = n2.notification.result as any
      expect(res.a).toBe((n1.notification.result as any).a) // cached value, verbatim
      expect(res.b).toContain("R-B2")
      expect(res.c).toContain("R-C")

      const t2 = readTranscript(c2.output!.transcriptDir!)
      recordRunCost("resume-2", t2.summary)
      expect(t2.agents.map((a) => a.status)).toEqual(["cached", "completed", "completed"])
      // the cached agent did not start a new child session
      expect(t2.agents[0].sessionID ?? t1.agents[0].sessionID).toBe(t1.agents[0].sessionID)
      expect(t2.agents[1].sessionID).not.toBe(t1.agents[1].sessionID)
      // the resumed run's journal holds all three results (so it can be resumed again)
      expect(t2.journal.map((j) => j.index).sort()).toEqual([0, 1, 2])
      expect(t2.journal.find((j) => j.index === 0)?.key).toBe(t1.journal.find((j) => j.index === 0)?.key)
      expect(t2.journal.find((j) => j.index === 1)?.key).not.toBe(t1.journal.find((j) => j.index === 1)?.key)
      // cached agents are not counted as live usage
      expect(t2.summary?.agentCount).toBe(3)
      await waitForAssistantAfter(server, project, r1.sessionID!, n2.message.time?.created ?? 0)

      // P42: an unknown run id is refused with "nothing to resume" and nothing runs.
      const r3 = await runPrompt(
        server,
        project,
        launchPrompt({ scriptPath: "wf/resume.js", resumeFromRunId: "wf_doesnotexist0_00000000" }),
        { session: r1.sessionID, label: "resume-3" },
      )
      const [c3] = workflowToolCalls(r3.events)
      expect(c3?.output?.status).toBe("async_launched")
      expect(c3?.output?.error).toMatch(/nothing to resume/)
      if (c3?.output?.transcriptDir) {
        expect(existsSync(join(c3.output.transcriptDir, "run.json"))).toBe(false)
        expect(existsSync(join(c3.output.transcriptDir, "journal.jsonl"))).toBe(false)
      }
    },
    600_000,
  )
})
