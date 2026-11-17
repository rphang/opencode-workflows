// Tool definitions: `workflow` (P01–P06), the freeform `workflow_script` (X24) and `workflow_control`
// (P50–P52). `workflow_submit` comes from src/opencode/submit.ts.

import type { Plugin } from "@opencode/plugin"
import { TOOL_DESCRIPTION } from "../authoring.ts"
import { MAX_MESSAGE_CHARS } from "../mailbox.ts"
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

export const CONTROL_ACTIONS = ["list", "status", "stop", "stop_agent", "pause", "resume", "message", "save", "result"] as const

export const CONTROL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: [...CONTROL_ACTIONS], description: "What to do." },
    runId: { type: "string", maxLength: 200, description: "Target run (required for every action except list)." },
    agentIndex: { type: "integer", minimum: 0, description: "stop_agent / message: the agent's index (#N in status)." },
    label: { type: "string", maxLength: 200, description: "message: target the one agent with exactly this label." },
    phase: { type: "string", maxLength: 200, description: "message: target every running or queued agent of this phase." },
    all: { type: "boolean", description: "message: target every running or queued agent of the run." },
    text: {
      type: "string",
      maxLength: MAX_MESSAGE_CHARS,
      description: "message: the instruction to send (at most 4000 characters). Give exactly one target: agentIndex, label, phase or all.",
    },
    urgent: {
      type: "boolean",
      description:
        "message: also interrupt the agent's current step so it reads the message right away (that step's tokens are lost). Default false.",
    },
    agent: {
      type: "string",
      maxLength: 200,
      description: 'result: one agent, by index ("3" or "#3") or exact label, for its full return value. Omit it (or "") to list every agent.',
    },
    offset: {
      type: "integer",
      minimum: 0,
      description: "result: where the next page starts; use the value the previous page's footer gives. Default 0.",
    },
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
  "scheduling new agents), message (send an instruction to a running agent of your run without restarting it; it is " +
  "read at the agent's next step boundary; a queued agent gets it with its first prompt), save (save a run's script " +
  "as a reusable /<name> command in the project or personal workflows directory), result (what each agent of a " +
  "finished run returned, for after its task notification: every agent, failed ones first, with a preview or its " +
  `error; agent:"<index or label>" for one agent's full return value; offset for the next page. While the run is ` +
  "going it only repeats the status note). " +
  "Only use stop/stop_agent/pause/save when the user asks for it, and message only when the user asks you to redirect agents."

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
    execute: async (input: any, tctx) => launchResult(host, (input ?? {}) as WorkflowToolInput, tctx),
  }
}

/** X24: launch a NEW inline script as raw text (freeform tool input, opencode 2.3.0). */
export const SCRIPT_TOOL_NAME = "workflow_script"

/**
 * Exactly one required string property: opencode refuses a freeform tool otherwise (upstream
 * packages/ai ToolDefinition.freeformField). Models without the freeform capability get it as an
 * ordinary JSON tool; either way execute receives `{script}`.
 */
export const SCRIPT_INPUT_SCHEMA = {
  type: "object",
  properties: { script: { type: "string" } },
  required: ["script"],
} as const

export const SCRIPT_TOOL_DESCRIPTION =
  "Launch a NEW dynamic workflow from inline script text. Equivalent to the `workflow` tool called with only " +
  "{script}; all of its rules apply: explicit user opt-in only, end your turn after launching, and the result " +
  "arrives as a task notification. Send the script source exactly as written, starting with " +
  "`export const meta = {...}`, with no code fence and no JSON or other wrapper. For args, name, scriptPath, " +
  "resumeFromRunId or a user-stated budget, use the `workflow` tool."

export const SCRIPT_EXTRA_KEY_ERROR =
  "workflow_script takes only the script; use the workflow tool for args, name, scriptPath, resumeFromRunId or budget"

const WRAPPING_FENCE = /^\s*```[\w.+-]*[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```\s*$/

/** The text inside a single code fence that wraps the whole input; any other text unchanged. */
export function stripWrappingFence(text: string): string {
  const m = WRAPPING_FENCE.exec(text)
  return m ? m[1]! : text
}

async function launchResult(host: WorkflowHost, input: WorkflowToolInput, tctx: { sessionID: unknown; agent?: unknown }) {
  const agent = typeof tctx.agent === "string" && tctx.agent ? tctx.agent : undefined
  const out = await host.launch(input, String(tctx.sessionID), { agent })
  return { content: JSON.stringify(out, null, 2), metadata: { ...out } }
}

/**
 * `workflow_script` (X24). Its permission key is `workflow` (`options.permission`; opencode hides a tool
 * whose key is wholly denied), so every deny of the `workflow` tool (child sessions P60, user and agent
 * rules) hides this one too.
 */
export function createScriptTool(host: WorkflowHost): ToolInfo {
  return {
    name: SCRIPT_TOOL_NAME,
    description: SCRIPT_TOOL_DESCRIPTION,
    input: SCRIPT_INPUT_SCHEMA as any,
    freeform: { type: "text" },
    options: { codemode: false, permission: WORKFLOW_TOOL_NAME },
    execute: async (input: any, tctx) => {
      const given: Record<string, unknown> = typeof input === "string" ? { script: input } : input && typeof input === "object" ? input : {}
      // A JSON call (a model without freeform input) can carry more keys: they belong to `workflow`.
      const refuse = (error: string) => {
        const out = { status: "async_launched", taskType: "local_workflow", error }
        return { content: JSON.stringify(out, null, 2), metadata: { ...out } }
      }
      if (Object.keys(given).some((k) => k !== "script" && given[k] !== undefined && given[k] !== null)) return refuse(SCRIPT_EXTRA_KEY_ERROR)
      const script = typeof given.script === "string" ? stripWrappingFence(given.script) : ""
      if (!script.trim()) return refuse("workflow_script needs the script source as its input (starting with `export const meta = {...}`)")
      return launchResult(host, { script }, tctx)
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
