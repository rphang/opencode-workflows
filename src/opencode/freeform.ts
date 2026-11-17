// X24: which models get the freeform `workflow_script` tool.
//
// opencode 2.3.0 sends a tool's freeform encoding only to models whose models.dev
// `capabilities.freeform` lists the format (core/src/session/model-request.ts); every other model
// would get `workflow_script` as a plain JSON tool, a duplicate of `workflow {script}`. The session
// "context" hook runs before each model request with the request's (resolved) model and a copy of
// its tool definitions; deleting a key there drops that tool from the request.

import type { Plugin } from "@opencode/plugin"

interface ListedModel {
  id: string
  modelID?: string
  providerID: string
  capabilities?: { freeform?: readonly string[] }
}

/** The fields of the session "context" hook event this filter reads and edits. */
export interface ContextHookEvent {
  readonly model?: { readonly providerID?: string; readonly id?: string }
  tools?: Record<string, unknown>
}

export interface FreeformFilterOptions {
  /** The freeform format the tool declares (default "text"). */
  format?: string
  /** How long a `ctx.model.list()` result is reused (default 5 minutes). */
  ttlMs?: number
  now?: () => number
}

/**
 * Returns a `session.hook("context")` callback that removes `toolName` from requests whose model is
 * known not to list `format` in `capabilities.freeform`. A model the list does not know, or a list
 * that fails, keeps the tool: it still works as a JSON tool.
 */
export function createFreeformToolFilter(ctx: Pick<Plugin.Context, "model">, toolName: string, opts: FreeformFilterOptions = {}) {
  const format = opts.format ?? "text"
  const ttlMs = opts.ttlMs ?? 5 * 60_000
  const now = opts.now ?? Date.now
  let cache: { at: number; models: ListedModel[] } | undefined
  let inflight: Promise<ListedModel[]> | undefined

  const models = (): Promise<ListedModel[]> => {
    if (cache && now() - cache.at < ttlMs) return Promise.resolve(cache.models)
    inflight ??= (async () => {
      try {
        const res = (await ctx.model.list()) as unknown as { data?: ListedModel[] } | ListedModel[]
        const data = (Array.isArray(res) ? res : (res?.data ?? [])).filter((m) => m && typeof m === "object")
        cache = { at: now(), models: data }
        return data
      } finally {
        inflight = undefined
      }
    })()
    return inflight
  }

  const supports = async (ref: { providerID: string; id: string }): Promise<boolean | undefined> => {
    let list: ListedModel[]
    try {
      list = await models()
    } catch {
      return undefined
    }
    const m =
      list.find((x) => x.providerID === ref.providerID && x.id === ref.id) ??
      list.find((x) => x.providerID === ref.providerID && x.modelID === ref.id)
    if (!m) return undefined
    const formats = m.capabilities?.freeform
    return Array.isArray(formats) && formats.includes(format)
  }

  return async (event: ContextHookEvent): Promise<void> => {
    const tools = event?.tools
    if (!tools || !Object.prototype.hasOwnProperty.call(tools, toolName)) return
    const ref = event.model
    if (typeof ref?.providerID !== "string" || typeof ref.id !== "string") return
    if ((await supports({ providerID: ref.providerID, id: ref.id })) === false) delete tools[toolName]
  }
}
