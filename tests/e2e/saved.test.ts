// Live e2e (opencode 2.0.15): a saved workflow in <project>/.opencode/workflows runs by name and
// as the /<name> command with the rest of the line as args (P53, P05). Enable with OPENCODE_E2E=1.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  createProject,
  e2eEnabled,
  launchPrompt,
  readTranscript,
  recordRunCost,
  runPrompt,
  startServer,
  syntheticEntries,
  waitUntil,
  waitForAssistantAfter,
  waitForNotification,
  workflowToolCalls,
  type E2EServer,
} from "./harness.ts"

const GREET = `export const meta = { name: "e2e-greet", description: "greets someone", whenToUse: "e2e only" }
const who = typeof args === "string" && args.trim() ? args.trim() : "nobody"
const g = await agent("Reply with exactly: HELLO-" + who.toUpperCase() + " (nothing else, no tools)", { label: "greet" })
return { who, argsType: typeof args, g }
`
// Non-literal meta: must NOT be registered as a command (P11) and must not shadow anything.
const BROKEN = `const n = "e2e-broken"
export const meta = { name: n, description: "x" }
return 1
`

describe.skipIf(!e2eEnabled())("e2e saved workflows", () => {
  let server: E2EServer
  beforeAll(async () => {
    server = await startServer({ label: "saved" })
  }, 120_000)
  afterAll(async () => {
    await server?.stop()
  }, 30_000)

  test(
    "P53 saved workflow runs via name and via /<name> args; P11 non-literal meta is dropped",
    async () => {
      const project = createProject("saved", {
        ".opencode/workflows/greet.js": GREET,
        ".opencode/workflows/broken.js": BROKEN,
      })

      // 1. By name through the workflow tool, args passed verbatim (P05).
      const r = await runPrompt(server, project, launchPrompt({ name: "e2e-greet", args: "bob" }), { label: "saved-name" })
      const [call] = workflowToolCalls(r.events)
      expect(call?.output?.error).toBeUndefined()
      expect(call.output!.workflowName).toBe("e2e-greet")
      const n1 = await waitForNotification(server, project, r.sessionID!, call.output!.runId!)
      expect(n1.notification.status).toBe("completed")
      expect(n1.notification.result).toMatchObject({ who: "bob", argsType: "string" })
      expect(String((n1.notification.result as any).g)).toContain("HELLO-BOB")
      recordRunCost("saved-name", readTranscript(call.output!.transcriptDir!).summary)
      await waitForAssistantAfter(server, project, r.sessionID!, n1.message.time?.created ?? 0)

      // 2. The command list has /e2e-greet (and not the broken one).
      const names = JSON.stringify(await server.api(project, "GET", "/api/command"))
      expect(names).toContain("e2e-greet")
      expect(names).toContain("workflows")
      expect(names).toContain("workflow-authoring")
      expect(names).toContain("deep-research") // P54 bundled
      expect(names).not.toContain("e2e-broken")

      // 3. As a slash command on the same session: /e2e-greet alice
      const before = Date.now()
      await server.api(project, "POST", `/api/session/${r.sessionID}/command`, { name: "e2e-greet", text: "alice" })
      const n2 = await waitForNotification(
        server,
        project,
        r.sessionID!,
        (m) => m.metadata?.workflowRunId !== call.output!.runId && (m.time?.created ?? 0) >= before - 1000,
      )
      expect(n2.notification.status).toBe("completed")
      expect(n2.notification.result).toMatchObject({ who: "alice", argsType: "string" })
      expect(String((n2.notification.result as any).g)).toContain("HELLO-ALICE")
      recordRunCost("saved-command", readTranscript(n2.notification.transcriptDir!).summary)
      await waitForAssistantAfter(server, project, r.sessionID!, n2.message.time?.created ?? 0)

      // 4. P50: /workflows lists both runs of this session (synthetic, does not start a turn).
      const beforeList = Date.now()
      await server.api(project, "POST", `/api/session/${r.sessionID}/command`, { name: "workflows", text: "" })
      const list = await waitUntil(
        async () =>
          (await syntheticEntries(server, project, r.sessionID!)).find(
            (m) => m.created >= beforeList - 1000 && m.text.includes("Workflow runs"),
          ),
        { timeoutMs: 30_000, what: "/workflows output" },
      )
      expect(list.text).toContain(call.output!.runId!)
      expect(list.text).toContain(n2.notification.runId!)
      expect(list.text).toContain("e2e-greet")
      // /workflows <runId> shows the agents of one run
      const beforeStatus = Date.now()
      await server.api(project, "POST", `/api/session/${r.sessionID}/command`, { name: "workflows", text: call.output!.runId! })
      const status = await waitUntil(
        async () =>
          (await syntheticEntries(server, project, r.sessionID!)).find(
            (m) => m.id !== list.id && m.created >= beforeStatus - 1000 && m.text.includes("greet"),
          ),
        { timeoutMs: 30_000, what: "/workflows <runId> output" },
      )
      expect(status.text).toContain(call.output!.runId!)
      // Finding: synthetic({resume:false}) on an idle session is queued in the inbox (pending)
      // until the next turn, the same way opencode delivers `!shell` results (see docs/E2E.md).
    },
    600_000,
  )
})
