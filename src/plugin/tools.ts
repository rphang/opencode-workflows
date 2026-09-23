// Tool definitions: `workflow` (P01–P06) and `workflow_control` (P50–P52). `workflow_submit` comes
// from src/opencode/submit.ts.

import type { Plugin } from "@opencode/plugin"
import { TOOL_DESCRIPTION } from "../authoring.ts"
import type { WorkflowMeta } from "../types.ts"
import type { ControlInput, WorkflowHost, WorkflowToolInput } from "./host.ts"

export type ToolInfo = Parameters<Parameters<Parameters<Plugin.Context["tool"]["transform"]>[0]>[0]["add"]>[0]

export const WORKFLOW_TOOL_NAME = "workflow"
export const CONTROL_TOOL_NAME = "workflow_control"

/** JSON Schema for the `workflow` tool: Claude Code's WorkflowInput + the `budget` extension. */
export const WORKFLOW_INPUT_SCHEMA = {
  type: "object",
  properties: {
    script: {
      type: "string",
      description: "Inline workflow script. Must begin with `export const meta = { name, description, ... }` as a pure literal.",
    },
    name: { type: "string", description: "Name (meta.name) of a saved or bundled workflow to run." },
    scriptPath: {
      type: "string",
      description:
        "Path to a workflow script on disk (e.g. the scriptPath returned by an earlier call, possibly edited). Takes precedence over script and name.",
    },
    args: { description: "Any JSON value, exposed verbatim to the script as the global `args`. Pass arrays/objects as real JSON, not strings." },
    resumeFromRunId: {
      type: "string",
      description: "runId of an earlier run in this session: completed agent() calls with unchanged inputs return cached results.",
    },
    title: { type: "string", description: "Ignored; the script's meta sets the title." },
    description: { type: "string", description: "Ignored; the script's meta sets the description." },
    budget: {
      type: "number",
      description:
        "Set ONLY when the user explicitly states a token budget for this work; never invent one. Exposed as budget.total, it is a HARD ceiling: once this run's agents have spent that many output+reasoning tokens (agents replayed on resume count 0), further agent() calls throw. Omit it otherwise (budget.total is then null and nothing is capped).",
    },
  },
} as const

export const CONTROL_ACTIONS = ["list", "status", "stop", "stop_agent", "pause", "resume", "save"] as const

export const CONTROL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: [...CONTROL_ACTIONS], description: "What to do." },
    runId: { type: "string", description: "Target run (required for every action except list)." },
    agentIndex: { type: "integer", minimum: 0, description: "stop_agent: the agent's index (#N in status)." },
    name: { type: "string", description: "save: file name for the saved script (default: meta.name)." },
    location: {
      type: "string",
      enum: ["project", "personal"],
      description: "save: project (.opencode/workflows/) or personal (~/.config/opencode/workflows/). Default project.",
    },
  },
  required: ["action"],
} as const

export const CONTROL_TOOL_DESCRIPTION =
  "Manage dynamic workflow runs started with the `workflow` tool. A run's result reaches you ONLY as a task " +
  "notification in this session: after launching, end your turn. Never call this tool (or sleep, or run shell " +
  "commands) to wait for a run to finish; use status/list only when the user asks about progress. status and " +
  "list show progress, never the result. Actions: list (runs of this " +
  "session with per-phase agent counts, tokens and elapsed time), status (one run in detail: every agent, logs, " +
  "not the result), " +
  "stop (stop a whole run; running agents are not counted as failed and restart on resume), stop_agent " +
  "(stop one agent; it counts as failed and its agent() call returns null), pause / resume (stop / restart " +
  "scheduling new agents), save (save a run's script as a reusable /<name> command in the project or personal " +
  "workflows directory). Only use stop/stop_agent/pause/save when the user asks for it."

function text(content: string) {
  return { content }
}

/** One entry of the saved-workflow list in the tool description (P59). */
export interface ListedWorkflow {
  meta: Pick<WorkflowMeta, "name" | "description" | "whenToUse">
  origin: string
}

/**
 * The `workflow` tool description: the static reference, then the size-guideline advice (P70)
 * and the saved/bundled workflows the model can run by `name`, with their whenToUse (P59).
 * Rebuilt on every tool transform pass (ctx.tool.reload), so newly saved workflows appear.
 */
export function workflowToolDescription(input: { saved?: ListedWorkflow[]; sizeAdvice?: string } = {}): string {
  const parts = [TOOL_DESCRIPTION]
  if (input.sizeAdvice) parts.push(input.sizeAdvice)
  if (input.saved?.length) {
    const lines = input.saved.map((w) => {
      const when = w.meta.whenToUse ? ` When to use: ${w.meta.whenToUse}` : ""
      return `- ${w.meta.name} (${w.origin}): ${w.meta.description}.${when}`
    })
    parts.push(`Saved workflows (run one with {name, args}; the user can also type /<name>):\n${lines.join("\n")}`)
  }
  return parts.join("\n\n")
}

export function createWorkflowTool(host: WorkflowHost, description: string = TOOL_DESCRIPTION): ToolInfo {
  return {
    name: WORKFLOW_TOOL_NAME,
    description,
    input: WORKFLOW_INPUT_SCHEMA as any,
    options: { codemode: false },
    execute: async (input: any, tctx) => {
      const agent = typeof tctx.agent === "string" && tctx.agent ? tctx.agent : undefined
      const out = await host.launch((input ?? {}) as WorkflowToolInput, String(tctx.sessionID), { agent })
      return { content: JSON.stringify(out, null, 2), metadata: { ...out } }
    },
  }
}

export function createControlTool(host: WorkflowHost): ToolInfo {
  return {
    name: CONTROL_TOOL_NAME,
    description: CONTROL_TOOL_DESCRIPTION,
    input: CONTROL_INPUT_SCHEMA as any,
    options: { codemode: false },
    execute: async (input: any, tctx) => {
      try {
        return text(await host.control((input ?? {}) as ControlInput, String(tctx.sessionID)))
      } catch (e) {
        return text(`workflow_control failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
  }
}
