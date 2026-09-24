// AgentRunner over the opencode v2 plugin Context: one workflow agent = one child session.
//
//   create (tagged title + metadata, model, agent, permissions, location) -> prompt -> wait
//   -> get (outcome, tokens, cost) -> context (last assistant text)
//
// Structured output (P21) goes through the `workflow_submit` tool (src/opencode/submit.ts); the
// runner re-prompts until a valid submission arrives or the retry budget is spent, then falls back
// to JSON found in the last reply. Abort (P23) interrupts the child. Worktree isolation (P28) uses
// ctx.worktree and removes the worktree afterwards when git shows no changes.
// Every child prompt starts with SUBAGENT_PREAMBLE, or STRUCTURED_SUBAGENT_PREAMBLE for schema agents (P78).
// Steering (X01–X04, X08; design §A.4): the request's mailbox is attached once the child exists. Held
// messages are appended to the first prompt. While a turn runs the window is open and each message is
// sent with session.synthetic({delivery:"steer", resume:false}) (plus interrupt({resume:true}) when
// urgent). When wait() resolves the window is closed and each sent message is looked up in context().
// One that missed the turn is parked (resume:false wakes nothing), so the runner wakes the session
// with interrupt({resume:true}) and waits for that successor turn before it reads the result. A
// message it gives up on stays parked and never starts a turn nobody reads.
// Live-verified shapes: docs/OPENCODE-API-NOTES.md.

import { execFile } from "node:child_process"
import type { Plugin } from "@opencode/plugin"
import {
  extractJsonFromText,
  maxStructuredRetries,
  structuredOutputInstructions,
  SUBMIT_TOOL_NAME,
  validateOutput,
} from "../schema.ts"
import type { AgentMessage } from "../mailbox.ts"
import type { AgentOutcome, AgentRecord, AgentRequest, AgentRunner, Json, TokenUsage } from "../types.ts"
import { ZERO_USAGE } from "../types.ts"
import { formatModelRef, resolveChildModel, type ModelRef } from "./model.ts"
import {
  CHILD_DENIED_INTERACTIVE_TOOLS,
  evaluatePermission,
  getAgentInfo,
  type AgentInfo,
  type PermissionRule,
} from "./permissions.ts"
import { formatOrchestratorMessage, STEERING_PREAMBLE_LINE } from "./steer.ts"
import { createSubmitRegistry, type SubmitRegistry } from "./submit.ts"

export type { PermissionRule } from "./permissions.ts"

export type RunnerContext = Pick<Plugin.Context, "session" | "model" | "worktree" | "storage" | "location" | "agent">

/** The subset of the parent Session.Info the runner needs. */
export interface ParentSession {
  model?: ModelRef
  permissions?: ReadonlyArray<PermissionRule>
  projectID?: string
  /** The session's stored agent (Session.Info.agent); used when the launch did not say. */
  agent?: string
}

const PREAMBLE_HEAD =
  "You are a subagent run non-interactively by a workflow script. No human reads or answers you during this task."
const PREAMBLE_NO_QUESTIONS =
  "- Do not ask questions or ask for confirmation: when something is unclear, make a reasonable assumption and continue."
const PREAMBLE_NO_WORKFLOWS = "- You cannot launch workflows."

/**
 * Framing block prepended to every plain-text child prompt (P78). Only the text sent to the child
 * session gets it: the journal key (resume cache, P41) is computed from the script's own prompt, so
 * it is unchanged.
 */
export const SUBAGENT_PREAMBLE = [
  PREAMBLE_HEAD,
  PREAMBLE_NO_QUESTIONS,
  "- Your FINAL message is returned verbatim to the script as data. End with a final text answer that contains only the " +
    "requested content, in the requested format: no greetings, no follow-up offers. Mention an assumption only if the " +
    "requested format has room for it.",
  PREAMBLE_NO_WORKFLOWS,
  STEERING_PREAMBLE_LINE,
  "Your task:",
].join("\n")

/** P78 variant for schema agents: their answer is the workflow_submit call described after the task. */
export const STRUCTURED_SUBAGENT_PREAMBLE = [
  PREAMBLE_HEAD,
  PREAMBLE_NO_QUESTIONS,
  "- Your answer is your workflow_submit call (see the required output format after the task): its `output` is " +
    "returned to the script as data. Put any assumption inside that output only if its schema has room for it.",
  PREAMBLE_NO_WORKFLOWS,
  STEERING_PREAMBLE_LINE,
  "Your task:",
].join("\n")

