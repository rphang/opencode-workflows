// opencode permission rules as seen by the plugin: evaluation mirrors opencode 2.0.15
// (core/src/permission.ts `evaluate`: rulesets are flattened, the LAST matching rule wins, no match
// means "ask"; core/src/util/wildcard.ts `match`). A session's effective rules are its agent's rules
// followed by the session's own `permissions` (docs/OPENCODE-API-NOTES.md "Permissions").
//
// Plugins cannot call opencode's permission.assert (it would need a tool invocation to ask the
// user), so the plugin evaluates the rules itself and treats "ask" as "not allowed" wherever it
// cannot ask (fail closed), except where noted by the caller.

import type { Plugin } from "@opencode/plugin"

export interface PermissionRule {
  action: string
  resource: string
  effect: "allow" | "deny" | "ask"
}

/** opencode's Wildcard.match: `*` any run (including `/`), `?` one char; `\` normalised to `/`. */
export function wildcardMatch(input: string, pattern: string): boolean {
  const normalized = input.replaceAll("\\", "/")
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?"
  return new RegExp("^" + escaped + "$", process.platform === "win32" ? "si" : "s").test(normalized)
}

/** Effect of the last rule matching (action, resource); "ask" when none matches (opencode default). */
export function evaluatePermission(
  action: string,
  resource: string,
  ...rulesets: ReadonlyArray<ReadonlyArray<PermissionRule>>
): PermissionRule["effect"] {
  const flat = rulesets.flat()
  let hit: PermissionRule | undefined
  for (let i = flat.length - 1; i >= 0 && !hit; i--) {
    const r = flat[i]!
    if (wildcardMatch(action, r.action) && wildcardMatch(resource, r.resource)) hit = r
  }
  return hit?.effect ?? "ask"
}

export interface AgentInfo {
  id: string
  mode?: "subagent" | "primary" | "all"
  permissions: PermissionRule[]
}

type AgentCtx = Pick<Plugin.Context, "agent">

/** ctx.agent.get → the agent, or undefined when opencode does not know it. */
export async function getAgentInfo(ctx: AgentCtx, agentID: string): Promise<AgentInfo | undefined> {
  let res: any
  try {
    res = await (ctx as any).agent.get({ agentID })
  } catch (e) {
    if (/not found/i.test(e instanceof Error ? e.message : String(e))) return undefined
    throw e
  }
  const data = res && typeof res === "object" && "data" in res ? res.data : res
  if (!data || typeof data !== "object") return undefined
  return {
    id: String(data.id ?? agentID),
    mode: data.mode,
    permissions: Array.isArray(data.permissions) ? data.permissions.map((r: PermissionRule) => ({ ...r })) : [],
  }
}

/**
 * The rules in force for a session running `agentID`: the agent's rules, then the session's.
 * `agentID` defaults to the session's stored agent. Unknown agent → session rules only.
 */
export async function effectiveSessionRules(
  ctx: Pick<Plugin.Context, "agent" | "session">,
  sessionID: string,
  agentID?: string,
): Promise<PermissionRule[]> {
  const info = (await ctx.session.get({ sessionID } as any)) as any
  const agent = agentID ?? (typeof info?.agent === "string" ? info.agent : undefined)
  const agentRules = agent ? ((await getAgentInfo(ctx, agent))?.permissions ?? []) : []
  const sessionRules: PermissionRule[] = Array.isArray(info?.permissions) ? info.permissions : []
  return [...agentRules, ...sessionRules]
}

/** Tools denied in every workflow child: they wait on the user in a session the user never sees. */
export const CHILD_DENIED_INTERACTIVE_TOOLS = ["question"] as const

export const CHILD_ASK_DENIED_MESSAGE =
  "workflow agents cannot ask for approval: this workflow agent runs in a background session the user " +
  "does not see, so the request was denied. Continue without it, or report that it is needed in your reply."

/** The event opencode passes to `permission.hook("evaluate", …)` (plugin PermissionEvaluation). */
export interface PermissionEvaluationEvent {
  readonly sessionID: string
  effect: PermissionRule["effect"]
  message?: string
}

/**
 * `permission.hook("evaluate")` callback: an "ask" raised by a workflow child session (metadata
 * `workflowRunId`) becomes "deny" with an explanation, because nobody sees that session's prompts and
 * the agent would wait forever (opencode shows and auto-accepts asks only for the viewed session and
 * its parentID family; plugin-created children have no parentID). Other sessions are untouched.
 * opencode runs the hook for the sessions of the plugin instance's own location, so every instance
 * (including the one loaded in a worktree) guards its own children.
 */
export function createChildAskGuard(ctx: Pick<Plugin.Context, "session">, cacheLimit = 4096) {
  const known = new Map<string, Promise<boolean>>()
  const isWorkflowChild = (sessionID: string): Promise<boolean> => {
    let p = known.get(sessionID)
    if (!p) {
      p = (async () => {
        try {
          // Deferred so a synchronous throw also lands after the cache entry is set (and is removed).
          const info = (await Promise.resolve().then(() => ctx.session.get({ sessionID } as any))) as any
          return typeof info?.metadata?.workflowRunId === "string"
        } catch {
          known.delete(sessionID) // unknown / transient failure: not cached
          return false
        }
      })()
      if (known.size >= cacheLimit) known.clear()
      known.set(sessionID, p)
    }
    return p
  }
  return async (event: PermissionEvaluationEvent): Promise<void> => {
    if (event.effect !== "ask" || !event.sessionID) return
    if (!(await isWorkflowChild(event.sessionID))) return
    event.effect = "deny"
    event.message = CHILD_ASK_DENIED_MESSAGE
  }
}
