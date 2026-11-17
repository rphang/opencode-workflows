// The `experimental.idle` session hook (opencode 2.3+; PARITY X22, X23; design §A.4).
//
// opencode runs it when a session finishes model work with nothing pending, just before the session
// goes idle; input admitted from it (or still arriving while it runs) continues the SAME execution
// (core/session/runner/llm.ts: hooks, then `SessionInbox.has(…, "input")`). For a workflow child:
//
//   0. X31: the child's own subagent/image jobs are reported to the job tracker (background.ts), and
//      while any runs the hook stops here: the job's report wakes the child later, the window stays
//      open (a message waits in the inbox for that execution) and nothing is nudged.
//   1. X22 flush (children of this instance's runs): the agent's mailbox stops taking messages
//      (`finishing`) and awaits the sends in flight. A sent message not in the child's context yet
//      waits in the inbox, so opencode continues with it: the window reopens and the hook returns.
//      A message posted after this point is refused `finishing` instead of being parked. If the
//      execution goes on anyway (another plugin's idle hook, a user prompt, the hook's cap), the
//      session "context" hook, which runs before every model request, reopens the window.
//   2. X23 nudge (schema agents, P21): no accepted workflow_submit, the agent is not being stopped,
//      its own subagent/image job is not running (that job's notice wakes it and the hook runs again,
//      like core/plugin/goal.ts) and the P21 budget is not spent: the runner's re-prompt text goes in
//      as a steer, the attempt is counted in the submit registry, and the window reopens.
//
// Nothing depends on the hook having run: on 2.0.15 the name registers but never fires, a worktree
// child's hook runs in the worktree instance (no mailbox there; it can still nudge through the shared
// storage), and a timed-out hook does nothing more. The runner's own wake (X03) and re-prompt loop
// (P21) cover all of these. The hook never rejects and is capped at IDLE_HOOK_TIMEOUT_MS: a rejected
// hook fails the child's execution and a hung one blocks it.

import type { Plugin } from "@opencode/plugin"
import type { AgentMailbox } from "../mailbox.ts"
import { maxStructuredRetries } from "../schema.ts"
import { createJobTracker, ownJobs, type JobTracker } from "./background.ts"
import { createWorkflowChildLookup } from "./children.ts"
import { attemptsUsed, retryPrompt, type SubmitRegistry } from "./submit.ts"

export const IDLE_HOOK_NAME = "experimental.idle"
/** Runs before every model request of a session: where a window the idle hook closed reopens. */
export const CONTEXT_HOOK_NAME = "context"
/** `0`/`false`/`no`/`off` registers no idle hook (the runner's fallbacks then do all the work). */
export const IDLE_HOOK_ENV = "OPENCODE_WORKFLOW_IDLE_HOOK"
export const IDLE_HOOK_TIMEOUT_MS = 3000

const FALSY = /^(0|false|no|off)$/i

export function idleHookEnabled(env: Record<string, string | undefined>): boolean {
  const raw = env[IDLE_HOOK_ENV]
  return !(raw !== undefined && FALSY.test(raw.trim()))
}

/** A running workflow child of this plugin instance (registered by the runner). */
export interface ChildLiveEntry {
  runId: string
  index: number
  mailbox?: AgentMailbox
  /** Schema agent (P21): nudged when it stops without an accepted submission. */
  schema: boolean
  /** The runner is stopping the agent (abort or timeout): nothing is sent any more. */
  stopping: boolean
}

/** sessionID → live child, shared by the runners and the idle hook of one plugin instance. */
export class ChildLiveRegistry {
  private readonly entries = new Map<string, ChildLiveEntry>()

  register(sessionID: string, entry: ChildLiveEntry): ChildLiveEntry {
    this.entries.set(sessionID, entry)
    return entry
  }

  /** Removes the session's entry (only `entry` itself, when given). */
  unregister(sessionID: string, entry?: ChildLiveEntry): void {
    if (!entry || this.entries.get(sessionID) === entry) this.entries.delete(sessionID)
  }

  get(sessionID: string): ChildLiveEntry | undefined {
    return this.entries.get(sessionID)
  }
}

/** The subset of opencode's SessionIdle event the hook reads. */
export interface IdleEvent {
  readonly sessionID: string
  readonly background?: ReadonlyArray<{ readonly kind: string; readonly sessionID: string; readonly [k: string]: unknown }>
}

export interface IdleHookOptions {
  registry: SubmitRegistry
  live: ChildLiveRegistry
  /** Where the child's background jobs are reported (X31). Default: a tracker over ctx.storage. */
  jobs?: JobTracker
  /** Cap on one hook run (default IDLE_HOOK_TIMEOUT_MS). */
  timeoutMs?: number
}

