// Plugin-side run management: launching runs from `workflow` tool input (P01–P05, P41–P43),
// delivering the completion notification (P06), and the management actions behind
// `workflow_control` and `/workflows` (P50–P52), steering a running agent (X01–X08), and the
// snapshots and user actions behind the live progress tree's RPC (X10–X13).

import { realpathSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path"
import { evaluatePermission, type PermissionRule } from "../opencode/permissions.ts"
import {
  getActiveRun,
  isRunActive,
  startRun,
  type ResolvedWorkflow as EngineWorkflow,
  type WorkflowEvent,
  type WorkflowRef,
  type WorkflowRun,
} from "../engine.ts"
import { loadForResume, type ReplayCursor } from "../journal.ts"
import { extractMetaLoose, parseScript } from "../meta.ts"
import { listWorkflows, personalWorkflowsDir, resolveWorkflow, saveWorkflow, type RegistryOptions } from "../registry.ts"
import { checkBodySyntax } from "../sandbox.ts"
import { RunStore, sanitizeSessionKey } from "../store.ts"
import { MAX_MESSAGE_CHARS, type MessageFrom, type MessageVia } from "../mailbox.ts"
import type { AgentRecord, AgentRunner, Json, MessageTarget, RunSummary, WorkflowInput, WorkflowOutput } from "../types.ts"
import {
  AWAIT_NOTIFICATION,
  awaitNotificationNote,
  formatAgentDetail,
  formatAgentList,
  formatMessageReports,
  formatRunList,
  formatRunStatus,
  formatTaskNotification,
  REPEAT_NOTE,
  type LiveActivity,
} from "./format.ts"

/** Tool input: Claude Code's WorkflowInput plus the non-CC `budget` extension (budget.total). */
export interface WorkflowToolInput extends WorkflowInput {
  budget?: number
}

export interface ControlInput {
  action: "list" | "status" | "stop" | "stop_agent" | "pause" | "resume" | "message" | "save" | "result"
  runId?: string
  agentIndex?: number
  name?: string
  location?: "project" | "personal"
  /** message: target by exact label, by phase title, or every running/queued agent (X05). */
  label?: string
  phase?: string
  all?: boolean
  /** message: the instruction (1..MAX_MESSAGE_CHARS characters). */
  text?: string
  /** message: also interrupt the agent's current step (X08). */
  urgent?: boolean
  /** result: one agent, by index ("3" or "#3") or exact label; omitted or "" lists them all (X21). */
  agent?: string
  /** result: where the next page starts: a row of the list, or a character of one agent's value (X21). */
  offset?: number
}

/** One steering request, from any surface (tool, command, TUI). */
export interface MessageRequest {
  runId: string
  target?: MessageTarget
  text?: unknown
  urgent?: boolean
  from: MessageFrom
  via: MessageVia
}

export interface NotifyInput {
  sessionID: string
  text: string
  description?: string
  metadata?: Record<string, Json>
  delivery?: "steer" | "queue"
  resume?: boolean
}

export interface HostOptions {
  /** Project directory: relative scriptPaths and saved-workflow discovery start here. */
  cwd: string
  store: RunStore
  registryOptions?: RegistryOptions
  /** Builds the AgentRunner for one run. */
  createRunner: (input: { parentSessionID: string; parentAgent?: string; runId: string }) => AgentRunner
  /** Delivers a synthetic message to a session (ctx.session.synthetic). */
  notify: (input: NotifyInput) => Promise<unknown>
  /** Called after a workflow is saved, so /<name> commands refresh (ctx.command.reload). */
  onSaved?: () => Promise<void> | void
  now?: () => number
  summaryThrottleMs?: number
  /** Large-workflow warning threshold (P55; the chosen size guideline, P70). Default 25. */
  largeWorkflowThreshold?: number
  /**
   * Touches the parent session so opencode keeps its location loaded while a run is active
   * (ctx.session.update with the unchanged title → a durable Session.Renamed event). opencode evicts a
   * location, and with it this plugin and its runs, after 60 min without session events there; a
   * paused run or one whose live agents all run in worktrees (other locations) produces none.
   */
  keepAlive?: (sessionID: string) => Promise<unknown>
  /** Keep-alive period (default KEEP_ALIVE_MS; 0 disables). */
  keepAliveMs?: number
  /** Extra directories treated as inside the project for scriptPath reads (the project root). */
  projectRoots?: string[]
  /**
   * The permission rules in force for the calling session running `agent` (agent rules, then session
   * rules). scriptPath reads are checked against their `read`/`external_directory` rules (P76).
   * Default: no rules, so only paths inside the project / run store / saved-workflow dirs are read.
   */
  permissionRules?: (sessionID: string, agent?: string) => Promise<PermissionRule[]>
  /** Receives every engine event of every run this host starts (the live tree, X12/X13). */
  onEvent?: (event: WorkflowEvent) => void
  /** Live activity of a run's running agents (X11), shown by the status views. */
  activity?: (runId: string) => Map<number, LiveActivity>
}

/** A run's summary and agent records, for the live views (X12). */
export interface RunSnapshot {
  summary: RunSummary
  /** Absent for runs listed from run.json only (runSnapshot() reads their agents). */
  agents?: AgentRecord[]
}

/** What the live tree's RPC `control` accepts (X12): a user action, not session-scoped. */
export interface UserControlInput {
  runId?: string
  action?: string
  agentIndex?: number
  label?: string
  phase?: string
  all?: boolean
  text?: string
  urgent?: boolean
}

export interface ActionResult {
  ok: boolean
  message: string
}

/** Runs kept in memory after they settle, for the live views of this instance (X12). */
const RECENT_FINISHED = 20

/** Recorded on runs stopped because the plugin instance was disposed (see WorkflowHost.dispose). */
export const DISPOSE_STOP_REASON =
  "stopped because the workflow plugin was unloaded (opencode shut down, reloaded its plugins, or unloaded this directory)"

/** Well under opencode's 60-minute idle-location eviction (core/src/location-activity.ts). */
export const KEEP_ALIVE_MS = 20 * 60_000

/** Delivery mode for the completion notification (queued behind the parent's current turn). */
export const NOTIFY_DELIVERY = "queue" as const

/** Launch output summary (P02, P77): the model must end its turn and wait for the notification. */
export function launchSummary(name: string, description: string, runId: string, scriptPath: string | undefined): string {
  return (
    `Workflow "${name}" (${description}) launched in the background as run ${runId}. ` +
    "Its result arrives in this session as a task notification when it finishes. END YOUR TURN NOW: tell the user " +
    "it started and stop. Never call workflow_control status, sleep, or run shell commands to wait for completion " +
    "(status is only for when the user asks about progress). " +
    `To iterate later, edit ${scriptPath} and relaunch with scriptPath (plus resumeFromRunId "${runId}" to reuse completed agents).`
  )
}

const CONTROL_RUN_ACTIONS = ["status", "stop", "stop_agent", "pause", "resume", "message", "save", "result"] as const
const USER_ACTIONS = ["stop", "stop_agent", "pause", "resume", "message"] as const
type UserAction = (typeof USER_ACTIONS)[number]
const ACTION_LIST = "list, status, stop, stop_agent, pause, resume, message, save or result"

function notInSession(runId: string): string {
  return `run ${runId} was not found in this session`
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * Canonical spelling of a path: symlinks, junctions, Windows 8.3 short names and macOS /var ->
 * /private/var resolved. A path that does not exist (yet) is canonicalized through its nearest
 * existing ancestor, so a missing file is still judged by where it would be.
 */
async function realpathOr(p: string): Promise<string> {
  const rest: string[] = []
  let cur = p
  for (;;) {
    try {
      return join(realpathSync.native(cur), ...rest)
    } catch {
      const parent = dirname(cur)
      if (parent === cur) return p
      rest.unshift(basename(cur))
      cur = parent
    }
  }
}

/** True when `child` is `parent` or inside it (case-insensitive on Windows). */
function contains(parent: string, child: string): boolean {
  const norm = (p: string) => (process.platform === "win32" ? resolvePath(p).toLowerCase() : resolvePath(p))
  const rel = relative(norm(parent), norm(child))
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && !rel.startsWith(sep))
}

function nonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== ""
}

