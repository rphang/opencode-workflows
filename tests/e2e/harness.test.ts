// Offline tests for the e2e harness helpers (no opencode, no network). The live suites are the
// other files in this directory; they are skipped unless E2E is enabled (see docs/E2E.md).
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  e2eEnabled,
  findSyntheticNotification,
  parseNotification,
  parseRunEvents,
  readTranscript,
  shouldRetryRun,
  summarizeRun,
  launchTurnText,
  requireLaunch,
  workflowToolCalls,
} from "./harness.ts"

const SES = "ses_abc"
const ev = (o: Record<string, unknown>) => JSON.stringify({ timestamp: 1, sessionID: SES, ...o })

const STDOUT = [
  ev({ type: "step_start", part: { type: "step-start" } }),
  "not json at all",
  ev({
    type: "tool_use",
    timestamp: 5,
    part: {
      type: "tool",
      tool: "workflow",
      state: { status: "completed", input: { script: "S" }, output: JSON.stringify({ status: "async_launched", runId: "wf_1" }) },
    },
  }),
  ev({
    type: "tool_use",
    part: { type: "tool", tool: "workflow_control", state: { status: "completed", input: { action: "list" }, output: "no runs" } },
  }),
  ev({
    type: "step_finish",
    part: { type: "step-finish", cost: 0.01, tokens: { input: 100, output: 5, reasoning: 2, cache: { read: 10, write: 0 } } },
  }),
  ev({ type: "text", part: { type: "text", text: "LAUNCHED" } }),
  ev({ type: "step_finish", part: { type: "step-finish", cost: 0.002, tokens: { input: 10, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } } }),
  "",
].join("\n")

describe("harness: run event parsing", () => {
  test("parseRunEvents keeps only JSON object lines", () => {
    const events = parseRunEvents(STDOUT)
    expect(events.map((e) => e.type)).toEqual(["step_start", "tool_use", "tool_use", "step_finish", "text", "step_finish"])
  })

  test("summarizeRun extracts session, texts, cost and tokens", () => {
    const s = summarizeRun(parseRunEvents(STDOUT))
    expect(s.sessionID).toBe(SES)
    expect(s.texts).toEqual(["LAUNCHED"])
    expect(s.cost).toBeCloseTo(0.012, 6)
    expect(s.tokens).toEqual({ input: 110, output: 6, reasoning: 2, cacheRead: 10 })
    expect(s.toolUses.map((t) => t.tool)).toEqual(["workflow", "workflow_control"])
  })

  test("launchTurnText joins the assistant text parts of a run (the demo's end-of-launch-turn text)", () => {
    expect(launchTurnText(summarizeRun(parseRunEvents(STDOUT)))).toBe("LAUNCHED")
    expect(launchTurnText({ texts: ["a", "b"] })).toBe("a\nb")
    expect(launchTurnText({ texts: [] })).toBe("(no assistant text)")
  })

  test("requireLaunch returns the first launched workflow call, and throws at once when the parent launched none", () => {
    const call = requireLaunch(workflowToolCalls(parseRunEvents(STDOUT)))
    expect(call.output?.runId).toBe("wf_1")
    expect(() => requireLaunch([])).toThrow(/parent did not call the workflow tool/)
    const failed = ev({ type: "tool_use", part: { type: "tool", tool: "workflow", state: { status: "completed", input: {}, output: JSON.stringify({ error: "bad meta" }) } } })
    expect(() => requireLaunch(workflowToolCalls(parseRunEvents(failed)))).toThrow(/no runId.*bad meta/)
  })

  test("workflowToolCalls parses the workflow tool output JSON", () => {
    const calls = workflowToolCalls(parseRunEvents(STDOUT))
    expect(calls).toHaveLength(1)
    expect(calls[0].input).toEqual({ script: "S" })
    expect(calls[0].output).toEqual({ status: "async_launched", runId: "wf_1" } as any)
    expect(calls[0].timestamp).toBe(5)
  })

  test("workflowToolCalls tolerates non-JSON output (output undefined, raw kept)", () => {
    const raw = ev({ type: "tool_use", part: { type: "tool", tool: "workflow", state: { status: "error", input: {}, error: "boom" } } })
    const calls = workflowToolCalls(parseRunEvents(raw))
    expect(calls[0].output).toBeUndefined()
    expect(calls[0].status).toBe("error")
  })
})

const NOTE = [
  "<task-notification>",
  "<task-id>task_1</task-id>",
  "<run-id>wf_1</run-id>",
  "<status>completed</status>",
  '<summary>Dynamic workflow "tiny" completed</summary>',
  '<result>{\n  "a": "ONE"\n}</result>',
  "<usage>agent_count: 3\ntokens: 9821\nduration_ms: 2753</usage>",
  "<script-path>C:\\x\\script.js</script-path>",
  "<transcript-dir>C:\\x</transcript-dir>",
  "</task-notification>",
].join("\n")

