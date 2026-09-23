// Live e2e (opencode 2.0.15): steering a running workflow agent (PARITY X01, X03, X06).
// Enable with OPENCODE_E2E=1 (docs/E2E.md).
//
// The test project gets a second plugin with a `slow_step` tool (3 s per call, logged to a file), so
// a child's turn has several model steps and the test knows when a step is in progress. Messages
// are sent the way a user does: the /workflows msg command, over the server API.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  assistantText,
  createProject,
  e2eEnabled,
  launchPrompt,
  readTranscript,
  recordCost,
  recordRunCost,
  runPrompt,
  startServer,
  syntheticEntries,
  waitForAssistantAfter,
  waitForNotification,
  waitUntil,
  workflowToolCalls,
  type E2EProject,
  type E2EServer,
  type SessionMessage,
} from "./harness.ts"

const STEP_LOG = "slow-steps.jsonl"

function slowStepPlugin(logPath: string): string {
  return `import { appendFileSync } from "node:fs"
const LOG = ${JSON.stringify(logPath)}
const log = (o) => appendFileSync(LOG, JSON.stringify({ ...o, t: Date.now() }) + "\\n")
export default {
  id: "e2e-slow-step",
  async setup(ctx) {
    await ctx.tool.transform((e) => {
      e.add({
        name: "slow_step",
        description: "Performs processing step n of a job; each call takes about 3 seconds. Call with {n: number}.",
        input: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
        options: { codemode: false },
        execute: async (input, tctx) => {
          log({ n: input.n, sessionID: tctx.sessionID, phase: "start" })
          await new Promise((r) => setTimeout(r, 3000))
          log({ n: input.n, sessionID: tctx.sessionID, phase: "done" })
          return { content: "step " + input.n + " done" }
        },
      })
    })
  },
}
`
}

interface StepLine {
  n: number
  sessionID: string
  phase: "start" | "done"
  t: number
}

function steps(project: E2EProject): StepLine[] {
  try {
    return readFileSync(join(project.dir, STEP_LOG), "utf8")
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l))
  } catch {
    return []
  }
}

function newProject(name: string): E2EProject {
  const project = createProject(name)
  project.write(".opencode/plugins/slow-step.js", slowStepPlugin(join(project.dir, STEP_LOG).replace(/\\/g, "/")))
  project.commit("slow_step tool")
  return project
}

// Four slow steps, one tool call each: a turn with several step boundaries.
const MID_SCRIPT = `export const meta = { name: "e2e-steer", description: "steer a running agent" }
const a = await agent("Call the slow_step tool four times, one call at a time, with n = 1, then 2, then 3, then 4. Wait for each call to finish before the next. After the fourth call, reply with exactly: PLAIN-DONE", { label: "stepper" })
return a
`

// One slow step, then a short final answer: the message is sent as that final step starts.
const LATE_SCRIPT = `export const meta = { name: "e2e-steer-late", description: "steer at the end of a turn" }
const a = await agent("Call the slow_step tool once with n = 1. When it has finished, reply with exactly: FIRST-ANSWER", { label: "late" })
return a
`

async function sendCommand(server: E2EServer, project: E2EProject, sessionID: string, text: string): Promise<string> {
  const before = (await syntheticEntries(server, project, sessionID)).length
  await server.api(project, "POST", `/api/session/${sessionID}/command`, { name: "workflows", text })
  const all = await waitUntil(
    async () => {
      const s = await syntheticEntries(server, project, sessionID)
      return s.length > before ? s : undefined
    },
    { timeoutMs: 30_000, intervalMs: 200, what: "/workflows msg reply" },
  )
  return all.map((s) => s.text).find((t) => t.startsWith("Message to run")) ?? all.at(-1)!.text
}