export class WorkflowHost {
  private readonly runs = new Map<string, { run: WorkflowRun; sessionID: string; notified: Promise<void> }>()
  private readonly finished = new Map<string, RunSnapshot>()
  /** P77: model-facing progress calls per (session, run) since the run last changed state. */
  private readonly progressCalls = new Map<string, { status: string; calls: number }>()
  private disposed = false
  private keepAliveTimer: ReturnType<typeof setInterval> | undefined
  private readonly now: () => number

  constructor(private readonly opts: HostOptions) {
    this.now = opts.now ?? Date.now
  }

  get store(): RunStore {
    return this.opts.store
  }

  /** Runs started by this host that have not settled yet. */
  activeRuns(): WorkflowRun[] {
    return [...this.runs.values()].map((r) => r.run).filter((r) => isRunActive(r.runId))
  }

  // ---- launch ---------------------------------------------------------------------------------

  /** `caller.agent` is the parent's current agent (tool ctx.agent): children inherit it (P61). */
  async launch(input: WorkflowToolInput, sessionID: string, caller: { agent?: string } = {}): Promise<WorkflowOutput> {
    const store = this.opts.store
    const runId = store.newRunId()
    const taskId = `task_${runId.slice(3)}`
    const out: WorkflowOutput = { status: "async_launched", taskId, taskType: "local_workflow", runId }
    const fail = (error: string): WorkflowOutput => ({ ...out, error })
    input = input ?? {}
    // A turn that started before opencode reloaded the plugin can still hold this instance's tool. A
    // run started here would be an orphan: the live instance could not list, stop or steer it.
    if (this.disposed) {
      return fail("the workflow plugin was just reloaded (or is shutting down); call the workflow tool again to launch the run")
    }

    // 1. Resolve the source: scriptPath > script > name (P01).
    let source: string
    let givenPath: string | undefined
    if (nonEmpty(input.scriptPath)) {
      try {
        givenPath = await this.authorizeScriptPath(input.scriptPath, sessionID, caller.agent)
      } catch (e) {
        return fail(errMsg(e))
      }
      try {
        source = await readFile(givenPath, "utf8")
      } catch (e) {
        return fail(`cannot read scriptPath ${givenPath}: ${errMsg(e)}`)
      }
    } else if (nonEmpty(input.script)) {
      source = input.script
    } else if (nonEmpty(input.name)) {
      const found = resolveWorkflow(input.name, this.opts.cwd, this.opts.registryOptions)
      if (!found) {
        const known = listWorkflows(this.opts.cwd, this.opts.registryOptions).map((w) => w.meta.name)
        return fail(`unknown workflow "${input.name}". Available: ${known.length ? known.join(", ") : "(none)"}`)
      }
      source = found.source
    } else {
      return fail("the workflow tool needs one of script, name, or scriptPath")
    }

    const loose = extractMetaLoose(source)
    if (loose) out.workflowName = loose.name

    // 2. Persist the script (P04). A given scriptPath stays the path to iterate on; a copy is kept
    //    in the run dir as the run's record.
    try {
      const loc = await store.createRun(sessionID, runId)
      out.transcriptDir = loc.dir
      const copy = await store.writeScript(runId, source)
      out.scriptPath = givenPath ?? copy
    } catch (e) {
      return fail(`could not persist the script: ${errMsg(e)}`)
    }

    // 3. Static checks: meta + syntax + forbidden constructs (P03, P10–P14). Nothing runs on error.
    const parsed = parseScript(source)
    if (!parsed.ok) return fail(parsed.error)
    const bodyCheck = checkBodySyntax(parsed.body)
    if (!bodyCheck.ok) return fail(bodyCheck.error)
    out.workflowName = parsed.meta.name
    if (parsed.warnings.length) out.warning = parsed.warnings.join("\n")

    // 4. Resume (P41–P43): same session only; refuse while the old run's agents are alive.
    let resume: ReplayCursor | undefined
    if (nonEmpty(input.resumeFromRunId)) {
      const oldId = input.resumeFromRunId.trim()
      if (isRunActive(oldId)) {
        const old = getActiveRun(oldId)
        const hint =
          old && (old.status === "running" || old.status === "paused")
            ? `stop it first (workflow_control {action:"stop", runId:"${oldId}"})${old.status === "paused" ? ", or resume it in place with action \"resume\"" : ""}`
            : "wait until they have exited and try again"
        return fail(`cannot resume run ${oldId}: agents from that run are still running; ${hint}`)
      }
      const loc = await store.findRun(oldId)
      if (!loc || loc.sessionKey !== sanitizeSessionKey(sessionID)) {
        return fail(`nothing to resume: run ${oldId} was not found in this session. Start the workflow over as a new run (omit resumeFromRunId).`)
      }
      try {
        resume = (await loadForResume(store, oldId)).cursor
      } catch (e) {
        return fail(`${errMsg(e)}. Start the workflow over as a new run (omit resumeFromRunId).`)
      }
    }

    // 5. Start in the background and return immediately (P02).
    const budgetTotal = typeof input.budget === "number" && Number.isFinite(input.budget) && input.budget > 0 ? input.budget : null
    let run: WorkflowRun
    try {
      run = startRun({
        runId,
        taskId,
        sessionKey: sessionID,
        parentSessionID: sessionID,
        meta: parsed.meta,
        body: parsed.body,
        args: input.args,
        runner: this.opts.createRunner({ parentSessionID: sessionID, parentAgent: caller.agent, runId }),
        store,
        resume,
        budgetTotal,
        resolveWorkflow: (ref) => this.resolveNested(ref, sessionID, caller.agent),
        scriptPath: out.scriptPath,
        warnings: parsed.warnings,
        now: this.opts.now,
        summaryThrottleMs: this.opts.summaryThrottleMs,
        largeWorkflowThreshold: this.opts.largeWorkflowThreshold,
        onEvent: this.opts.onEvent,
        directory: this.opts.cwd,
      })
    } catch (e) {
      return fail(`could not start the run: ${errMsg(e)}`)
    }
    const notified = run.result().then((summary) => this.deliver(sessionID, summary, run.agents()))
    this.runs.set(runId, { run, sessionID, notified })
    this.startKeepAlive()
    void run.settled().finally(() => {
      this.rememberFinished({ summary: run.summary(), agents: run.agents() })
      if (this.runs.get(runId)?.run === run) this.runs.delete(runId)
      if (this.runs.size === 0) this.stopKeepAlive()
    })

    out.summary = launchSummary(parsed.meta.name, parsed.meta.description, runId, out.scriptPath)
    return out
  }

