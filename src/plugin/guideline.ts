// Workflow size guideline (P70), Claude Code's `workflowSizeGuideline` setting. It tells the model
// how many agents to aim for when it writes a workflow. That is advice in the `workflow` tool
// description, not a cap. When the user picks a value, its agent count also replaces the 25-agent
// Large-workflow warning threshold (P55). Claude Code's /config row has no opencode counterpart,
// so the value comes from the plugin option `sizeGuideline` or env OPENCODE_WORKFLOW_SIZE_GUIDELINE
// (the env wins). An unknown value is ignored, which leaves the default (medium, not user-chosen).

import { LARGE_WORKFLOW_AGENT_THRESHOLD } from "../engine.ts"

export type SizeGuideline = "unrestricted" | "small" | "medium" | "large"
export const SIZE_GUIDELINE_ENV = "OPENCODE_WORKFLOW_SIZE_GUIDELINE"
export const DEFAULT_SIZE_GUIDELINE: SizeGuideline = "medium"

/** Agent count each value aims below (Claude Code: small < 5, medium < 10, large < 50). */
export const SIZE_GUIDELINE_AGENTS: Record<Exclude<SizeGuideline, "unrestricted">, number> = { small: 5, medium: 10, large: 50 }

export interface ResolvedSizeGuideline {
  value: SizeGuideline
  /** True when the user set it (env or plugin option); only then does it move the warning threshold. */
  chosen: boolean
}

function parse(raw: unknown): SizeGuideline | undefined {
  if (typeof raw !== "string") return undefined
  const v = raw.trim().toLowerCase()
  return v === "unrestricted" || v === "small" || v === "medium" || v === "large" ? v : undefined
}

export function resolveSizeGuideline(env: Record<string, string | undefined>, options: Record<string, unknown> | undefined): ResolvedSizeGuideline {
  const value = parse(env[SIZE_GUIDELINE_ENV]) ?? parse(options?.sizeGuideline)
  return value ? { value, chosen: true } : { value: DEFAULT_SIZE_GUIDELINE, chosen: false }
}

/** Large-workflow warning threshold: the chosen guideline's agent count, else 25 (P55). */
export function largeWorkflowThreshold(g: ResolvedSizeGuideline): number {
  if (!g.chosen || g.value === "unrestricted") return LARGE_WORKFLOW_AGENT_THRESHOLD
  return SIZE_GUIDELINE_AGENTS[g.value]
}

/** Advice appended to the tool description; undefined for `unrestricted`. */
export function sizeGuidelineAdvice(g: ResolvedSizeGuideline): string | undefined {
  if (g.value === "unrestricted") return undefined
  return (
    `Size guideline (${g.value}): aim for fewer than ${SIZE_GUIDELINE_AGENTS[g.value]} agents per workflow. ` +
    "This is advice, not a cap: when the user's request calls for a different scale, follow the request."
  )
}