function journalLines(dir: string): any[] {
  return readFileSync(join(dir, "journal.jsonl"), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
}

function assistantTexts(messages: SessionMessage[]): string[] {
  return messages.filter((m) => m.type === "assistant").map(assistantText).filter((t) => t.trim())
}

describe.skipIf(!e2eEnabled())("e2e steer", () => {
  let server: E2EServer
  beforeAll(async () => {
    server = await startServer({ label: "steer" })
  }, 120_000)
  afterAll(async () => {
    await server?.stop()
  }, 30_000)

  let first: { project: E2EProject; parent: string; runId: string; dir: string; childID: string } | undefined

  // The runner sends steers with resume:false and wakes the child itself (settleMessages): this pins
  // the two opencode behaviours it relies on. It also reproduces why a /workflows reply (a resume:false
  // steer synthetic in the parent) gets its own model step at the parent's next wake, before a queued
  // item such as the task notification.
  test(
    "X03 opencode: a resume:false steer in an idle session stays parked (no turn); interrupt({resume:true}) starts the turn that reads it",
    async () => {
      const project = newProject("steer-park")
      const r = await runPrompt(server, project, "Reply with exactly: READY", { label: "steer-park", retries: 0 })
      const sid = r.sessionID!
      const count = (m: SessionMessage[]) => m.filter((x) => x.type === "assistant").length
      const before = await server.messages(project, sid)
      const syn = await server.api(project, "POST", `/api/session/${sid}/synthetic`, {
        text: "Reply with exactly: PARKED-READ",
        delivery: "steer",
        resume: false,
      })
      const synID = syn?.data?.id ?? syn?.id
      await new Promise((res) => setTimeout(res, 5000))
      const mid = await server.messages(project, sid)
      expect(count(mid)).toBe(count(before)) // no turn ran
      expect(mid.some((m) => m.id === synID)).toBe(false) // still in the inbox
      const res = await server.api(project, "POST", `/api/session/${sid}/interrupt?resume=true`)
      expect(res?.interrupted ?? res?.data?.interrupted).toBe(false) // idle: nothing was interrupted
      const after = await waitUntil(
        async () => {
          const m = await server.messages(project, sid)
          return assistantTexts(m).join("\n").includes("PARKED-READ") ? m : undefined
        },
        { timeoutMs: 120_000, intervalMs: 500, what: "the reply to the parked steer" },
      )
      expect(after.some((m) => m.id === synID)).toBe(true)

      // A parked steer and a queued resume:true item (what the task notification is): the wake
      // promotes the steer first, in a step of its own, then the queued item in another.
      const n0 = count(after)
      const parked = await server.api(project, "POST", `/api/session/${sid}/synthetic`, {
        text: "(This is the output of a /workflows command. It needs no answer.)",
        delivery: "steer",
        resume: false,
      })
      const queued = await server.api(project, "POST", `/api/session/${sid}/synthetic`, {
        text: "Reply with exactly: NOTIFIED",
        delivery: "queue",
        resume: true,
      })
      const done = await waitUntil(
        async () => {
          const m = await server.messages(project, sid)
          return assistantTexts(m).join("\n").includes("NOTIFIED") ? m : undefined
        },
        { timeoutMs: 120_000, intervalMs: 500, what: "the reply to the queued item" },
      )
      const iParked = done.findIndex((m) => m.id === (parked?.data?.id ?? parked?.id))
      const iQueued = done.findIndex((m) => m.id === (queued?.data?.id ?? queued?.id))
      const between = done.slice(iParked + 1, iQueued).filter((m) => m.type === "assistant").length
      recordCost("steer-park", { kind: "note", assistantTurnsForTwoItems: count(done) - n0, between, parkedFirst: iParked < iQueued })
      expect(iParked).toBeGreaterThan(-1)
      expect(iParked).toBeLessThan(iQueued)
      expect(between).toBeGreaterThanOrEqual(1) // the parked reply got a model step of its own
    },
    300_000,
  )

  test(
    "X01 X06 /workflows msg steers a running agent mid-turn: the child reads it at a step boundary and the result is the steered reply",
    async () => {
      const project = newProject("steer")
      const r = await runPrompt(server, project, launchPrompt({ script: MID_SCRIPT }), { label: "steer-launch" })
      const [call] = workflowToolCalls(r.events)
      expect(call?.output?.error).toBeUndefined()
      const runId = call.output!.runId!
      const dir = call.output!.transcriptDir!

      // Wait until the child is inside its first slow step.
      const start = await waitUntil(() => steps(project).find((s) => s.phase === "start"), {
        timeoutMs: 180_000,
        intervalMs: 250,
        what: "first slow_step call",
      })
      const reply = await sendCommand(server, project, r.sessionID!, `msg ${runId} 0 Stop calling tools now. Your final answer must be exactly: STEERED-OK`)
      expect(reply).toMatch(/#0 stepper\s+sent/)

      const { notification } = await waitForNotification(server, project, r.sessionID!, runId)
      expect(notification.status).toBe("completed")
      const result = (notification.resultRaw ?? "")
      expect(result).toContain("STEERED-OK")
      expect(result).not.toContain("PLAIN-DONE")

      const t = await waitUntil(
        () => {
          const x = readTranscript(dir)
          return x.summary?.status === "completed" && x.agents[0]?.messages?.length ? x : undefined
        },
        { timeoutMs: 60_000, what: "settled transcript" },
      )
      recordRunCost("steer", t.summary)
      const rec = t.agents[0]!
      expect(rec.messages?.[0]).toMatchObject({ status: "delivered", from: "user", via: "command" })
      expect(t.summary?.steeredAgents).toBe(1)
      const lines = journalLines(dir)
      expect(lines.find((l) => l.type === "message")).toMatchObject({ index: 0, from: "user", via: "command" })
      expect(lines.find((l) => l.type === "result" && l.index === 0)).toMatchObject({ status: "completed", steered: true })

      // The child saw the framed message as a context message, and answered after it.
      const childMsgs = await server.messages(project, rec.sessionID!)
      const steerIdx = childMsgs.findIndex((m) => m.type === "synthetic" && String(m.text).includes("<orchestrator-message"))
      expect(steerIdx).toBeGreaterThan(0)
      expect(assistantTexts(childMsgs.slice(steerIdx)).join("\n")).toContain("STEERED-OK")
      const calls = steps(project).filter((s) => s.phase === "start" && s.sessionID === rec.sessionID).length
      recordCost("steer", { kind: "note", slowStepCalls: calls, firstStepAt: start.t })
      expect(calls).toBeLessThan(4) // it changed course before finishing the original plan

      first = { project, parent: r.sessionID!, runId, dir, childID: rec.sessionID! }
    },
    600_000,
  )

  test(
    "X06 P41 resuming a run whose agent was steered runs that agent live again (never from cache)",
    async () => {
      expect(first).toBeDefined()
      const { project, parent, runId } = first!
      // Let the parent answer the first notification before prompting it again.
      const msgs = await server.messages(project, parent)
      const n1 = msgs.find((m) => m.type === "synthetic" && m.metadata?.workflowRunId === runId)
      await waitForAssistantAfter(server, project, parent, n1?.time?.created ?? 0)

      const r = await runPrompt(server, project, launchPrompt({ script: MID_SCRIPT, resumeFromRunId: runId }), {
        session: parent,
        label: "steer-resume",
      })
      const [call] = workflowToolCalls(r.events)
      expect(call?.output?.error).toBeUndefined()
      const run2 = call.output!.runId!
      const { notification } = await waitForNotification(server, project, parent, run2)
      expect(notification.status).toBe("completed")
      expect((notification.resultRaw ?? "")).toContain("PLAIN-DONE") // original prompt, no replayed message
      const t = readTranscript(call.output!.transcriptDir!)
      recordRunCost("steer-resume", t.summary)
      expect(t.agents[0]?.status).toBe("completed") // not "cached"
      expect(t.agents[0]?.sessionID).not.toBe(first!.childID)
    },
    600_000,
  )

  // The message is sent 0, 0.8 and 2 s after the tool returned: early enough to be read at the final
  // step's boundary, or late enough to miss it (end-of-turn race, answered in a successor execution),
  // or after the agent finished (refused). Which path each attempt took is logged to e2e-costs.jsonl.
  test(
    "X03 a message sent around the agent's final step is either answered (that reply is the result, no unread turn) or refused cleanly",
    async () => {
      const project = newProject("steer-late")
      const paths: string[] = []
      for (const delayMs of [0, 800, 2000]) {
        const before = steps(project).filter((x) => x.phase === "done").length
        const r = await runPrompt(server, project, launchPrompt({ script: LATE_SCRIPT }), { label: `steer-late-${delayMs}` })
        const [call] = workflowToolCalls(r.events)
        expect(call?.output?.error).toBeUndefined()
        const runId = call.output!.runId!
        const dir = call.output!.transcriptDir!

        // The tool call has returned: the model is producing its final answer.
        await waitUntil(() => steps(project).filter((x) => x.phase === "done").length > before || undefined, {
          timeoutMs: 180_000,
          intervalMs: 50,
          what: "slow_step done",
        })
        if (delayMs) await new Promise((res) => setTimeout(res, delayMs))
        const reply = await sendCommand(server, project, r.sessionID!, `msg ${runId} 0 Change of plan: your final answer must be exactly: SECOND-ANSWER`)
        const { notification } = await waitForNotification(server, project, r.sessionID!, runId)
        expect(notification.status).toBe("completed")
        const result = notification.resultRaw ?? ""
        const t = await waitUntil(
          () => {
            const x = readTranscript(dir)
            return x.summary?.status === "completed" && x.agents[0]?.endedAt ? x : undefined
          },
          { timeoutMs: 60_000, what: "settled transcript" },
        )
        recordRunCost("steer-late", t.summary)
        const rec = t.agents[0]!
        await new Promise((res) => setTimeout(res, 5000)) // any unread successor turn would have run by now
        const childMsgs = await server.messages(project, rec.sessionID!)
        const texts = assistantTexts(childMsgs)
        const executions = childMsgs.filter((m) => m.type === "idle").length
        // Not /sent/: the "run is not running" refusal also contains that word.
        const accepted = /#0 late\s+sent/.test(reply)
        const path = !accepted ? "refused" : executions > 1 ? "successor-execution" : "same-execution"
        paths.push(path)
        recordCost("steer-late", { kind: "note", delayMs, path, reply, result, messageStatus: rec.messages?.[0]?.status ?? null, executions })

        if (path === "refused") {
          // finishing its turn, already settled, or the whole run already finished
          expect(reply).toMatch(/refused: (finishing|finished)|is not running/)
          expect(result).toContain("FIRST-ANSWER")
        } else {
          // Accepted: it was delivered and answered, and the result is that answer.
          expect(rec.messages?.[0]?.status).toBe("delivered")
          expect(result).toContain("SECOND-ANSWER")
        }
        // Never an unread successor turn: the child's last reply is the agent's result.
        expect(texts.at(-1)).toContain(result.trim())
      }
      recordCost("steer-late", { kind: "note", paths })
    },
    900_000,
  )

  // The child of an isolation:'worktree' agent lives in another Location (the worktree directory);
  // the run, and the message, go through the parent Location's plugin instance.
  test(
    "X01 a worktree agent (child session in another Location) can be steered too",
    async () => {
      const project = newProject("steer-wt")
      const script = MID_SCRIPT.replace('{ label: "stepper" }', '{ label: "stepper", isolation: "worktree" }').replace("e2e-steer", "e2e-steer-wt")
      const r = await runPrompt(server, project, launchPrompt({ script }), { label: "steer-wt" })
      const [call] = workflowToolCalls(r.events)
      expect(call?.output?.error).toBeUndefined()
      const runId = call.output!.runId!
      const dir = call.output!.transcriptDir!
      await waitUntil(() => steps(project).find((x) => x.phase === "start"), { timeoutMs: 180_000, intervalMs: 250, what: "first slow_step call" })
      const reply = await sendCommand(server, project, r.sessionID!, `msg ${runId} 0 Stop calling tools now. Your final answer must be exactly: STEERED-OK`)
      recordCost("steer-wt", { kind: "note", reply })
      expect(reply).toMatch(/#0 stepper\s+sent/)
      const { notification } = await waitForNotification(server, project, r.sessionID!, runId)
      expect(notification.status).toBe("completed")
      const t = await waitUntil(
        () => {
          const x = readTranscript(dir)
          return x.summary?.status === "completed" && x.agents[0]?.endedAt ? x : undefined
        },
        { timeoutMs: 60_000, what: "settled transcript" },
      )
      recordRunCost("steer-wt", t.summary)
      recordCost("steer-wt", { kind: "note", result: notification.resultRaw, messageStatus: t.agents[0]?.messages?.[0]?.status ?? null })
      expect(notification.resultRaw ?? "").toContain("STEERED-OK")
      expect(t.agents[0]?.messages?.[0]?.status).toBe("delivered")
    },
    600_000,
  )
})
