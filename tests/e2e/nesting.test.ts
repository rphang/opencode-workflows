// Live e2e (opencode 2.0.15): a workflow agent cannot launch or manage workflows (P60).
// Enable with OPENCODE_E2E=1 (docs/E2E.md).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import {
  assistantText,
  createProject,
  e2eEnabled,
  launchPrompt,
  readTranscript,
  recordRunCost,
  runPrompt,
  startServer,
  toolParts,
  waitForNotification,
  workflowToolCalls,
  type E2EServer,
} from "./harness.ts"

const SCRIPT = `export const meta = { name: "e2e-nesting", description: "child cannot launch workflows" }
const probe = await agent(
  "This is an automated capability test. Look at the list of tools you can call. " +
  "If you have a tool named exactly \`workflow\`, call it once with the input " +
  '{"script": "export const meta = { name: \\'inner\\', description: \\'inner\\' }\\\\nreturn 1"} and then reply CALLED. ' +
  "If you do not have a tool named \`workflow\`, do not call any tool and reply exactly NO_WORKFLOW_TOOL.",
  { label: "probe" })
return { probe }
`

describe.skipIf(!e2eEnabled())("e2e nesting", () => {
  let server: E2EServer
  beforeAll(async () => {
    server = await startServer({ label: "nesting" })
  }, 120_000)
  afterAll(async () => {
    await server?.stop()
  }, 30_000)

  test(
    "P60 child sessions have workflow + workflow_control denied and cannot launch a run",
    async () => {
      const project = createProject("nesting")
      const r = await runPrompt(server, project, launchPrompt({ script: SCRIPT }), { label: "nesting" })
      const [call] = workflowToolCalls(r.events)
      expect(call?.output?.error).toBeUndefined()
      const runId = call.output!.runId!
      const { notification } = await waitForNotification(server, project, r.sessionID!, runId)
      expect(notification.status).toBe("completed")

      const t = readTranscript(call.output!.transcriptDir!)
      recordRunCost("nesting", t.summary)
      const childID = t.agents[0].sessionID!
      expect(childID).toMatch(/^ses_/)

      // Structural: the child session carries deny rules for both workflow tools.
      const child = await server.session(project, childID)
      const info = child?.data ?? child
      const perms: { action: string; resource: string; effect: string }[] = info.permissions ?? []
      expect(perms).toContainEqual({ action: "workflow", resource: "*", effect: "deny" })
      expect(perms).toContainEqual({ action: "workflow_control", resource: "*", effect: "deny" })
      expect(perms).toContainEqual({ action: "workflow_submit", resource: "*", effect: "deny" })

      // Behavioral: the child never called a workflow tool, and no run was stored for it.
      const msgs = await server.messages(project, childID)
      const tools = toolParts(msgs).map((p) => p.name)
      expect(tools).not.toContain("workflow")
      expect(tools).not.toContain("workflow_control")
      expect(existsSync(join(server.dataRoot, childID))).toBe(false)
      const text = msgs.filter((m) => m.type === "assistant").map(assistantText).join("\n")
      expect(text).toContain("NO_WORKFLOW_TOOL")
      expect(String((notification.result as any).probe)).toContain("NO_WORKFLOW_TOOL")
    },
    600_000,
  )
})