/** The text sent to a child session for the script's prompt. */
export function childPrompt(prompt: string, structured = false): string {
  return `${structured ? STRUCTURED_SUBAGENT_PREAMBLE : SUBAGENT_PREAMBLE}\n\n${prompt}`
}

/** opencode's subagent tool name: its permission gates which agents may run as subagents. */
export const SUBAGENT_PERMISSION = "subagent"

/** Runs `git <args>` in `cwd` and resolves stdout; rejects on non-zero exit. */
export type GitExec = (args: string[], cwd: string) => Promise<string>

export interface OpencodeRunnerOptions {
  parentSessionID: string
  /**
   * The agent the parent session was running when it launched the workflow (tool ctx.agent). Children
   * run as this agent by default, so its restrictions (e.g. Plan mode's edit deny) carry over (P61).
   */
  parentAgent?: string
  runId: string
  /** Supplies the parent session (defaults to ctx.session.get({sessionID: parentSessionID})). */
  getParent?: () => Promise<ParentSession | undefined>
  /** Shared with the registered workflow_submit tool. Default: a storage-backed registry. */
  registry?: SubmitRegistry
  /** Tools denied in every child (P60). Default ["workflow"]. */
  deniedTools?: string[]
  /** git runner for worktree change detection (tests inject a fake). */
  git?: GitExec
  /** Per-agent timeout; default env OPENCODE_WORKFLOW_AGENT_TIMEOUT_MS (unset/0 = none). */
  timeoutMs?: number
}

const defaultGit: GitExec = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile("git", args, { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err)
      else resolve(String(stdout))
    })
  })

function envTimeout(): number | undefined {
  const raw = process.env.OPENCODE_WORKFLOW_AGENT_TIMEOUT_MS
  if (!raw || !raw.trim()) return undefined
  const n = Number.parseInt(raw.trim(), 10)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === "object" && e !== null && "message" in e) return String((e as { message: unknown }).message)
  return String(e)
}

function usageOf(info: any): TokenUsage {
  const t = info?.tokens ?? {}
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0)
  return {
    input: n(t.input),
    output: n(t.output),
    reasoning: n(t.reasoning),
    cacheRead: n(t.cache?.read),
    cacheWrite: n(t.cache?.write),
    cost: n(info?.cost),
  }
}

function defaultLabel(req: AgentRequest): string {
  if (req.opts.label) return req.opts.label
  const line = req.prompt.split(/\r?\n/).find((l) => l.trim() !== "")?.trim() ?? ""
  if (!line) return `agent ${req.index}`
  return line.length > 60 ? line.slice(0, 57) + "..." : line
}

/** Text of the last assistant message that has any text part (P20). */
function lastAssistantText(messages: any[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.type !== "assistant" || !Array.isArray(m.content)) continue
    const parts = m.content.filter((c: any) => c?.type === "text" && typeof c.text === "string").map((c: any) => c.text)
    const text = parts.join("\n").trim()
    if (text) return text
  }
  return undefined
}

function lastAssistantError(messages: any[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.type === "assistant" && m.error?.message) {
      return m.error.type ? `${m.error.type}: ${m.error.message}` : String(m.error.message)
    }
    if (m?.type === "user") break
  }
  return undefined
}

type StopReason = "abort" | "timeout"

