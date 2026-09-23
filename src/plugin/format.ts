// Text rendering for the plugin: the task notification delivered to the parent session when a run
// finishes (P06), and the /workflows list / status views (P50, degraded to plain text). The views
// also show each phase's model label (X10) and, for running agents, the live activity overlay (X11).

import { totalTokens, type AgentRecord, type MessageReport, type PhaseSummary, type RunSummary } from "../types.ts"

/** "0.9s", "42.0s", "1m05s", "1h02m". */
export function formatDuration(ms: number): string {
  const safe = Math.max(0, ms)
  if (safe < 60_000) return `${(safe / 1000).toFixed(1)}s`
  const totalSec = Math.floor(safe / 1000)
  if (totalSec < 3600) {
    const m = Math.floor(totalSec / 60)
    const s = totalSec % 60
    return `${m}m${String(s).padStart(2, "0")}s`
  }
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  return `${h}h${String(m).padStart(2, "0")}m`
}

/** 0.4213 → "$0.42", 0.0042 → "$0.0042". */
export function formatCost(n: number): string {
  if (!(n > 0)) return "$0"
  return "$" + (n >= 0.01 ? n.toFixed(2) : n.toFixed(4))
}

/** 950 → "950", 12_345 → "12.3k", 2_500_000 → "2.5M". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

function elapsed(s: RunSummary, now: number): number {
  return (s.endedAt ?? now) - s.startedAt
}

function resultText(value: unknown): string {
  if (value === undefined) return "undefined"
  if (typeof value === "string") return value
  return JSON.stringify(value, null, 2)
}

/**
 * The completion message injected into the parent session (P06). Mirrors Claude Code's
 * `<task-notification>` block; `<run-id>`, `<script-path>` and `<transcript-dir>` are extra so the
 * model can relaunch with `resumeFromRunId` / `scriptPath`.
 */
export function formatTaskNotification(s: RunSummary, now: number = Date.now()): string {
  const verb = s.status === "completed" ? "completed" : s.status === "stopped" ? "was stopped" : "failed"
  let result: string
  if (s.status === "completed") result = resultText(s.result)
  else if (s.status === "stopped")
    result =
      "The run was stopped before it finished; there is no result. Completed agents are journaled: relaunch with " +
      `resumeFromRunId "${s.runId}" (same script or its scriptPath) to reuse them.`
  else
    result =
      `Error: ${s.error ?? "unknown error"}\nFix the script at scriptPath and relaunch; pass resumeFromRunId ` +
      `"${s.runId}" to reuse completed agents.`
  const lines = [
    "<task-notification>",
    `<task-id>${s.taskId}</task-id>`,
    `<run-id>${s.runId}</run-id>`,
    `<status>${s.status === "paused" || s.status === "running" ? "stopped" : s.status}</status>`,
    `<summary>Dynamic workflow "${s.description}" ${verb}</summary>`,
    `<result>${result}</result>`,
    `<usage>agent_count: ${s.agentCount}\ntokens: ${totalTokens(s.usage)}\nduration_ms: ${elapsed(s, now)}</usage>`,
  ]
  if (s.warnings.length) lines.push(`<warnings>${s.warnings.join("\n")}</warnings>`)
  // X06: the result reflects mid-run instructions that the script does not contain.
  if (s.steeredAgents) {
    const n = s.steeredAgents
    lines.push(
      `<steering>${n} agent${n === 1 ? "" : "s"} received messages during the run (see /workflows ${s.runId}). ` +
        "Their results reflect those messages, which the script does not contain and a resume does not replay.</steering>",
    )
  }
  if (s.scriptPath) lines.push(`<script-path>${s.scriptPath}</script-path>`)
  if (s.transcriptDir) lines.push(`<transcript-dir>${s.transcriptDir}</transcript-dir>`)
  lines.push("</task-notification>")
  return lines.join("\n")
}

/** Told to the model instead of a result it must not read from a status call (P77). */
export const AWAIT_NOTIFICATION =
  "The result is delivered to this session as a task notification — end your turn now; do not poll, sleep, or run shell commands to wait."

/**
 * The P77 note that replaces the result in every model-facing status. A running/paused run: end the
 * turn. A finished run: the notification carries the result (whether the model has read it cannot be
 * known here: session.synthetic resolving only means it entered the inbox), and run.json keeps it.
 */
export function awaitNotificationNote(s: Pick<RunSummary, "status" | "transcriptDir">): string {
  if (s.status === "running") return `Still running. ${AWAIT_NOTIFICATION}`
  if (s.status === "paused") return `Paused (still running). ${AWAIT_NOTIFICATION}`
  const file = s.transcriptDir ? `${s.transcriptDir.replace(/[\\/]+$/, "")}/run.json` : "run.json in the transcript directory"
  return (
    "Finished. Its result is not shown here: it is delivered to this session as a task notification. " +
    "If you have not received it yet, end your turn now; do not poll, sleep, or run shell commands to wait. " +
    `The full result is also stored in ${file} (field "result").`
  )
}

