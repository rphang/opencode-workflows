// Live demo: a natural-language request; the parent model writes the workflow script itself.
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { createProject, startServer, waitForPlugin, runPrompt, waitForNotification, waitForAssistantAfter, assistantText, launchTurnText, requireLaunch, workflowToolCalls, readTranscript, REPO, SANDBOX } from "../tests/e2e/harness.ts"

const project = createProject("demo", {
  "src/cart.ts": `export function total(items: { price: number; qty: number }[]) {\n  let sum = 0\n  for (let i = 0; i <= items.length; i++) sum += items[i].price * items[i].qty\n  return sum\n}\n`,
  "src/user.ts": `export async function loadUser(id: string) {\n  const res = await fetch("/api/users/" + id)\n  const data = res.json()\n  return data.name.toUpperCase()\n}\n`,
  "src/date.ts": `export function isWeekend(d: Date) {\n  const day = d.getDay()\n  return day === 6 || day === 7\n}\n`,
})
const server = await startServer({ label: "demo" })
const out: string[] = []
// The committed transcript must not leak local paths: replace the sandbox project and data dirs
// (raw and JSON-escaped) with <project> / <data-dir> placeholders.
const scrub = (s: string) => {
  for (const [dir, label] of [[project.dir, "<project>"], [join(SANDBOX, "e2e-data"), "<data-dir>"]]) {
    for (const form of [dir, JSON.stringify(dir).slice(1, -1)]) s = s.split(form).join(label)
  }
  return s
}
const say = (s: string) => { console.log(s); out.push(scrub(s)) }
let ok = false
try {
  await waitForPlugin(server, project)
  const prompt = "use a workflow to audit every file under src/ for bugs: one agent per file returning structured findings, then adversarially verify each finding with an independent skeptic, and report only the confirmed bugs as a short table."
  say(`## USER\n${prompt}\n`)
  const t0 = Date.now()
  const r = await runPrompt(server, project, prompt, { label: "demo", timeoutMs: 300_000 })
  const calls = workflowToolCalls(r.events)
  if (!calls.length) say(`## ASSISTANT (launch turn, no workflow call)\n${launchTurnText(r)}\n`)
  // Fail fast (no 10-minute notification wait) when the parent did not launch a workflow.
  const call = requireLaunch(calls)
  say(`## ASSISTANT → tool call: workflow\n\`\`\`js\n${call.input?.script ?? JSON.stringify(call.input, null, 2)}\n\`\`\`\n`)
  say(`## TOOL RESULT (returned immediately)\n\`\`\`json\n${JSON.stringify(call.output, null, 2)}\n\`\`\`\n`)
  say(`## ASSISTANT (end of launch turn)\n${launchTurnText(r)}\n`)
  const runId = call.output.runId
  const { message } = await waitForNotification(server, project, r.sessionID!, (m) => String(m.text ?? "").includes(runId), 600_000)
  say(`## SYNTHETIC <task-notification> (wakes the session)\n\`\`\`xml\n${message.text}\n\`\`\`\n`)
  const reply = await waitForAssistantAfter(server, project, r.sessionID!, message.time?.created ?? t0, 180_000)
  say(`## ASSISTANT (after notification)\n${assistantText(reply)}\n`)
  const tr = readTranscript(call.output.transcriptDir!)
  say(`## /workflows-style status (run.json)\n\`\`\`json\n${JSON.stringify({ status: tr.summary?.status, agentCount: tr.summary?.agentCount, phases: tr.summary?.phases, usage: tr.summary?.usage, logs: tr.summary?.logs }, null, 2)}\n\`\`\`\n`)
  say(`transcriptDir: ${call.output.transcriptDir}\nsession: ${r.sessionID}\nproject: ${project.dir}\nwall: ${Math.round((Date.now() - t0) / 1000)}s`)
  // Unscrubbed local details (server URL, paths) stay in the git-ignored sandbox.
  writeFileSync(join(SANDBOX, "demo-session-info.json"), JSON.stringify({ url: server.url, project: project.dir, session: r.sessionID, runId, transcriptDir: call.output.transcriptDir }, null, 2))
  ok = true
} finally {
  // A failed demo must not overwrite the last good transcript.
  writeFileSync(ok ? join(REPO, "demo", "DEMO-OUTPUT.md") : join(REPO, ".sandbox", "DEMO-OUTPUT.failed.md"), out.join("\n"))
  if (!process.env.KEEP_SERVER) await server.stop()
}
