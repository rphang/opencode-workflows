// P76 on opencode 2.3.0: `ctx.permission.assert` (packages/plugin/src/promise/permission.ts) evaluates a
// session's rules plus its saved "always" approvals, runs the `permission.evaluate` hooks and, on
// "ask", shows opencode's own approval prompt in that session and waits for the reply. It resolves
// when allowed. A deny (a rule, a hook, a rejection with feedback) rejects with a Tool.Error carrying
// the reason; a plain rejection rejects with a Permission.DeclinedError defect, which a tool must
// rethrow so opencode ends the step as it does for its own tools (core/src/plugin/host.ts).
//
// assert takes no abort signal (the plugin adapter runs it in its own fiber) and core drops a pending
// prompt only when that fiber ends, so a prompt would outlive whoever waits on it. Every assert made
// here is therefore bounded, and when its caller gives up the prompt it raised is withdrawn by
// replying "reject" to it (permission.list → the request with our tool call as `source`, or our
// nonce in `metadata`). Core applies a reject to every pending prompt of that session (a batch), so
// a withdrawal also rejects any other prompt open in the parent session at that moment.
//
// The `workflow` tool call is the only interactive path, bounded by the call's abort signal (the
// user cancelling the call). A workflow() call inside a running script happens in the background,
// where a prompt would hold the run on a user who may not be there. Those asserts carry a metadata
// marker that this plugin's evaluate hook turns from "ask" into a deny, so saved approvals and allow
// rules still admit the file and nothing prompts. Another plugin's evaluate hook runs after ours and
// could turn it back into an ask: such an assert also has a short timeout, after which it counts as
// refused (fail closed) and its prompt is withdrawn.

import type { Plugin } from "@opencode/plugin"

export interface AssertRequest {
  sessionID: string
  agent?: string
  action: string
  resources: string[]
  save?: string[]
  metadata?: Record<string, unknown>
  /** The tool call the request belongs to (opencode shows the prompt with that call). */
  source?: { type: "tool"; messageID: string; id: string }
}

export interface AssertMode {
  /** A tool call the user is watching: a prompt may be shown. */
  interactive: boolean
  /** Gives up (and withdraws the prompt) when aborted: the tool call's signal. */
  signal?: AbortSignal
}

/**
 * Resolves when allowed; rejects as `ctx.permission.assert` does (see the header), with an
 * AbortError when `mode.signal` aborts first, and with UNATTENDED_ASK_MESSAGE when an unattended
 * check is still waiting after its timeout.
 */
export type AssertPermission = (request: AssertRequest, mode: AssertMode) => Promise<void>

/** How long an unattended check may wait (it should never wait: our evaluate hook denies its ask). */
export const UNATTENDED_ASSERT_TIMEOUT_MS = 3000

/** metadata key holding a per-assert id, to find (and withdraw) the prompt an unattended assert raised. */
export const ASSERT_ID_METADATA_KEY = "workflowAssertId"

/** Metadata key that marks an assert nobody can answer (a workflow() call inside a running script). */
export const UNATTENDED_METADATA_KEY = "workflowUnattended"

export const UNATTENDED_ASK_MESSAGE =
  "workflow() inside a running workflow cannot ask for approval, so the request was refused. Add an allow " +
  'rule, or approve it with "always" when a workflow tool call asks for it'

/** The caller gave up (its signal aborted) before the check finished; any prompt was withdrawn. */
export function isPermissionCancelled(e: unknown): boolean {
  return e instanceof Error && e.name === "AbortError"
}

function cancelled(): Error {
  const e = new Error("the workflow tool call was cancelled while waiting for approval; no run was started")
  e.name = "AbortError"
  return e
}

/** A user's plain rejection of the prompt (core Permission.DeclinedError, tunnelled as a defect). */
export function isPermissionDecline(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { _tag?: unknown })._tag === "Permission.DeclinedError"
}

/** `permission.hook("evaluate")` callback: an "ask" from an unattended assert becomes "deny". */
export function createUnattendedAskGuard() {
  return (event: { effect: string; message?: string; metadata?: Record<string, unknown> }): void => {
    if (event.effect !== "ask" || event.metadata?.[UNATTENDED_METADATA_KEY] !== true) return
    event.effect = "deny"
    event.message = UNATTENDED_ASK_MESSAGE
  }
}

