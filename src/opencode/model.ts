// Model selection for workflow child sessions (PARITY P25 model override, P26 effort -> variant).
//
// opencode model refs are `{providerID, id, variant?}`; scripts pass `"provider/model[#variant]"`
// (the provider is everything before the FIRST slash, so `openrouter/anthropic/x` works) or a
// bare alias such as `"haiku"` (Claude Code style), resolved against `ctx.model.list()`.
// Effort levels map to model variants (live 2.0.15: openai gpt-5.4-mini lists
// none/low/medium/high/xhigh, gpt-5 lists minimal/low/medium/high, free opencode models none).

import type { Plugin } from "@opencode/plugin"
import type { Effort } from "../types.ts"

export interface ModelRef {
  providerID: string
  id: string
  variant?: string
}

/** Variant ids tried in order for each effort level (first one listed by the model wins). */
export const EFFORT_VARIANTS: Record<Effort, readonly string[]> = {
  low: ["low", "minimal"],
  medium: ["medium"],
  high: ["high"],
  xhigh: ["xhigh", "max", "high"],
  max: ["max", "xhigh", "high"],
}

/** Parse `provider/model[#variant]`; undefined when it is not a provider-qualified ref. */
export function parseModelRef(ref: string): ModelRef | undefined {
  const trimmed = ref.trim()
  const hash = trimmed.indexOf("#")
  const main = hash >= 0 ? trimmed.slice(0, hash) : trimmed
  const variant = hash >= 0 ? trimmed.slice(hash + 1).trim() : ""
  const slash = main.indexOf("/")
  if (slash <= 0 || slash === main.length - 1) return undefined
  const out: ModelRef = { providerID: main.slice(0, slash), id: main.slice(slash + 1) }
  if (variant) out.variant = variant
  return out
}

interface ListedModel {
  id: string
  modelID?: string
  providerID: string
  variants?: ReadonlyArray<{ id: string }>
  enabled?: boolean
  time?: { released?: number }
}

export type ModelContext = Pick<Plugin.Context, "model">

async function listModels(ctx: ModelContext): Promise<ListedModel[]> {
  const res = (await ctx.model.list()) as unknown as { data?: ListedModel[] } | ListedModel[]
  const data = Array.isArray(res) ? res : (res?.data ?? [])
  return data.filter((m) => m && m.enabled !== false)
}

function findModel(models: ListedModel[], ref: ModelRef): ListedModel | undefined {
  return (
    models.find((m) => m.providerID === ref.providerID && m.id === ref.id) ??
    models.find((m) => m.providerID === ref.providerID && m.modelID === ref.id)
  )
}

function resolveAlias(models: ListedModel[], alias: string, preferProvider?: string): ModelRef | undefined {
  const needle = alias.trim().toLowerCase()
  if (!needle) return undefined
  const rank = (list: ListedModel[]) =>
    [...list].sort((a, b) => {
      const pa = a.providerID === preferProvider ? 0 : 1
      const pb = b.providerID === preferProvider ? 0 : 1
      if (pa !== pb) return pa - pb
      return (b.time?.released ?? 0) - (a.time?.released ?? 0)
    })
  const exact = rank(models.filter((m) => m.id.toLowerCase() === needle))
  const partial = rank(models.filter((m) => m.id.toLowerCase().includes(needle)))
  const hit = exact[0] ?? partial[0]
  return hit ? { providerID: hit.providerID, id: hit.id } : undefined
}

export interface ResolveModelInput {
  /** `opts.model` from the script. */
  requested?: string
  effort?: Effort
  /** Parent session's model (default for children). */
  parentModel?: ModelRef
}

export interface ResolvedModel {
  /** undefined = let opencode pick its default model. */
  model?: ModelRef
  warnings: string[]
}

/** P25/P26: pick the child's model ref and variant. Never throws; problems become warnings. */
export async function resolveChildModel(ctx: ModelContext, input: ResolveModelInput): Promise<ResolvedModel> {
  const warnings: string[] = []
  let models: ListedModel[] | undefined
  const getModels = async () => {
    if (models) return models
    try {
      models = await listModels(ctx)
    } catch (e) {
      warnings.push(`could not list models: ${e instanceof Error ? e.message : String(e)}`)
      models = []
    }
    return models
  }

  let model: ModelRef | undefined = input.parentModel ? { ...input.parentModel } : undefined
  let explicitVariant = false
  if (input.requested !== undefined && input.requested.trim() !== "") {
    const parsed = parseModelRef(input.requested)
    if (parsed) {
      model = parsed
      explicitVariant = parsed.variant !== undefined
    } else {
      const alias = resolveAlias(await getModels(), input.requested, input.parentModel?.providerID)
      if (alias) model = alias
      else
        warnings.push(
          `model "${input.requested}" not found (expected "provider/model" or a known model name); using the ${
            model ? "parent session's" : "default"
          } model`,
        )
    }
  }

  if (input.effort && !explicitVariant) {
    if (!model) {
      warnings.push(`effort "${input.effort}" ignored: no model known to map it to a variant`)
    } else {
      const info = findModel(await getModels(), model)
      const available = new Set((info?.variants ?? []).map((v) => v.id))
      const variant = EFFORT_VARIANTS[input.effort].find((v) => available.has(v))
      if (variant) model = { ...model, variant }
      else {
        warnings.push(
          `effort "${input.effort}" ignored: model ${model.providerID}/${model.id} has no matching variant` +
            (available.size ? ` (variants: ${[...available].join(", ")})` : " (no variants)"),
        )
        // The parent's variant (e.g. "default") stays; an alias/explicit ref has none.
      }
    }
  }

  // A ref without a variant should not carry `variant: undefined` (keeps create() input clean).
  if (model && model.variant === undefined) delete model.variant
  return { model, warnings }
}

/**
 * `provider/model#variant` for a session model ref (X18); the variant only when one is set. opencode
 * gives a session without an explicit variant the variant "default", which is shown as none. Undefined
 * when `ref` is not a model ref.
 */
export function formatModelRef(ref: unknown): string | undefined {
  if (!ref || typeof ref !== "object") return undefined
  const { providerID, id, variant } = ref as Partial<ModelRef>
  if (typeof providerID !== "string" || !providerID || typeof id !== "string" || !id) return undefined
  const v = typeof variant === "string" && variant && variant !== "default" ? `#${variant}` : ""
  return `${providerID}/${id}${v}`
}