  /** workflow(nameOrRef) inside a script (P35): saved name or {scriptPath}; throws when unknown/invalid. */
  private async resolveNested(ref: WorkflowRef, sessionID: string, agent?: string): Promise<EngineWorkflow> {
    let source: string
    let label: string
    if (typeof ref === "string") {
      const found = resolveWorkflow(ref, this.opts.cwd, this.opts.registryOptions)
      if (!found) throw new Error(`unknown workflow "${ref}"`)
      source = found.source
      label = ref
    } else {
      const p = await this.authorizeScriptPath(ref.scriptPath, sessionID, agent)
      try {
        source = await readFile(p, "utf8")
      } catch (e) {
        throw new Error(`cannot read workflow script ${p}: ${errMsg(e)}`)
      }
      label = p
    }
    const parsed = parseScript(source)
    if (!parsed.ok) throw new Error(`workflow "${label}" has an invalid script: ${parsed.error}`)
    const syntax = checkBodySyntax(parsed.body)
    if (!syntax.ok) throw new Error(`workflow "${label}" has an invalid script: ${syntax.error}`)
    return { meta: parsed.meta, body: parsed.body }
  }

  /**
   * P76: resolves a scriptPath and checks it the way opencode's read tool would, before any read.
   * UNC and device paths are refused outright (opening one can reach a remote SMB host). A path whose
   * real location (symlinks resolved) is outside the project directory, this session's run store and
   * the personal workflows dir needs an `external_directory` allow rule for its directory; any path
   * whose `read` rule is deny is refused. Plugins cannot ask the user, so "ask" counts as refused.
   * Returns the absolute path as given (P04 keeps it; its real target is what was checked); throws with the reason otherwise.
   */
  private async authorizeScriptPath(given: string, sessionID: string, agent?: string): Promise<string> {
    const raw = given.trim()
    const isUnc = (p: string) => /^[\\/]{2}/.test(p)
    if (isUnc(raw)) throw new Error(`scriptPath ${raw} is a UNC or device path; only local files can be run`)
    const abs = isAbsolute(raw) ? resolvePath(raw) : resolvePath(this.opts.cwd, raw)
    if (isUnc(abs)) throw new Error(`scriptPath ${abs} is a UNC or device path; only local files can be run`)
    const real = await realpathOr(abs)
    if (isUnc(real)) throw new Error(`scriptPath ${raw} resolves to the UNC or device path ${real}; only local files can be run`)

    const roots = [this.opts.cwd, ...(this.opts.projectRoots ?? [])].filter((r) => r && dirname(r) !== r)
    let internalRoot: string | undefined
    for (const r of roots) {
      if (contains(await realpathOr(r), real)) {
        internalRoot = await realpathOr(r)
        break
      }
    }
    const trusted = [
      join(this.opts.store.root, sanitizeSessionKey(sessionID)),
      this.opts.registryOptions?.configHome
        ? join(this.opts.registryOptions.configHome, "opencode", "workflows")
        : personalWorkflowsDir(this.opts.registryOptions?.env ?? process.env, this.opts.registryOptions?.home),
    ]
    let isTrusted = false
    for (const t of trusted) if (contains(await realpathOr(t), real)) isTrusted = true

    let rules: PermissionRule[] = []
    try {
      rules = (await this.opts.permissionRules?.(sessionID, agent)) ?? []
    } catch {
      rules = []
    }
    const slash = (p: string) => p.replaceAll("\\", "/")
    // Rules are written with whatever spelling the user sees (8.3 short name, /var vs /private/var, a
    // junction). The spelling given here counts too, but only when its directory is the SAME real
    // directory: the file itself is never taken through a link to somewhere else.
    const givenDir = dirname(abs)
    const sameDir = contains(await realpathOr(givenDir), dirname(real)) && contains(dirname(real), await realpathOr(givenDir))
    const dirSpellings = sameDir && givenDir !== dirname(real) ? [dirname(real), givenDir] : [dirname(real)]
    const fileSpellings = dirSpellings.map((d) => join(d, basename(real)))
    if (!internalRoot && !isTrusted) {
      const allowed = dirSpellings.some((d) => evaluatePermission("external_directory", slash(join(d, "*")), rules) === "allow")
      if (!allowed) {
        throw new Error(
          `scriptPath ${raw} is outside the project directory (${this.opts.cwd}) and opencode's external_directory ` +
            `permission does not allow ${dirname(real)}. Copy the script into the project, or allow that directory.`,
        )
      }
    }
    const readResources = internalRoot ? [slash(relative(internalRoot, real) || ".")] : fileSpellings.map(slash)
    if (readResources.some((r) => evaluatePermission("read", r, rules) === "deny")) {
      throw new Error(`scriptPath ${raw} is denied by opencode's read permission`)
    }
    return abs
  }