describe("harness: notifications", () => {
  test("parseNotification reads every tag and the usage block", () => {
    const n = parseNotification(NOTE)!
    expect(n.taskId).toBe("task_1")
    expect(n.runId).toBe("wf_1")
    expect(n.status).toBe("completed")
    expect(n.summary).toContain("tiny")
    expect(n.resultRaw).toBe('{\n  "a": "ONE"\n}')
    expect(n.result).toEqual({ a: "ONE" })
    expect(n.usage).toEqual({ agent_count: 3, tokens: 9821, duration_ms: 2753 })
    expect(n.scriptPath).toBe("C:\\x\\script.js")
    expect(n.transcriptDir).toBe("C:\\x")
  })

  test("parseNotification keeps a non-JSON result as a string and rejects other text", () => {
    const n = parseNotification(NOTE.replace(/<result>[\s\S]*<\/result>/, "<result>plain text</result>"))!
    expect(n.result).toBe("plain text")
    expect(parseNotification("hello")).toBeUndefined()
  })

  test("findSyntheticNotification matches by run id in metadata", () => {
    const msgs = [
      { id: "m1", type: "assistant", content: [] },
      { id: "m2", type: "synthetic", text: NOTE, metadata: { workflowRunId: "wf_1" }, time: { created: 9 } },
      { id: "m3", type: "synthetic", text: "other", metadata: { workflowRunId: "wf_2" } },
    ]
    expect(findSyntheticNotification(msgs, "wf_1")?.id).toBe("m2")
    expect(findSyntheticNotification(msgs, "wf_9")).toBeUndefined()
    expect(findSyntheticNotification(msgs, (m) => m.metadata?.workflowRunId === "wf_2")?.id).toBe("m3")
  })
})

describe("harness: transcript reader", () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-e2e-harness-"))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test("readTranscript loads script, journal lines, run.json and agent records", () => {
    mkdirSync(join(dir, "agents"))
    writeFileSync(join(dir, "script.js"), "export const meta = {}")
    writeFileSync(
      join(dir, "journal.jsonl"),
      JSON.stringify({ type: "result", index: 1, key: "k1", status: "completed" }) + "\n{torn\n" + JSON.stringify({ type: "result", index: 0, key: "k0", status: "failed" }) + "\n",
    )
    writeFileSync(join(dir, "run.json"), JSON.stringify({ runId: "wf_1", status: "completed" }))
    writeFileSync(join(dir, "agents", "0.json"), JSON.stringify({ index: 0, status: "failed" }))
    writeFileSync(join(dir, "agents", "10.json"), JSON.stringify({ index: 10, status: "completed" }))
    writeFileSync(join(dir, "agents", "2.json"), JSON.stringify({ index: 2, status: "completed" }))
    const t = readTranscript(dir)
    expect(t.script).toBe("export const meta = {}")
    expect(t.journal.map((j) => j.index)).toEqual([1, 0])
    expect(t.journalRawLines).toBe(3)
    expect(t.summary?.runId).toBe("wf_1")
    expect(t.agents.map((a) => a.index)).toEqual([0, 2, 10])
  })

  test("readTranscript on a missing dir returns empty fields", () => {
    const t = readTranscript(join(dir, "nope"))
    expect(t.script).toBeUndefined()
    expect(t.journal).toEqual([])
    expect(t.summary).toBeUndefined()
    expect(t.agents).toEqual([])
  })
})

describe("harness: gating", () => {
  test("e2eEnabled needs OPENCODE_E2E=1 and an OpenAI key", () => {
    expect(e2eEnabled({ OPENCODE_E2E: "1", OPENAI_API_KEY: "k" })).toBe(true)
    expect(e2eEnabled({ OPENAI_API_KEY: "k" })).toBe(false)
    expect(e2eEnabled({ OPENCODE_E2E: "1" })).toBe(false)
    expect(e2eEnabled({ OPENCODE_E2E: "0", OPENAI_API_KEY: "k" })).toBe(false)
  })
})

describe("harness: retry decision", () => {
  const withTool = parseRunEvents(STDOUT)
  const refusal = parseRunEvents(
    [ev({ type: "step_start", part: { type: "step-start" } }), ev({ type: "text", part: { type: "text", text: "I can't help with that." } })].join("\n"),
  )
  test("retries a startup stall (no events at all)", () => {
    expect(shouldRetryRun([], {})).toBe(true)
    expect(shouldRetryRun([], { session: "ses_x" })).toBe(true)
  })
  test("retries a fresh-session turn that called no tool (model refused or ignored the prompt)", () => {
    expect(shouldRetryRun(refusal, {})).toBe(true)
  })
  test("never retries once any tool ran, nor a no-tool turn in an existing session", () => {
    expect(shouldRetryRun(withTool, {})).toBe(false)
    expect(shouldRetryRun(refusal, { session: "ses_x" })).toBe(false)
  })
})
