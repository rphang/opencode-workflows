// Live e2e (opencode 2.0.15): workflow_control `result` (X21), and what the parent model does with
// the notification's `<agent-failures>` (X20) and `<diagnostics>` (P79). `result` answers as soon as
// the run has finished; there is no notification gate. Enable with OPENCODE_E2E=1 (docs/E2E.md); a
// free parent model works: OPENCODE_E2E_MODEL=opencode/<free model> (OPENAI_API_KEY only has to be set).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  assistantText,
  createProject,
  e2eEnabled,
  launchPrompt,
  readTranscript,
  recordRunCost,
  requireLaunch,
  runPrompt,
  startServer,
  toolParts,
  waitForAssistantAfter,
  waitForNotification,
  workflowToolCalls,
  type E2EServer,
} from "./harness.ts"

// The prompts never contain the markers verbatim (the detail view prints the prompt), so a marker in
// a workflow_control output can only come from the agent's return value.
const SCRIPT = `export const meta = { name: "e2e-results", description: "e2e per-agent results" }
const r = await parallel([
  () => agent("Reply with the word ALPHA, then a hyphen, then the number 7731, with no spaces (nothing else, no tools)", { label: "alpha" }),
  () => agent("Reply with the word BETA, then a hyphen, then the number 5512, with no spaces (nothing else, no tools)", { label: "beta" }),
])
return ""
`

// Two of four agents fail at once (an unknown agentType fails that agent without a model call, P27).
const PARTIAL = `export const meta = { name: "e2e-partial", description: "Confirm four regions", phases: [{ title: "Check" }] }
const regions = ["north", "south", "east", "west"]
const out = await pipeline(regions, (r, _item, i) =>
  agent("Reply with exactly the word OK and nothing else.", { label: "check-" + r, phase: "Check", agentType: i === 1 || i === 3 ? "no-such-agent" : undefined }))
return { confirmed: out.filter(Boolean).length }
`

describe.skipIf(!e2eEnabled())("e2e results", () => {
  let server: E2EServer
  beforeAll(async () => {
    server = await startServer({ label: "results" })
  }, 120_000)
  afterAll(async () => {
    await server?.stop()
  }, 30_000)

  test(
    "X21 P79 the notification points at result; workflow_control result returns an agent's full return value",
    async () => {
      const project = createProject("results")
      const r = await runPrompt(server, project, launchPrompt({ script: SCRIPT }), { label: "results" })
      const out = requireLaunch(workflowToolCalls(r.events)).output
      const runId = out.runId

      const { message } = await waitForNotification(server, project, r.sessionID!, runId, 300_000)
      const text = String(message.text)
      expect(text).toContain("<diagnostics>")
      expect(text).toContain(`workflow_control {action:"result", runId:"${runId}"}`)
      await waitForAssistantAfter(server, project, r.sessionID!, message.time?.created ?? 0)

      const ask = await runPrompt(
        server,
        project,
        `Call the workflow_control tool exactly once with exactly this JSON input: {"action":"result","runId":"${runId}","agent":"beta"}. Then reply with the single word DONE. Do not call any other tool.`,
        { session: r.sessionID!, label: "results-ask" },
      )
      const calls = workflowToolCalls(ask.events, "workflow_control")
      expect(calls.length).toBeGreaterThanOrEqual(1)
      const parts = toolParts(await server.messages(project, r.sessionID!)).filter((p) => p.name === "workflow_control")
      const outputs = [...new Set([...calls.map((c) => String(c.raw ?? "")), ...parts.map((p) => String(p.state?.output ?? ""))])]
      const inputs = [...calls.map((c) => c.input), ...parts.map((p) => p.state?.input)]
      console.log(`[results] workflow_control inputs: ${JSON.stringify(inputs)}`)
      // The detail view (X21) when the model passed `agent`; the list when it dropped it (space-bunny
      // did once: it sent agentIndex/offset/location instead). Both are accepted, and the log says
      // which ran; the detail path is always covered by tests/parity/results.test.ts.
      const details = outputs.filter((o) => o.startsWith("Agent #"))
      if (details.length) {
        const beta = details.find((o) => o.startsWith(`Agent #1 "beta" of run ${runId}`))
        expect(beta).toBeDefined()
        expect(beta!).toMatch(/\nReturn value \(text, \d+ chars\):\n[^\n]*BETA-5512/)
        console.log("[results] detail path: agent #1 \"beta\" returned BETA-5512")
      } else {
        const list = outputs.find((o) => o.startsWith(`Run ${runId} completed: 2 agents`))
        expect(list).toBeDefined()
        expect(list!).toMatch(/\n#1 "beta" completed [^\n]*→ [^\n]*BETA-5512/)
        console.log("[results] list path only: the model dropped `agent`; the preview row shows BETA-5512")
      }

      recordRunCost("results", readTranscript(out.transcriptDir!).summary)
    },
    600_000,
  )

  test(
    "X20 P77 a partial failure: the parent does not poll before the notification, reads no transcript file, and names the failed agents",
    async () => {
      const project = createProject("partial")
      const r = await runPrompt(
        server,
        project,
        "ultracode. Launch the workflow below with the `workflow` tool (inline `script`, no args), then end your turn. " +
          "When its result arrives, tell me in one short paragraph which regions were confirmed and which were not, and why " +
          "any failed. Do not relaunch anything.\n```js\n" +
          PARTIAL +
          "```",
        { label: "partial" },
      )
      const out = requireLaunch(workflowToolCalls(r.events)).output
      const runId = out.runId
      // The launch turn: at most a few progress calls (the eval's pass bar), and never `result` output.
      const early = workflowToolCalls(r.events, "workflow_control")
      expect(early.length).toBeLessThanOrEqual(3)

      const { message } = await waitForNotification(server, project, r.sessionID!, runId, 300_000)
      const notified = message.time?.created ?? 0
      expect(String(message.text)).toMatch(/<agent-failures>2 of 4 agents returned no result/)
      await waitForAssistantAfter(server, project, r.sessionID!, notified, 180_000)

      const messages = await server.messages(project, r.sessionID!)
      const before = toolParts(messages.filter((m) => (m.time?.created ?? 0) < notified)).filter((p) => p.name === "workflow_control")
      expect(before.length).toBeLessThanOrEqual(3)
      // No transcript-dir reads (read, bash, grep, glob …), before or after the notification.
      const dir = out.transcriptDir!.replace(/\\/g, "/").toLowerCase()
      const touched = toolParts(messages).filter((p) => JSON.stringify(p.state?.input ?? {}).replace(/\\\\/g, "/").toLowerCase().includes(dir))
      expect(touched.map((p) => p.name)).toEqual([])
      // Nothing relaunched.
      expect(toolParts(messages).filter((p) => p.name === "workflow")).toHaveLength(1)

      const reply = messages
        .filter((m) => m.type === "assistant" && (m.time?.created ?? 0) >= notified)
        .map((m) => assistantText(m))
        .join("\n")
      const after = toolParts(messages.filter((m) => (m.time?.created ?? 0) >= notified)).map((p) => p.name)
      console.log(
        `[partial] ${r.sessionID} launch-turn workflow_control=${early.length} before-notification=${before.length} ` +
          `tools-after=${JSON.stringify(after)}\n[partial] reply: ${reply.replace(/\s+/g, " ").slice(0, 600)}`,
      )
      expect(reply).toMatch(/south/i)
      expect(reply).toMatch(/west/i)

      recordRunCost("partial", readTranscript(out.transcriptDir!).summary)
    },
    600_000,
  )
})