/**
 * An AssertPermission over `ctx.permission.assert`, or undefined when the host has no `assert` (opencode
 * before 2.3.0) or no evaluate hook (an unattended assert could then prompt): callers then evaluate the
 * rules themselves. The caller registers createUnattendedAskGuard() when this returns a function.
 */
export interface PermissionAsserterOptions {
  /** Default UNATTENDED_ASSERT_TIMEOUT_MS. */
  unattendedTimeoutMs?: number
  /** Withdrawal polls permission.list until the assert settles: this often, at most this many times. */
  withdrawIntervalMs?: number
  withdrawTries?: number
}

export function createPermissionAsserter(
  ctx: Pick<Plugin.Context, "permission">,
  opts: PermissionAsserterOptions = {},
): AssertPermission | undefined {
  const permission = (ctx as any).permission as Partial<Plugin.Context["permission"]> | undefined
  if (typeof permission?.assert !== "function" || typeof permission.hook !== "function") return undefined
  const intervalMs = opts.withdrawIntervalMs ?? 50
  const tries = opts.withdrawTries ?? 100
  let seq = 0
  return (request, mode) => {
    if (mode.signal?.aborted) return Promise.reject(cancelled())
    const assertId = `${Date.now().toString(36)}-${++seq}-${Math.random().toString(36).slice(2, 8)}`
    const input: Record<string, unknown> = {
      sessionID: request.sessionID,
      action: request.action,
      resources: request.resources,
    }
    if (request.agent) input.agent = request.agent
    if (request.save?.length) input.save = request.save
    const metadata = mode.interactive
      ? request.metadata
      : { ...request.metadata, [UNATTENDED_METADATA_KEY]: true, [ASSERT_ID_METADATA_KEY]: assertId }
    if (metadata) input.metadata = metadata
    if (mode.interactive && request.source) input.source = request.source
    const ours = (r: any): boolean =>
      mode.interactive
        ? !!request.source && r?.source?.type === "tool" && r.source.id === request.source.id && r.source.messageID === request.source.messageID
        : r?.metadata?.[ASSERT_ID_METADATA_KEY] === assertId

    let settled = false
    const asserted = Promise.resolve().then(() => permission.assert!(input as any))
    asserted.then(
      () => void (settled = true),
      () => void (settled = true),
    )
    // The prompt may not exist yet when the caller gives up: keep looking until the assert settles.
    const withdraw = async () => {
      for (let i = 0; i < tries && !settled; i++) {
        try {
          const res = (await permission.list!({ sessionID: request.sessionID } as any)) as any
          const list: any[] = Array.isArray(res) ? res : Array.isArray(res?.data) ? res.data : []
          for (const r of list) {
            if (!ours(r) || typeof r.id !== "string") continue
            await permission.reply!({ sessionID: request.sessionID, requestID: r.id, decision: "reject" } as any).catch(() => {})
          }
        } catch {}
        if (!settled) await new Promise((r) => setTimeout(r, intervalMs))
      }
    }
    const timeoutMs = mode.interactive ? undefined : (opts.unattendedTimeoutMs ?? UNATTENDED_ASSERT_TIMEOUT_MS)

    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const done = () => {
        if (timer) clearTimeout(timer)
        mode.signal?.removeEventListener("abort", onAbort)
      }
      const giveUp = (error: Error) => {
        done()
        reject(error)
        void withdraw()
      }
      const onAbort = () => giveUp(cancelled())
      mode.signal?.addEventListener("abort", onAbort, { once: true })
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => giveUp(new Error(UNATTENDED_ASK_MESSAGE)), timeoutMs)
        ;(timer as any).unref?.()
      }
      asserted.then(
        () => {
          done()
          // Allowed just as the caller gave up: still not allowed to start anything.
          if (mode.signal?.aborted) reject(cancelled())
          else resolve()
        },
        (e) => {
          done()
          reject(e)
        },
      )
    })
  }
}