/** Backoff between the post-turn delivery checks (design §A.4); ~2 s in total. */
export const STEER_VERIFY_DELAYS_MS: readonly number[] = [0, 50, 150, 300, 600, 900]

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export function createOpencodeRunner(ctx: RunnerContext, options: OpencodeRunnerOptions): AgentRunner {
  const registry = options.registry ?? createSubmitRegistry(ctx.storage)
  const git = options.git ?? defaultGit
  const denied = options.deniedTools ?? ["workflow"]

  async function getParent(): Promise<ParentSession | undefined> {
    if (options.getParent) return options.getParent()
    const info = (await ctx.session.get({ sessionID: options.parentSessionID })) as any
    return {
      model: info?.model,
      permissions: info?.permissions,
      projectID: info?.projectID,
      agent: typeof info?.agent === "string" ? info.agent : undefined,
    }
  }

  // Agent lookups are cached per runner (one run): agent definitions do not change mid-run.
  const agentCache = new Map<string, Promise<AgentInfo | undefined>>()
  const agentInfo = (id: string) => {
    let p = agentCache.get(id)
    if (!p) {
      p = getAgentInfo(ctx, id)
      p.catch(() => agentCache.delete(id))
      agentCache.set(id, p)
    }
    return p
  }

  /**
   * Chooses the child's agent and the extra rules it inherits (P61), mirroring opencode's own
   * subagent tool: an explicit agentType must exist, must not be a primary-mode agent, and must not be
   * denied by the parent's `subagent` permission. Without agentType the child runs as the parent's
   * agent. With a different agentType the parent agent's deny/ask rules are appended after the chosen
   * agent's rules (later rules win), so the child is never less restricted than its parent; the
   * parent agent's allow rules are not copied, since they could widen the chosen agent's own limits.
   */
  async function childAgent(
    agentType: string | undefined,
    parent: ParentSession | undefined,
  ): Promise<{ agent?: string; rules: PermissionRule[] } | { error: string }> {
    const parentAgentID = options.parentAgent ?? parent?.agent
    let parentAgent: AgentInfo | undefined
    if (parentAgentID) {
      parentAgent = await agentInfo(parentAgentID)
      if (!parentAgent) return { error: `cannot resolve the parent session's agent "${parentAgentID}"` }
    }
    if (!agentType || agentType === parentAgentID) return { agent: parentAgentID, rules: [] }
    const chosen = await agentInfo(agentType)
    if (!chosen) return { error: `unknown agent "${agentType}" (agentType)` }
    if (chosen.mode === "primary") return { error: `agent "${agentType}" is a primary agent and cannot run as a subagent` }
    const parentRules = [...(parentAgent?.permissions ?? []), ...(parent?.permissions ?? [])]
    if (evaluatePermission(SUBAGENT_PERMISSION, chosen.id, parentRules) === "deny") {
      return { error: `agent "${agentType}" is denied as a subagent by the parent's permission rules` }
    }
    return { agent: chosen.id, rules: (parentAgent?.permissions ?? []).filter((r) => r.effect !== "allow").map((r) => ({ ...r })) }
  }

  return {
    async run(request: AgentRequest): Promise<AgentOutcome> {
      const { signal } = request
      if (signal.aborted) return { status: "stopped", usage: ZERO_USAGE }
      const update = (u: Partial<AgentRecord>) => {
        try {
          request.onUpdate?.(u)
        } catch {
          // progress reporting must never break the agent
        }
      }
      const warnings: string[] = []
      const warn = (w: string) => {
        warnings.push(w)
        update({ warnings: [...warnings] })
      }

      // Stop signal: abort or per-agent timeout, whichever first.
      const timeoutMs = options.timeoutMs ?? envTimeout()
      let stopReason: StopReason | undefined
      let onStop!: (r: StopReason) => void
      const stopped = new Promise<StopReason>((resolve) => {
        onStop = (r) => {
          if (!stopReason) {
            stopReason = r
            resolve(r)
          }
        }
      })
      const onAbort = () => onStop("abort")
      signal.addEventListener("abort", onAbort, { once: true })
      const timer = timeoutMs ? setTimeout(() => onStop("timeout"), timeoutMs) : undefined

      let sessionID: string | undefined
      let worktree: { directory: string; projectID: string; head?: string } | undefined
      let usage: TokenUsage = ZERO_USAGE
      const schema = request.opts.schema

      /**
       * The model the agent runs on (X18): what the child session reports, else what was requested.
       * Reported via onUpdate when it is first known and whenever a later get() shows another one (an
       * opencode fallback); a session model that differs from the request is noted once per model.
       */
      let requestedModel: string | undefined
      let currentModel: string | undefined
      const mismatchWarned = new Set<string>()
      const noteModel = (sessionModel: unknown) => {
        const actual = formatModelRef(sessionModel)
        const model = actual ?? currentModel ?? requestedModel
        if (actual && requestedModel && actual !== requestedModel && !mismatchWarned.has(actual)) {
          mismatchWarned.add(actual)
          warn(`model: requested ${requestedModel} but the agent runs on ${actual}`)
        }
        if (model && model !== currentModel) {
          currentModel = model
          update({ model })
        }
      }

      const refreshUsage = async () => {
        if (!sessionID) return
        try {
          usage = usageOf(await ctx.session.get({ sessionID }))
        } catch {
          // keep last known
        }
      }

      const mailbox = request.mailbox
      let urgentWarned = false
      /**
       * Sends one steering message to the child (X01, X08). Resolves with the context message id ("" when
       * opencode returned none). resume:false: the item is read at the running turn's next step boundary,
       * and one that arrives after the last boundary stays parked instead of waking the session by itself;
       * settleMessages() decides whether to start the turn that reads it, so no turn ever runs unread.
       */
      const sendSteer = async (m: AgentMessage): Promise<{ id: string }> => {
        const res = (await ctx.session.synthetic({
          sessionID: sessionID!,
          text: formatOrchestratorMessage(m),
          description: `workflow message (${m.from})`,
          metadata: { workflowRunId: request.runId, workflowAgentIndex: request.index, workflowMessageId: m.id },
          delivery: "steer",
          resume: false,
        } as any)) as { id?: string } | undefined
        if (m.urgent) {
          try {
            await ctx.session.interrupt({ sessionID: sessionID!, resume: true } as any)
          } catch {
            // already idle: the message wakes it (resume:true)
          }
          if (!urgentWarned) {
            urgentWarned = true
            warn("an urgent message interrupted the agent's current step; that step's tokens are not counted in its usage")
          }
        }
        return { id: String(res?.id ?? "") }
      }
      /** Schema agents: a message can no longer change an accepted submission (X02). */
      const submittedGuard = async () => ((await registry.read(sessionID!))?.accepted ? ("submitted" as const) : undefined)

      /** Waits for the child to go idle, or the stop signal. */
      const idle = async (): Promise<boolean> => {
        const done = await Promise.race([ctx.session.wait({ sessionID: sessionID! }).then(() => "idle" as const), stopped])
        return done === "idle" && !stopReason
      }

      /**
       * Wakes the idle child for its parked steer items: opencode's interrupt({resume:true}) interrupts
       * nothing on an idle session but starts a successor turn when a steer item is pending (and does
       * nothing when none is). The successor execution is registered at once, so the next wait() covers it.
       */
      const wake = async () => {
        try {
          await ctx.session.interrupt({ sessionID: sessionID!, resume: true } as any)
        } catch {
          // gone: the verification below reports the messages undelivered
        }
      }

      /**
       * Closes the steer window after a turn (design §A.4). Every message sent in it must show up in the
       * child's context. One that arrived after the turn's last step boundary is parked (resume:false), so
       * the runner starts the successor turn that reads it and waits for that turn before the result is
       * read. A message it still cannot find is reported undelivered and stays parked: it never starts a
       * turn later, so nothing runs unread and no tokens escape the agent's usage. A send whose id is
       * unknown cannot be checked in context(): it gets the same wake and one extra wait, and stays "sent".
       * Returns false when stopped.
       */
      const settleMessages = async (): Promise<boolean> => {
        if (!mailbox) return true
        const sent = await mailbox.close()
        if (!sent.length) return true
        // message id → context message id (keyed by message id: several sends may lack a delivery id).
        const pending = new Map<string, string>()
        let unverifiable = 0
        for (const s of sent) {
          if (s.deliveryId) pending.set(s.id, s.deliveryId)
          else unverifiable++
        }
        const check = async () => {
          if (!pending.size) return
          const ids = new Set(((await ctx.session.context({ sessionID: sessionID! }).catch(() => [])) as any[]).map((m) => m?.id))
          for (const [id, deliveryId] of [...pending]) {
            if (ids.has(deliveryId)) {
              pending.delete(id)
              mailbox.report(id, "delivered")
            }
          }
        }
        if (!(await idle())) return false
        await check()
        if (pending.size || unverifiable) {
          await wake()
          for (const delay of STEER_VERIFY_DELAYS_MS) {
            if (delay) await sleep(delay)
            if (!(await idle())) return false
            await check()
            if (!pending.size && (!unverifiable || delay > 0)) break
          }
        }
        // The reply to a delivered message may still be streaming: wait once more before reading.
        if (!(await idle())) return false
        if (pending.size) {
          const lost = [...pending.keys()]
          for (const id of lost) mailbox.report(id, "undelivered")
          warn(`message(s) ${lost.join(", ")} were not delivered before the agent finished; they stay unread in its session`)
        }
        return true
      }

      const stoppedOutcome = async (): Promise<AgentOutcome> => {
        mailbox?.seal()
        if (sessionID) {
          try {
            await ctx.session.interrupt({ sessionID })
          } catch {
            // already idle / gone
          }
          // Give the child a moment to settle so the final usage is recorded.
          await Promise.race([ctx.session.wait({ sessionID }).catch(() => {}), new Promise((r) => setTimeout(r, 2000))])
          await refreshUsage()
        }
        if (stopReason === "timeout") {
          return { status: "failed", error: `agent timed out after ${timeoutMs}ms`, usage, sessionID }
        }
        return { status: "stopped", usage, sessionID }
      }

      /** One prompt/wait turn. Returns a terminal outcome, or undefined when the turn succeeded. */
      const turn = async (text: string, onPrompted?: () => void): Promise<AgentOutcome | undefined> => {
        await ctx.session.prompt({ sessionID: sessionID!, text })
        onPrompted?.()
        // The window opens once the prompt is in: a steer sent before it could wake the idle session
        // into a turn of its own.
        mailbox?.open()
        const done = await Promise.race([ctx.session.wait({ sessionID: sessionID! }).then(() => "idle" as const), stopped])
        if (done !== "idle" || stopReason) return stoppedOutcome()
        if (!(await settleMessages())) return stoppedOutcome()
        const info = (await ctx.session.get({ sessionID: sessionID! })) as any
        usage = usageOf(info)
        noteModel(info?.model)
        if (info?.outcome === "failed") {
          const messages = (await ctx.session.context({ sessionID: sessionID! }).catch(() => [])) as any[]
          return {
            status: "failed",
            error: lastAssistantError(messages) ?? "agent session failed (terminal error)",
            usage,
            sessionID,
          }
        }
        if (info?.outcome === "interrupted") {
          if (stopReason) return stoppedOutcome()
          return { status: "failed", error: "agent session was interrupted", usage, sessionID }
        }
        return undefined
      }

      const main = async (): Promise<AgentOutcome> => {
        // Parent session: model + permissions (P25, P61).
        let parent: ParentSession | undefined
        try {
          parent = await getParent()
        } catch (e) {
          warn(`could not read parent session: ${errMsg(e)}; using opencode defaults`)
        }
        const resolved = await resolveChildModel(ctx, {
          requested: request.opts.model,
          effort: request.opts.effort,
          parentModel: parent?.model,
        })
        for (const w of resolved.warnings) warn(w)
        if (stopReason) return stoppedOutcome()

        // Child agent (P27, P61): validated before anything is created.
        const chosen = await childAgent(request.opts.agentType, parent)
        if ("error" in chosen) return { status: "failed", error: chosen.error, usage }
        if (stopReason) return stoppedOutcome()

        // Worktree isolation (P28).
        if (request.opts.isolation === "worktree") {
          const projectID = parent?.projectID ?? ctx.location.project.id
          try {
            const created = (await ctx.worktree.create({
              projectID,
              name: `wf-${request.runId}-${request.index}`,
            })) as { directory: string }
            worktree = { directory: created.directory, projectID }
          } catch (e) {
            return { status: "failed", error: `could not create worktree: ${errMsg(e)}`, usage }
          }
          try {
            worktree.head = (await git(["rev-parse", "HEAD"], worktree.directory)).trim()
          } catch {
            // no baseline: change detection falls back to status only
          }
          if (stopReason) return stoppedOutcome()
        }

        // Permissions: the parent agent's restrictions (when the child runs another agent), the
        // parent's session rules, then the P60 denies. Later rules win.
        const permissions: PermissionRule[] = [...chosen.rules, ...(parent?.permissions ?? []).map((r) => ({ ...r }))]
        // P63: interactive tools (question forms) would wait forever in a session nobody sees.
        for (const tool of CHILD_DENIED_INTERACTIVE_TOOLS) permissions.push({ action: tool, resource: "*", effect: "deny" })
        for (const tool of denied) permissions.push({ action: tool, resource: "*", effect: "deny" })
        permissions.push({ action: SUBMIT_TOOL_NAME, resource: "*", effect: schema ? "allow" : "deny" })

        const metadata: Record<string, Json> = {
          workflowRunId: request.runId,
          workflowAgentIndex: request.index,
          parentSessionID: options.parentSessionID,
        }
        const phase = request.phase ?? request.opts.phase
        if (phase) metadata.workflowPhase = phase

        const created = (await ctx.session.create({
          title: `[wf:${request.runId}] ${defaultLabel(request)}`,
          metadata,
          ...(chosen.agent ? { agent: chosen.agent } : {}),
          ...(resolved.model ? { model: resolved.model } : {}),
          permissions,
          ...(worktree ? { location: { directory: worktree.directory } } : {}),
        })) as { id: string }
        sessionID = created.id
        update({ sessionID })
        requestedModel = formatModelRef(resolved.model)
        let sessionModel = (created as { model?: unknown }).model
        if (!formatModelRef(sessionModel)) {
          sessionModel = ((await ctx.session.get({ sessionID }).catch(() => undefined)) as { model?: unknown } | undefined)?.model
        }
        noteModel(sessionModel)
        if (stopReason) return stoppedOutcome()

        // Messages sent while the agent was queued go into its first prompt (X04).
        const held = mailbox?.attach(sendSteer, schema ? submittedGuard : undefined) ?? []
        const withHeld = (text: string) => (held.length ? `${text}\n\n${held.map(formatOrchestratorMessage).join("\n\n")}` : text)
        const reportHeld = () => {
          for (const m of held) mailbox?.report(m.id, "delivered")
        }

        if (!schema) {
          const first = withHeld(childPrompt(request.prompt))
          const end = await turn(first, reportHeld)
          if (end) return end
          const messages = (await ctx.session.context({ sessionID })) as any[]
          const text = lastAssistantText(messages)
          if (text === undefined) return { status: "failed", error: "agent finished with no text reply", usage, sessionID }
          return { status: "completed", value: text, usage, sessionID }
        }

        // Structured output (P21).
        await registry.register(sessionID, schema)
        const max = maxStructuredRetries()
        let missed = 0
        let prompt = withHeld(`${childPrompt(request.prompt, true)}\n\n${structuredOutputInstructions(schema)}`)
        let firstTurn = true
        for (;;) {
          const before = (await registry.read(sessionID))?.failures ?? 0
          const end = firstTurn ? await turn(prompt, reportHeld) : await turn(prompt)
          firstTurn = false
          if (end) return end
          const state = await registry.read(sessionID)
          if (state?.accepted) return { status: "completed", value: state.accepted.value as Json, usage, sessionID }
          const failures = state?.failures ?? 0
          if (failures === before) missed++
          if (failures + missed >= max) break
          prompt =
            (state?.lastError && failures > before
              ? `Your ${SUBMIT_TOOL_NAME} output failed schema validation:\n${state.lastError}\n\n`
              : `You did not call the \`${SUBMIT_TOOL_NAME}\` tool with a valid result.\n\n`) +
            `Call \`${SUBMIT_TOOL_NAME}\` now with the \`output\` argument matching the schema from your instructions. ` +
            "Do not redo the work: submit the result you already have."
        }

        // Retries spent: fall back to JSON in the last reply.
        const state = await registry.read(sessionID)
        const messages = (await ctx.session.context({ sessionID })) as any[]
        const text = lastAssistantText(messages)
        let lastError = state?.lastError
        const extracted = text !== undefined ? extractJsonFromText(text) : undefined
        if (extracted !== undefined) {
          const v = validateOutput(schema, extracted)
          if (v.ok) return { status: "completed", value: extracted as Json, usage, sessionID }
          lastError ??= v.error
        }
        const attempts = (state?.failures ?? 0) + missed
        return {
          status: "schema_failed",
          error:
            `structured output failed validation after ${attempts} attempts: ` +
            (lastError ?? `the agent never called ${SUBMIT_TOOL_NAME}`),
          usage,
          sessionID,
        }
      }

      try {
        return await main()
      } catch (e) {
        if (stopReason) return stoppedOutcome()
        await refreshUsage()
        return { status: "failed", error: errMsg(e), usage, sessionID }
      } finally {
        mailbox?.seal()
        signal.removeEventListener("abort", onAbort)
        if (timer) clearTimeout(timer)
        if (sessionID && schema) await registry.unregister(sessionID).catch(() => {})
        if (worktree) await cleanupWorktree(worktree)
      }

      async function cleanupWorktree(wt: { directory: string; projectID: string; head?: string }) {
        let changed = true
        try {
          const status = await git(["status", "--porcelain"], wt.directory)
          const head = wt.head ? (await git(["rev-parse", "HEAD"], wt.directory)).trim() : undefined
          changed = status.trim() !== "" || (wt.head !== undefined && head !== wt.head)
        } catch {
          changed = true // cannot tell: keep it
        }
        if (changed) {
          update({ worktree: wt.directory })
          return
        }
        try {
          await ctx.worktree.remove({ projectID: wt.projectID, directory: wt.directory, force: false })
        } catch (e) {
          warn(`could not remove unchanged worktree ${wt.directory}: ${errMsg(e)}`)
          update({ worktree: wt.directory })
        }
      }
    },
  }
}