type IdleCtx = Pick<Plugin.Context, "session"> & Partial<Pick<Plugin.Context, "storage">>

export function createIdleHook(ctx: IdleCtx, options: IdleHookOptions): (event: IdleEvent) => Promise<void> {
  const { registry, live } = options
  const jobs = options.jobs ?? createJobTracker(ctx.storage)
  const cap = options.timeoutMs ?? IDLE_HOOK_TIMEOUT_MS
  const workflowRunOf = createWorkflowChildLookup(ctx)

  /** X22 step 1. True when a sent message still waits in the inbox (the execution continues with it). */
  async function flush(sessionID: string, mailbox: AgentMailbox, expired: () => boolean): Promise<boolean> {
    const sent = (await mailbox.quiesce()).filter((s) => s.deliveryId)
    if (!sent.length || expired()) return false
    const ids = new Set(((await ctx.session.context({ sessionID })) as any[]).map((m) => m?.id))
    if (sent.every((s) => ids.has(s.deliveryId)) || expired()) return false
    mailbox.reopen()
    return true
  }

  async function handle(event: IdleEvent, expired: () => boolean): Promise<void> {
    const sessionID = typeof event?.sessionID === "string" ? event.sessionID : ""
    if (!sessionID) return
    const entry = live.get(sessionID)
    const runId = entry ? entry.runId : await workflowRunOf(sessionID)
    if (runId === undefined || entry?.stopping) return
    // X31: while its own subagent/image job runs, the child is not done: the job's report wakes it.
    const own = ownJobs(sessionID, event.background)
    await jobs.report(sessionID, own, !!entry)
    if (own.length) return
    // Only a window this turn had open is the hook's to close and reopen. One the runner closed itself
    // (between schema retries, or while it verifies and wakes for parked messages, X03) stays closed:
    // a message sent then would never be verified.
    const mailbox = entry?.mailbox?.state === "open" ? entry.mailbox : undefined
    if (mailbox && (await flush(sessionID, mailbox, expired))) return

    // X23: a schema agent that stops without an accepted submission is asked again, in this execution.
    if (entry && !entry.schema) return
    // A child of another instance (worktree) is read from the shared storage (submit.ts).
    const state = await registry.read(sessionID)
    if (!state || state.accepted || attemptsUsed(state) >= maxStructuredRetries()) return
    if (expired() || entry?.stopping) return
    const nudge = (state.nudges ?? 0) + 1
    await ctx.session.synthetic({
      sessionID,
      text: retryPrompt(state),
      metadata: { workflowRunId: runId, workflowNudge: nudge },
      delivery: "steer",
      resume: false,
    } as any)
    // Past the cap the hook has already returned: the execution may have ended without the nudge
    // (it then waits in the inbox) and the runner counts the attempt when it re-prompts.
    if (expired()) return
    mailbox?.reopen()
    await registry.nextAttempt(sessionID, "nudge")
  }

  return async (event) => {
    let expired = false
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          expired = true
          resolve()
        }, cap)
        ;(timer as { unref?: () => void }).unref?.()
      })
      await Promise.race([handle(event, () => expired).catch(() => {}), timeout])
    } catch {
      // never fail the child's execution
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}

/**
 * Registers the hook when this opencode has session hooks (2.0.15 accepts the name and never runs
 * it; an older or different host may lack `session.hook` or reject the name). Returns the
 * registration, or undefined when nothing was registered.
 */
export async function registerIdleHook(ctx: IdleCtx, options: IdleHookOptions): Promise<{ dispose: () => Promise<void> } | undefined> {
  const hook = (ctx.session as { hook?: unknown } | undefined)?.hook
  if (typeof hook !== "function") return undefined
  type Reg = { dispose?: () => Promise<void> | void } | undefined
  const add = async (name: string, cb: (event: any) => unknown): Promise<Reg | null> => {
    try {
      return (await (hook as Function).call(ctx.session, name, cb)) as Reg
    } catch {
      return null
    }
  }
  const idle = await add(IDLE_HOOK_NAME, createIdleHook(ctx, options))
  if (idle === null) return undefined
  // X22: reopen a window the idle hook closed once the execution takes another model step anyway.
  const context = await add(CONTEXT_HOOK_NAME, createReopenHook(options.live))
  return {
    dispose: async () => {
      for (const r of [context, idle]) {
        try {
          await r?.dispose?.()
        } catch {}
      }
    },
  }
}

/** Session "context" hook: the next model step of a live child reopens a window quiesce() closed. */
export function createReopenHook(live: ChildLiveRegistry): (event: { readonly sessionID?: unknown }) => void {
  return (event) => {
    try {
      live.get(String(event?.sessionID ?? ""))?.mailbox?.reopen()
    } catch {
      // never fail the model request
    }
  }
}
