// P76 on opencode 2.3.0: `ctx.permission.assert` (packages/plugin/src/promise/permission.ts) evaluates a
// session's rules plus its saved "always" approvals, runs the `permission.evaluate` hooks and, on
// "ask", shows opencode's own approval prompt in that session and waits for the reply. It resolves
// when allowed. A deny (a rule, a hook, a rejection with feedback) rejects with a Tool.Error carrying
// the reason; a plain rejection rejects with a Permission.DeclinedError defect, which a tool must
// rethrow so opencode ends the step as it does for its own tools (core/src/plugin/host.ts).
//
// The `workflow` tool call is the only interactive path: a workflow() call inside a running script
// happens in the background, where a prompt would hold the run on a user who may not be there (and
// could outlive the run, since assert takes no abort signal). Those asserts carry a metadata marker,
// and this plugin's evaluate hook turns their "ask" into a deny: saved approvals and allow rules
// still admit the file, nothing prompts.

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

/** Resolves when allowed; rejects as `ctx.permission.assert` does (see the header). */
export type AssertPermission = (request: AssertRequest, mode: { interactive: boolean }) => Promise<void>

/** Metadata key that marks an assert nobody can answer (a workflow() call inside a running script). */
export const UNATTENDED_METADATA_KEY = "workflowUnattended"

export const UNATTENDED_ASK_MESSAGE =
  "workflow() inside a running workflow cannot ask for approval, so the request was refused. Add an allow " +
  'rule, or approve it with "always" when a workflow tool call asks for it'

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
export function createPermissionAsserter(ctx: Pick<Plugin.Context, "permission">): AssertPermission | undefined {
  const permission = (ctx as any).permission as Partial<Plugin.Context["permission"]> | undefined
  if (typeof permission?.assert !== "function" || typeof permission.hook !== "function") return undefined
  return async (request, mode) => {
    const input: Record<string, unknown> = {
      sessionID: request.sessionID,
      action: request.action,
      resources: request.resources,
    }
    if (request.agent) input.agent = request.agent
    if (request.save?.length) input.save = request.save
    const metadata = mode.interactive ? request.metadata : { ...request.metadata, [UNATTENDED_METADATA_KEY]: true }
    if (metadata) input.metadata = metadata
    if (mode.interactive && request.source) input.source = request.source
    await permission.assert!(input as any)
  }
}