  private async deliver(sessionID: string, summary: RunSummary, agents: AgentRecord[]): Promise<void> {
    try {
      await this.opts.notify({
        sessionID,
        text: formatTaskNotification(summary, this.now(), agents),
        description: `Workflow ${summary.workflowName} ${summary.status}`,
        metadata: { workflowRunId: summary.runId, workflowTaskId: summary.taskId, status: summary.status },
        delivery: NOTIFY_DELIVERY,
        resume: true,
      })
    } catch {
      // The parent session may be gone; the run's summary is on disk either way.
    }
  }

  // ---- location keep-alive ---------------------------------------------------------------------

  private startKeepAlive(): void {
    const ms = this.opts.keepAliveMs ?? KEEP_ALIVE_MS
    if (this.keepAliveTimer || this.disposed || !this.opts.keepAlive || !(ms > 0)) return
    this.keepAliveTimer = setInterval(() => void this.touchParents(), ms)
    ;(this.keepAliveTimer as any).unref?.()
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer)
    this.keepAliveTimer = undefined
  }

  /** One touch per parent session that has an active run. Best effort. */
  private async touchParents(): Promise<void> {
    const sessions = new Set<string>()
    for (const { run, sessionID } of this.runs.values()) if (isRunActive(run.runId)) sessions.add(sessionID)
    if (sessions.size === 0) return this.stopKeepAlive()
    await Promise.allSettled([...sessions].map((sid) => this.opts.keepAlive!(sid)))
  }

  // ---- management -----------------------------------------------------------------------------

  /** Runs of one session: live snapshots for active runs, run.json for the rest (newest first). */
  async listSessionRuns(sessionID: string): Promise<RunSummary[]> {
    const key = sanitizeSessionKey(sessionID)
    const byId = new Map<string, RunSummary>()
    for (const s of await this.opts.store.listRuns(key)) byId.set(s.runId, reconcileStored(s))
    for (const { run } of this.runs.values()) {
      const s = run.summary()
      if (sanitizeSessionKey(s.parentSessionID ?? "") === key) byId.set(s.runId, s)
    }
    return [...byId.values()].sort((a, b) => b.startedAt - a.startedAt || (a.runId < b.runId ? 1 : -1))
  }

  /** `forModel` (workflow_control): adds the P77 note when a run is still running or paused. */
  async listText(sessionID: string, opts: { forModel?: boolean } = {}): Promise<string> {
    const runs = await this.listSessionRuns(sessionID)
    const text = formatRunList(runs, this.now())
    if (!opts.forModel) return text
    const active = runs.filter((r) => r.status === "running" || r.status === "paused").map((r) => r.runId)
    if (!active.length) return text
    return `${text}\n\nStill running: ${active.join(", ")}. ${AWAIT_NOTIFICATION}`
  }

  /**
   * True when `runId` belongs to `sessionID` (P75): the live run's parent session, else the
   * session directory the run is stored under. Same check as resume (P41).
   */
  async ownsRun(runId: string, sessionID: string): Promise<boolean> {
    const key = sanitizeSessionKey(sessionID)
    const live = getActiveRun(runId)
    if (live) return sanitizeSessionKey(live.summary().parentSessionID ?? "") === key
    const loc = await this.opts.store.findRun(runId)
    return !!loc && loc.sessionKey === key
  }

  /**
   * One run in detail. `forModel` (workflow_control) never shows the run's result (P77): it reaches
   * the model only as the task notification. The user-facing /workflows <runId> always shows it.
   */
  async statusText(runId: string, sessionID: string, opts: { forModel?: boolean } = {}): Promise<string> {
    if (!(await this.ownsRun(runId, sessionID))) return notInSession(runId)
    const view = { forModel: !!opts.forModel }
    const live = getActiveRun(runId)
    let text: string
    let status: string
    if (live) {
      const s = live.summary()
      const activity = this.activityOf(runId)
      // P77: what an agent is writing or thinking is a partial result; the model sees only that it is.
      text = formatRunStatus(s, live.agents(), this.now(), { ...view, activity: view.forModel ? withoutText(activity) : activity })
      status = s.status
    } else {
      const stored = await this.opts.store.readSummary(runId)
      if (!stored) return `unknown run: ${runId}`
      const summary = reconcileStored(stored)
      // No engine owns this run: an agent still marked queued/running on disk was cut off with it.
      text = formatRunStatus(summary, await this.storedAgents(runId, summary, summary !== stored), this.now(), view)
      status = summary.status
    }
    return view.forModel ? text + this.repeatNote(sessionID, runId, status) : text
  }

  /**
   * P77: " Repeating this call does not wait…" from the 2nd model-facing status/result call on the same
   * (session, run) since the run last changed state; "" otherwise.
   */
  private repeatNote(sessionID: string, runId: string, status: string): string {
    const key = `${sessionID}\n${runId}`
    const prev = this.progressCalls.get(key)
    const calls = prev && prev.status === status ? prev.calls + 1 : 1
    this.progressCalls.delete(key)
    this.progressCalls.set(key, { status, calls })
    while (this.progressCalls.size > 500) this.progressCalls.delete(this.progressCalls.keys().next().value!)
    return calls > 1 ? ` ${REPEAT_NOTE}` : ""
  }

  /**
   * workflow_control `result` (X21): what each agent of a FINISHED run returned: the list (failed
   * agents first, paged) or, with `agent` (index "3"/"#3", else an exact label), one agent's details
   * and full return value (paged by characters). A running or paused run gets the status note (P77),
   * so a polling model learns nothing new. Caller checked ownership (P75).
   */
  private async resultText(runId: string, sessionID: string, input: ControlInput): Promise<string> {
    const run = await this.loadRun(runId)
    if (!run) return `unknown run: ${runId}`
    const { summary } = run
    if (summary.status === "running" || summary.status === "paused") {
      return awaitNotificationNote(summary) + this.repeatNote(sessionID, runId, summary.status)
    }
    const agents = run.agents ?? (await this.storedAgents(runId, summary, false))
    const offset = toOffset(input.offset)
    const sel = input.agent === undefined || input.agent === null ? "" : String(input.agent).trim()
    if (!sel) return formatAgentList(summary, agents, offset)

    const total = agents.length
    const byIndex = /^#?(\d+)$/.exec(sel)
    if (byIndex) {
      const a = agents.find((x) => x.index === Number(byIndex[1]))
      if (a) {
        const other = agents.find((x) => x.index !== a.index && x.label.trim() === sel)
        const note = other
          ? `Note: agent:"${sel}" is read as index #${a.index}; agent #${other.index} has the label "${sel}" (pass agent:"#${other.index}" for it).`
          : undefined
        return formatAgentDetail(summary, a, { offset, total, note })
      }
    }
    const hits = agents.filter((x) => x.label.trim() === sel)
    if (hits.length === 1) return formatAgentDetail(summary, hits[0]!, { offset, total })
    if (hits.length > 1) {
      const shown = hits.slice(0, 20).map((x) => `#${x.index} ${x.status}`).join(", ")
      return (
        `Label "${sel}" matches ${hits.length} agents in run ${runId}: ${shown}${hits.length > 20 ? ", …" : ""}. ` +
        `Pass agent:"#<index>" for one of them.`
      )
    }
    return (
      `No agent "${sel}" in run ${runId}: it has ${total} agent${total === 1 ? "" : "s"}${total ? ` (#0–#${total - 1})` : ""}. ` +
      `Pass an index ("3" or "#3") or an exact label, or omit agent to list them.`
    )
  }

  /** A run with its agents: live, finished in this instance, or from disk (any Location). */
  private async loadRun(runId: string): Promise<RunSnapshot | undefined> {
    const live = getActiveRun(runId)
    if (live) return { summary: live.summary(), agents: live.agents() }
    const mem = this.snapshot(runId)
    if (mem) return mem
    const stored = await this.opts.store.readSummary(runId)
    if (!stored) return undefined
    const summary = reconcileStored(stored)
    return { summary, agents: await this.storedAgents(runId, summary, summary !== stored) }
  }

  /** A stored run's agent records; with `orphaned`, agents still queued/running on disk show as stopped. */
  private async storedAgents(runId: string, summary: RunSummary, orphaned: boolean): Promise<AgentRecord[]> {
    const agents: AgentRecord[] = []
    for (let i = 0; i < summary.agentCount; i++) {
      const r = await this.opts.store.readAgentRecord(runId, i)
      if (r) agents.push(orphaned && (r.status === "running" || r.status === "queued") ? { ...r, status: "stopped" } : r)
    }
    return agents
  }

  async control(input: ControlInput, sessionID: string): Promise<string> {
    const action = input?.action
    if (action === "list") return this.listText(sessionID, { forModel: true })
    const runId = nonEmpty(input.runId) ? input.runId.trim() : undefined
    if (!runId) return `runId is required for action "${String(action)}"`
    if (!(CONTROL_RUN_ACTIONS as readonly string[]).includes(String(action))) {
      return `unknown action "${String(action)}"; expected ${ACTION_LIST}`
    }
    // P75: every run action is limited to the caller's own runs.
    if (!(await this.ownsRun(runId, sessionID))) return notInSession(runId)
    switch (action) {
      case "status":
        return this.statusText(runId, sessionID, { forModel: true })
      case "save":
        return this.save(runId, input)
      case "result":
        return this.resultText(runId, sessionID, input)
      case "stop":
      case "stop_agent":
      case "pause":
      case "resume":
      case "message":
        return (await this.runAction(action, runId, getActiveRun(runId), input, { from: "model", via: "tool" })).message
      default:
        return `unknown action "${String(action)}"; expected ${ACTION_LIST}`
    }
  }

  /**
   * The live tree's `control` (X12): stop, stop_agent, pause, resume or message a run as the USER. It
   * reaches only the runs THIS plugin instance started (its Location): a run of another project in the
   * same opencode process is "not running" here. Within the Location it is not session-scoped: the RPC
   * has the trust of the server API (its password), which already lets a client prompt any session.
   * The model-facing paths (workflow_control, commands) keep P75.
   */
  async userControl(input: UserControlInput): Promise<ActionResult> {
    const runId = nonEmpty(input?.runId) ? input.runId.trim() : undefined
    if (!runId) return { ok: false, message: "runId is required" }
    const action = String(input.action ?? "")
    if (!(USER_ACTIONS as readonly string[]).includes(action)) {
      return { ok: false, message: `unknown action "${action}"; expected ${USER_ACTIONS.join(", ")}` }
    }
    return this.runAction(action as UserAction, runId, this.ownActiveRun(runId), input as ControlInput, { from: "user", via: "rpc" })
  }

  /** A live run this instance started (the RPC's view: runs of this Location only). */
  private ownActiveRun(runId: string): WorkflowRun | undefined {
    const run = this.runs.get(runId)?.run
    return run && isRunActive(runId) ? run : undefined
  }

  /** True when a stored run belongs to this instance's Location (run.json `directory`, X12). */
  private isOwnStored(s: Pick<RunSummary, "directory">): boolean {
    return typeof s.directory === "string" && samePath(s.directory, this.opts.cwd)
  }

  /** stop / stop_agent / pause / resume / message on a live run (after the caller's ownership check, if any). */
  private async runAction(
    action: UserAction,
    runId: string,
    run: WorkflowRun | undefined,
    input: ControlInput,
    who: { from: MessageFrom; via: MessageVia },
  ): Promise<ActionResult> {
    const notRunning = `run ${runId} is not running (unknown or already finished)`
    switch (action) {
      case "stop": {
        if (!run) return { ok: false, message: notRunning }
        if (run.status !== "running" && run.status !== "paused") {
          return { ok: false, message: `run ${runId} was already stopped; its remaining agents are still exiting` }
        }
        run.stop()
        return {
          ok: true,
          message: `Stopping run ${runId}. Running agents are interrupted and are not counted as failed; relaunch with resumeFromRunId "${runId}" to continue.`,
        }
      }
      case "stop_agent": {
        if (!run) return { ok: false, message: notRunning }
        const idx = input.agentIndex
        if (typeof idx !== "number" || !Number.isInteger(idx)) return { ok: false, message: "agentIndex (integer) is required for stop_agent" }
        return run.stopAgent(idx)
          ? { ok: true, message: `Stopped agent ${idx} of run ${runId}; it counts as failed and its agent() call resolves to null.` }
          : { ok: false, message: `agent ${idx} of run ${runId} is not queued or running` }
      }
      case "pause":
        if (!run) return { ok: false, message: notRunning }
        return run.pause()
          ? { ok: true, message: `Paused run ${runId}: no new agents start; running agents finish.` }
          : { ok: false, message: `run ${runId} cannot be paused (status: ${run.status})` }
      case "resume":
        if (!run) return { ok: false, message: `${notRunning}; relaunch it with resumeFromRunId instead` }
        return run.resume()
          ? { ok: true, message: `Resumed run ${runId}.` }
          : { ok: false, message: `run ${runId} is not paused (status: ${run.status})` }
      case "message": {
        const target = controlTarget(input)
        if (typeof target === "string") return { ok: false, message: target }
        return this.sendMessage({ runId, target, text: input.text, urgent: input.urgent === true, ...who }, run)
      }
    }
  }

  /**
   * Steers running agents of one of the caller's runs (X01–X08): workflow_control `message` (the
   * parent model), `/workflows msg` (the user). P75: another session's run is "not found". The
   * text is validated before anything is sent; each targeted agent gets one reply line.
   */
  async message(req: MessageRequest, sessionID: string): Promise<string> {
    const runId = String(req.runId ?? "").trim()
    if (!runId) return "runId is required to send a message"
    if (!(await this.ownsRun(runId, sessionID))) return notInSession(runId)
    return (await this.sendMessage({ ...req, runId }, getActiveRun(runId))).message
  }

  /**
   * Validates and sends one steering request to `run` (the live run the caller resolved). No ownership
   * check: callers do it (P75), or scope the run lookup to this instance (RPC, X12).
   */
  private async sendMessage(req: MessageRequest, run: WorkflowRun | undefined): Promise<ActionResult> {
    const runId = String(req.runId ?? "").trim()
    const text = typeof req.text === "string" ? req.text.trim() : ""
    if (!text) return { ok: false, message: 'text is required for action "message": the instruction to send to the agent' }
    if (text.length > MAX_MESSAGE_CHARS) {
      return {
        ok: false,
        message: `the message text is too long (${text.length} characters); it can be at most ${MAX_MESSAGE_CHARS} characters`,
      }
    }
    if (!req.target) return { ok: false, message: "a message needs exactly one target: agentIndex, label, phase or all:true" }
    if (!run || (run.status !== "running" && run.status !== "paused")) {
      return { ok: false, message: `run ${runId} is not running; messages can only be sent to the agents of a running run` }
    }
    let reports
    try {
      reports = await run.message(req.target, { from: req.from, via: req.via, text, urgent: !!req.urgent })
    } catch (e) {
      return { ok: false, message: errMsg(e) }
    }
    return {
      ok: reports.some((r) => r.outcome !== "refused"),
      message: formatMessageReports(runId, reports, { urgent: !!req.urgent, forModel: req.from === "model" }),
    }
  }

  // ---- live views (X12) ---------------------------------------------------------------------------

  private activityOf(runId: string): Map<number, LiveActivity> | undefined {
    try {
      return this.opts.activity?.(runId)
    } catch {
      return undefined
    }
  }

  private rememberFinished(snap: RunSnapshot): void {
    this.finished.delete(snap.summary.runId)
    this.finished.set(snap.summary.runId, snap)
    while (this.finished.size > RECENT_FINISHED) this.finished.delete(this.finished.keys().next().value!)
  }

  /** A run of this instance held in memory: live, or finished during this instance (X12). */
  snapshot(runId: string): RunSnapshot | undefined {
    const live = this.runs.get(runId)?.run
    if (live && isRunActive(runId)) return { summary: live.summary(), agents: live.agents() }
    return this.finished.get(runId) ?? (live ? { summary: live.summary(), agents: live.agents() } : undefined)
  }

  /**
   * A run of this Location: in memory, else from run.json and its agent records (a run cut off mid-way
   * shows as stopped). A stored run another Location started (or one from before run.json recorded its
   * `directory`) is unknown here, so one project's RPC never reads another's runs (X12).
   */
  async runSnapshot(runId: string): Promise<RunSnapshot | undefined> {
    const mem = this.snapshot(runId)
    if (mem) return mem
    const stored = await this.opts.store.readSummary(runId)
    if (!stored || !this.isOwnStored(stored)) return undefined
    const summary = reconcileStored(stored)
    const orphaned = summary !== stored
    const agents: AgentRecord[] = []
    for (let i = 0; i < summary.agentCount; i++) {
      const r = await this.opts.store.readAgentRecord(runId, i)
      if (r) agents.push(orphaned && (r.status === "running" || r.status === "queued") ? { ...r, status: "stopped" } : r)
    }
    return { summary, agents }
  }

  /**
   * Runs for the live tree, all of this Location: one session's runs (live and run.json) with
   * `sessionID`, else every run this instance started or finished. Active runs first, then the newest
   * finished ones.
   */
  async listSnapshots(input: { sessionID?: string; all?: boolean; limit?: number } = {}): Promise<RunSnapshot[]> {
    const limit = typeof input.limit === "number" && input.limit > 0 ? Math.floor(input.limit) : 20
    let out: RunSnapshot[]
    if (nonEmpty(input.sessionID) && !input.all) {
      const summaries = await this.listSessionRuns(input.sessionID)
      out = []
      for (const s of summaries) {
        const mem = this.snapshot(s.runId)
        if (mem) out.push(mem)
        else if (this.isOwnStored(s) && !isRunActive(s.runId)) out.push({ summary: s })
      }
    } else {
      const byId = new Map<string, RunSnapshot>()
      for (const snap of this.finished.values()) byId.set(snap.summary.runId, snap)
      for (const { run } of this.runs.values()) byId.set(run.runId, { summary: run.summary(), agents: run.agents() })
      out = [...byId.values()].sort(
        (a, b) => b.summary.startedAt - a.summary.startedAt || (a.summary.runId < b.summary.runId ? 1 : -1),
      )
    }
    const active = (x: RunSnapshot) => x.summary.status === "running" || x.summary.status === "paused"
    return [...out.filter(active), ...out.filter((x) => !active(x))].slice(0, limit)
  }

  private async save(runId: string, input: ControlInput): Promise<string> {
    const live = getActiveRun(runId)
    const summary = live ? live.summary() : await this.opts.store.readSummary(runId)
    let scriptPath = summary?.scriptPath
    if (!scriptPath) {
      const loc = await this.opts.store.findRun(runId)
      if (!loc) return `unknown run: ${runId}`
      scriptPath = resolvePath(loc.dir, "script.js")
    }
    let source: string
    try {
      source = await readFile(scriptPath, "utf8")
    } catch (e) {
      return `cannot read the script of run ${runId} (${scriptPath}): ${errMsg(e)}`
    }
    const location = input.location === "personal" ? "personal" : "project"
    let target: string
    try {
      target = saveWorkflow({
        source,
        name: nonEmpty(input.name) ? input.name.trim() : undefined,
        location,
        cwd: this.opts.cwd,
        env: this.opts.registryOptions?.env,
        configHome: this.opts.registryOptions?.configHome,
        home: this.opts.registryOptions?.home,
      })
    } catch (e) {
      return errMsg(e)
    }
    try {
      await this.opts.onSaved?.()
    } catch {
      // command refresh is best effort
    }
    // Saved workflows are keyed by meta.name (the file name only matters on disk).
    const name = extractMetaLoose(source)?.name ?? target
    return `Saved run ${runId}'s script to ${target} (${location}). Run it with /${name} <args> or the workflow tool {name: "${name}"}.`
  }

  /**
   * Stops every run this host started and waits (bounded) for them to settle. opencode disposes a
   * plugin on shutdown but also while the server keeps running (another plugin added/updated, an idle
   * location evicted), so each stopped run still sends its `stopped` task notification (reason +
   * resumeFromRunId hint) to the parent; otherwise the parent, told not to poll, would never learn the
   * run ended. Delivery is best effort (the session may be gone on process exit).
   */
  async dispose(waitMs = 5000): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.stopKeepAlive()
    const entries = [...this.runs.values()]
    for (const { run } of entries) run.stop(DISPOSE_STOP_REASON)
    await Promise.race([
      Promise.allSettled(entries.flatMap((e) => [e.run.settled(), e.notified])),
      new Promise((r) => setTimeout(r, waitMs)),
    ])
  }
}