function isActive(s: Pick<RunSummary, "status">): boolean {
  return s.status === "running" || s.status === "paused"
}

const STATUS_ICON: Record<string, string> = {
  running: "●",
  paused: "‖",
  completed: "✓",
  failed: "✗",
  stopped: "■",
}

/** One run as a block of lines: header + per-phase counts (with the phase's model label, X10). */
function phaseLine(p: PhaseSummary): string {
  const time = p.elapsedMs !== undefined ? `  ${formatDuration(p.elapsedMs)}` : ""
  const label = p.model ?? p.agentModel
  const model = label ? ` (${label})` : ""
  const running = p.running ? `  ${p.running} running` : ""
  return `    ${p.title}${model}  ${p.done}/${p.agents}${running}  ${formatTokens(p.tokens)} tokens${time}`
}

/** `openai/gpt-5.4-mini` of `openai/gpt-5.4-mini#high` (live step events carry no variant). */
export function modelBase(model: string): string {
  const i = model.indexOf("#")
  return i < 0 ? model : model.slice(0, i)
}

/**
 * The model to show for an agent (X19): the recorded one (with its variant), unless its live step runs
 * on another model (an opencode fallback not yet recorded), then that one; else `fallback`.
 */
export function shownModel(recorded: string | null | undefined, live: string | null | undefined, fallback: string | null = null): string | null {
  if (live && (!recorded || modelBase(recorded) !== live)) return live
  return recorded || fallback
}

/** What a running agent is doing right now (X11): the live overlay from the activity tap. */
export interface LiveActivity {
  kind: "tool" | "text" | "reasoning" | "waiting"
  text: string
  at: number
  tokens: number
  cost: number
  model: string | null
}

/**
 * "» bash npm test", '“The main risk…”', "thinking…", "waiting for the model". Narrow glyphs only:
 * emoji-capable ones (⚙ ✎ ✉) render double-width in some terminals (Windows conhost) and shift the line.
 */
export function activityText(a: Pick<LiveActivity, "kind" | "text">): string {
  if (a.kind === "text") return a.text ? `“${a.text}”` : "writing…"
  if (a.kind === "reasoning") return a.text ? `thinking: ${a.text}` : "thinking…"
  if (a.kind === "waiting") return "waiting for the model"
  return `» ${a.text}`
}

export function formatRunLine(s: RunSummary, now: number = Date.now()): string {
  const icon = STATUS_ICON[s.status] ?? "?"
  const lines = [
    `${icon} ${s.workflowName}  ${s.runId}  ${s.status}  ${formatDuration(elapsed(s, now))}  ` +
      `agents ${s.agentCount}  tokens ${formatTokens(totalTokens(s.usage))}${s.usage.cost > 0 ? `  ${formatCost(s.usage.cost)}` : ""}`,
  ]
  if (s.description) lines.push(`    ${s.description}`)
  if (s.steeredAgents) lines.push(`    ✉ ${s.steeredAgents} agent${s.steeredAgents === 1 ? "" : "s"} steered`)
  // A meta.phases entry that ended with 0 agents is only noise once the run is over (P50).
  for (const p of s.phases) if (isActive(s) || p.agents > 0) lines.push(phaseLine(p))
  // Agents outside every phase group (P50). Older run.json files have no `ungrouped` field.
  if (s.ungrouped?.agents) lines.push(phaseLine(s.ungrouped))
  else if (!s.ungrouped && !s.phases.length && s.agentCount) lines.push(`    (no phase)  ${s.agentCount} agents`)
  for (const w of s.warnings) lines.push(`    ! ${w}`)
  if (s.error) lines.push(`    error: ${firstLine(s.error)}`)
  return lines.join("\n")
}

/** /workflows list view (P50). Running runs first, then finished ones newest first. */
export function formatRunList(runs: RunSummary[], now: number = Date.now()): string {
  if (!runs.length) return "No workflow runs in this session."
  const active = runs.filter((r) => r.status === "running" || r.status === "paused")
  const done = runs.filter((r) => !(r.status === "running" || r.status === "paused"))
  const out: string[] = [`Workflow runs (${runs.length}; ${active.length} active)`]
  for (const r of [...active, ...done]) out.push(formatRunLine(r, now))
  out.push(
    "",
    "Details: /workflows <runId>. Message a running agent: /workflows msg <runId> <#n|@phase|*|label> <text>. " +
      "Manage runs with the workflow_control tool (stop, stop_agent, pause, resume, message, save).",
  )
  return out.join("\n")
}

/**
 * Detailed status of one run (P50): header, phases, every agent, recent logs, result/error. The
 * model-facing view (`forModel`, workflow_control) never carries the run's result or per-agent
 * result previews (P77): the task notification is the single delivery path, so a note replaces them.
 */
