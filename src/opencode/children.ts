// Which sessions are workflow children: the runner tags each child session with metadata
// `workflowRunId` (src/opencode/runner.ts). Session hooks (permission `evaluate` for P63, session
// `experimental.idle` for X22/X23) run for every session of the instance's Location, so they look
// the tag up once per session and cache the answer.

import type { Plugin } from "@opencode/plugin"

/**
 * Returns a cached lookup: sessionID → the child's `workflowRunId`, or undefined for any other
 * session. A failed lookup (unknown session, transient error) is not cached.
 */
export function createWorkflowChildLookup(ctx: Pick<Plugin.Context, "session">, cacheLimit = 4096) {
  const known = new Map<string, Promise<string | undefined>>()
  return (sessionID: string): Promise<string | undefined> => {
    let p = known.get(sessionID)
    if (!p) {
      p = (async () => {
        try {
          // Deferred so a synchronous throw also lands after the cache entry is set (and is removed).
          const info = (await Promise.resolve().then(() => ctx.session.get({ sessionID } as any))) as any
          const runId = info?.metadata?.workflowRunId
          return typeof runId === "string" ? runId : undefined
        } catch {
          known.delete(sessionID) // unknown / transient failure: not cached
          return undefined
        }
      })()
      if (known.size >= cacheLimit) known.clear()
      known.set(sessionID, p)
    }
    return p
  }
}