/** Same path, spelled either way (case-insensitive on Windows). */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const r = resolvePath(p).replace(/[\\/]+$/, "")
    return process.platform === "win32" ? r.toLowerCase() : r
  }
  return norm(a) === norm(b)
}

/**
 * The live activity without what agents are writing or thinking (P77): the model-facing status shows
 * `writing…` / `thinking…` and tool calls, never a partial answer.
 */
function withoutText(activity: Map<number, LiveActivity> | undefined): Map<number, LiveActivity> | undefined {
  if (!activity) return undefined
  const out = new Map<number, LiveActivity>()
  for (const [i, a] of activity) out.set(i, a.kind === "text" || a.kind === "reasoning" ? { ...a, text: "" } : a)
  return out
}

/** The one target a workflow_control `message` names, or the error text. */
function controlTarget(input: ControlInput): MessageTarget | string {
  const targets: MessageTarget[] = []
  if (input.agentIndex !== undefined && input.agentIndex !== null) {
    const idx = input.agentIndex
    if (typeof idx !== "number" || !Number.isInteger(idx) || idx < 0) return "agentIndex must be a non-negative integer"
    targets.push({ kind: "index", index: idx })
  }
  if (nonEmpty(input.label)) targets.push({ kind: "label", label: input.label.trim() })
  if (nonEmpty(input.phase)) targets.push({ kind: "phase", phase: input.phase.trim() })
  if (input.all === true) targets.push({ kind: "all" })
  if (targets.length !== 1) return "a message needs exactly one target: agentIndex, label, phase or all:true"
  return targets[0]!
}

/**
 * A run.json that still says running/paused while no engine in this process owns the run means the
 * opencode process exited mid-run (one-shot CLI, --standalone, crash). Show it as stopped so
 * /workflows never lists a ghost as active. The stored file is left untouched; resume still works.
 */
export function reconcileStored(s: RunSummary): RunSummary {
  if ((s.status !== "running" && s.status !== "paused") || isRunActive(s.runId)) return s
  const note = `interrupted: the opencode process exited while this run was ${s.status}; relaunch with resumeFromRunId "${s.runId}" to continue`
  return { ...s, status: "stopped", warnings: [...(s.warnings ?? []), note] }
}

/** workflow_control `offset` (X21): a non-negative integer; a numeric string counts; anything else is 0. */
function toOffset(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : 0
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}