export function formatRunStatus(
  s: RunSummary,
  agents: AgentRecord[],
  now: number = Date.now(),
  opts: { forModel?: boolean; activity?: Map<number, LiveActivity> } = {},
): string {
  const out: string[] = [formatRunLine(s, now)]
  out.push(`    script: ${s.scriptPath}`, `    transcript: ${s.transcriptDir}`)
  if (s.steeredAgents) {
    out.push(
      "    Steered agents are not reused on resume: they and every later agent run again with their original prompts " +
        "(messages are not replayed). Edit the script to make a change stick.",
    )
  }
  if (s.error) out.push(`    error: ${firstLine(s.error)}`)
  for (const w of s.warnings ?? []) out.push(`    ! ${w}`)
  if (agents.length) {
    out.push("", "Agents:")
    for (const a of agents) {
      const dur = a.startedAt !== undefined ? `  ${formatDuration((a.endedAt ?? now) - a.startedAt)}` : ""
      // X11: a running agent's live overlay (display only; the record keeps the settled usage).
      const live = a.status === "running" ? opts.activity?.get(a.index) : undefined
      const tokens = Math.max(totalTokens(a.usage), live?.tokens ?? 0)
      let line = `  #${a.index} ${a.label}  ${a.status}${a.phase ? `  [${a.phase}]` : ""}  ${formatTokens(tokens)} tokens${dur}`
      if (a.sessionID) line += `  ${a.sessionID}`
      out.push(line)
      const model = shownModel(a.model, live?.model)
      if (model) out.push(`      model: ${model}`)
      out.push(`      prompt: ${clip(firstLine(a.prompt), 200)}`)
      if (live) {
        const ago = `  (${formatDuration(now - live.at)} ago)`
        const cost = live.cost > 0 ? ` · ${formatCost(live.cost)}` : ""
        out.push(`      now: ${activityText(live)}${ago}${cost}`)
      }
      if (a.result !== undefined && !opts.forModel) out.push(`      result: ${clip(firstLine(resultText(a.result)), 200)}`)
      if (a.error) out.push(`      error: ${firstLine(a.error)}`)
      if (a.worktree) out.push(`      worktree kept: ${a.worktree}`)
      if (a.messages?.length) {
        const counts = new Map<string, number>()
        for (const m of a.messages) counts.set(m.status, (counts.get(m.status) ?? 0) + 1)
        out.push(`      messages: ${[...counts].map(([k, n]) => `${n} ${k}`).join(", ")}`)
        for (const m of a.messages.slice(-3)) {
          out.push(`      ✉ ${m.id} ${m.from}${m.urgent ? " (urgent)" : ""} [${m.status}]: ${clip(firstLine(m.text), 120)}`)
        }
      }
      for (const w of a.warnings ?? []) out.push(`      ! ${w}`)
    }
  }
  if (s.logs.length) {
    out.push("", "Log:")
    for (const l of s.logs.slice(-20)) out.push(`  ${l}`)
  }
  if (opts.forModel) {
    // P77: the task notification is the only path that delivers the result to the model.
    out.push("", awaitNotificationNote(s))
  } else if (s.status === "completed" && s.result !== undefined) {
    const text = resultText(s.result)
    out.push("", "Result:", text.length > 2000 ? `${text.slice(0, 2000)}…` : text)
  }
  return out.join("\n")
}

const REFUSAL_TEXT: Record<string, string> = {
  finishing: "it is finishing its turn; try again in a moment, or stop it",
  submitted: "it already submitted its structured result; a message can no longer change it",
}

/** Reply to a steering request (X01–X08): one line per targeted agent. */
export function formatMessageReports(runId: string, reports: MessageReport[], opts: { urgent?: boolean; forModel?: boolean } = {}): string {
  const out = [`Message to run ${runId}:`]
  for (const r of reports) {
    let what: string
    if (r.outcome === "sent") what = `sent${opts.urgent ? " (urgent: its current step is interrupted)" : ""} (${r.messageId})`
    else if (r.outcome === "held") what = `held (queued: added to its first prompt) (${r.messageId})`
    else {
      const detail = r.detail ?? (r.reason ? REFUSAL_TEXT[r.reason] : undefined)
      what = `refused: ${r.reason ?? "unknown"}${detail ? ` (${detail})` : ""}`
    }
    out.push(`  #${r.index} ${r.label}  ${what}`)
  }
  if (reports.some((r) => r.outcome !== "refused")) {
    const when = reports.some((r) => r.outcome === "sent") && opts.urgent
      ? "It reads the message now; the interrupted step's tokens are not counted in its usage."
      : "A running agent reads the message at its next step boundary (after its current step and tool calls finish)."
    out.push(`${when} Steered agents are not reused on resume.`)
    if (opts.forModel) out.push(`Its effect shows up in the run's result. ${AWAIT_NOTIFICATION}`)
  }
  return out.join("\n")
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

function firstLine(s: string): string {
  const i = s.indexOf("\n")
  return i < 0 ? s : `${s.slice(0, i)} …`
}
