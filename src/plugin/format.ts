// Text rendering for the plugin: the task notification delivered to the parent session when a run
// finishes (P06), and the /workflows list / status views (P50, degraded to plain text).

import { totalTokens, type AgentRecord, type PhaseSummary, type RunSummary } from "../types.ts"

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

/** One run as a block of lines: header + per-phase counts. */
function phaseLine(p: PhaseSummary): string {
  const time = p.elapsedMs !== undefined ? `  ${formatDuration(p.elapsedMs)}` : ""
  return `    ${p.title}  ${p.done}/${p.agents}  ${formatTokens(p.tokens)} tokens${time}`
}

export function formatRunLine(s: RunSummary, now: number = Date.now()): string {
  const icon = STATUS_ICON[s.status] ?? "?"
  const lines = [
    `${icon} ${s.workflowName}  ${s.runId}  ${s.status}  ${formatDuration(elapsed(s, now))}  ` +
      `agents ${s.agentCount}  tokens ${formatTokens(totalTokens(s.usage))}`,
  ]
  if (s.description) lines.push(`    ${s.description}`)
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
  out.push("", "Details: /workflows <runId>. Manage runs with the workflow_control tool (stop, stop_agent, pause, resume, save).")
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
  opts: { forModel?: boolean } = {},
): string {
  const out: string[] = [formatRunLine(s, now)]
  out.push(`    script: ${s.scriptPath}`, `    transcript: ${s.transcriptDir}`)
  if (s.error) out.push(`    error: ${firstLine(s.error)}`)
  for (const w of s.warnings ?? []) out.push(`    ! ${w}`)
  if (agents.length) {
    out.push("", "Agents:")
    for (const a of agents) {
      const dur = a.startedAt !== undefined ? `  ${formatDuration((a.endedAt ?? now) - a.startedAt)}` : ""
      let line = `  #${a.index} ${a.label}  ${a.status}${a.phase ? `  [${a.phase}]` : ""}  ${formatTokens(totalTokens(a.usage))} tokens${dur}`
      if (a.sessionID) line += `  ${a.sessionID}`
      out.push(line)
      out.push(`      prompt: ${clip(firstLine(a.prompt), 200)}`)
      if (a.result !== undefined && !opts.forModel) out.push(`      result: ${clip(firstLine(resultText(a.result)), 200)}`)
      if (a.error) out.push(`      error: ${firstLine(a.error)}`)
      if (a.worktree) out.push(`      worktree kept: ${a.worktree}`)
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

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

function firstLine(s: string): string {
  const i = s.indexOf("\n")
  return i < 0 ? s : `${s.slice(0, i)} …`
}
