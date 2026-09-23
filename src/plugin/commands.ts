// Slash commands: /workflows (P50), /workflow-authoring (P58), and one /<name> per saved or bundled
// workflow (P53, P54; /deep-research is the bundled one).
//
// /<name> <args> prompts the session to call the `workflow` tool with {name, args}. This mirrors how
// opencode's own /init and /review commands work (a session.prompt). Going through the tool keeps
// the parent's permission rules for `workflow` in force (P56). The launch output and, later, the
// completion notification land in the model's context, as with a model-initiated run. The rest of
// the command line is handed to the model, which shapes `args` the way Claude Code does (P53): as
// structured JSON (array/object/number) when the workflow's description or whenToUse says it
// expects that, otherwise as the line itself (a string). An empty line omits args.
//
// /workflows msg <runId> <target> <text> (and msg! for urgent) steers a running agent (X01, X05,
// X08). <target> is an index (3 or #3), @phase or @"multi word phase", * (every running or queued
// agent), or an exact label (quoted when it has spaces).

import type { Plugin } from "@opencode/plugin"
import { AUTHORING_REFERENCE } from "../authoring.ts"
import type { MessageTarget } from "../types.ts"
import { listWorkflows, type RegistryOptions } from "../registry.ts"
import type { WorkflowHost } from "./host.ts"

export type CommandDefinition = Parameters<Parameters<Parameters<Plugin.Context["command"]["transform"]>[0]>[0]["add"]>[0]
type Invocation = Parameters<CommandDefinition["execute"]>[0]

export const WORKFLOWS_COMMAND = "workflows"
export const AUTHORING_COMMAND = "workflow-authoring"
const RESERVED = new Set([WORKFLOWS_COMMAND, AUTHORING_COMMAND])
const COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export interface CommandSession {
  synthetic: (input: { sessionID: string; text: string; description?: string; resume?: boolean }) => Promise<unknown>
  prompt: (input: any) => Promise<unknown>
}

export interface CommandDeps {
  host: WorkflowHost
  session: CommandSession
  cwd: string
  registryOptions?: RegistryOptions
  /** Re-runs the command transforms (ctx.command.reload). */
  reload: () => Promise<void>
}

/** Instruction sent to the model when the user runs /<name> <args>. */
export function workflowCommandPrompt(name: string, description: string, args: string, whenToUse?: string): string {
  const out = [`The user ran the /${name} command, which launches the saved workflow "${name}" (${description}).`]
  if (whenToUse) out.push(`When to use / expected input: ${whenToUse}`)
  out.push("This is explicit opt-in: call the `workflow` tool now.")
  if (!args) {
    out.push("The user gave no input, so omit args. Use exactly this input:", "", JSON.stringify({ name }))
  } else {
    out.push(
      "The rest of the command line (the user's input for the workflow) was:",
      "",
      args,
      "",
      "Pass that input as `args`. When the workflow expects structured input (its description or when-to-use asks for a " +
        "list, numbers or named fields), pass args as structured JSON (an array, object or number) so the script can call " +
        'array and object methods on it directly, e.g. "on issues 1024, 1025 and 1030" → [1024, 1025, 1030]. Otherwise ' +
        "pass the line unchanged as a string, i.e. this input:",
      "",
      JSON.stringify({ name, args }),
    )
  }
  out.push(
    "",
    "Then tell the user the run started (with its runId) and end your turn. The result arrives later as a task notification; " +
      "do not call workflow_control status, sleep, or run shell commands to wait for it.",
  )
  return out.join("\n")
}

async function show(deps: CommandDeps, sessionID: string, text: string, description: string) {
  try {
    await deps.session.synthetic({ sessionID, text, description, resume: false })
  } catch {
    // No way to render text: surface it the way other v2 plugins do, as a command error.
    throw new Error(text)
  }
}

export const MESSAGE_USAGE =
  "Usage: /workflows msg <runId> <target> <text>\n" +
  '  <target>: an agent index (3 or #3), an exact label ("quoted" when it has spaces), @phase (or @"multi word phase") ' +
  "for every running or queued agent of that phase, or * for every running or queued agent.\n" +
  "  /workflows msg! … is urgent: it also interrupts the agent's current step (that step's tokens are lost)."

/** Reads one token: a "quoted string" (the quotes are removed) or a run of non-space characters. */
function takeToken(s: string): { token: string; rest: string; quoted: boolean } | undefined {
  const t = s.trimStart()
  if (!t) return undefined
  if (t.startsWith('"')) {
    const end = t.indexOf('"', 1)
    if (end < 0) return undefined
    return { token: t.slice(1, end), rest: t.slice(end + 1), quoted: true }
  }
  const m = /^\S+/.exec(t)!
  return { token: m[0], rest: t.slice(m[0].length), quoted: false }
}

/** Parses the rest of a `/workflows msg` line: <runId> <target> <text…>. */
export function parseMessageArgs(line: string): { runId: string; target: MessageTarget; text: string } | { error: string } {
  const run = takeToken(line)
  if (!run || run.quoted) return { error: MESSAGE_USAGE }
  let rest = run.rest.trimStart()
  let target: MessageTarget
  if (rest.startsWith("@")) {
    const t = takeToken(rest.slice(1))
    if (!t || !t.token) return { error: MESSAGE_USAGE }
    target = { kind: "phase", phase: t.token }
    rest = t.rest
  } else {
    const t = takeToken(rest)
    if (!t) return { error: MESSAGE_USAGE }
    if (!t.quoted && t.token === "*") target = { kind: "all" }
    else if (!t.quoted && /^#?\d+$/.test(t.token)) target = { kind: "index", index: Number.parseInt(t.token.replace("#", ""), 10) }
    else if (t.token) target = { kind: "label", label: t.token }
    else return { error: MESSAGE_USAGE }
    rest = t.rest
  }
  const text = rest.trim()
  if (!text) return { error: MESSAGE_USAGE }
  return { runId: run.token, target, text }
}

/** Adds every command to `editor`. Called on each transform pass, so saved workflows are re-read. */
export function addCommands(editor: { add(d: CommandDefinition): void }, deps: CommandDeps): void {
  editor.add({
    name: WORKFLOWS_COMMAND,
    description:
      "list dynamic workflow runs (/workflows <runId> for one run's agents; /workflows msg <runId> <#n|@phase|*|label> <text> to message a running agent)",
    execute: async (input: Invocation) => {
      const arg = String(input.prompt?.text ?? "").trim()
      const sessionID = String(input.sessionID)
      const first = arg.split(/\s+/)[0] ?? ""
      let text: string
      if (first === "msg" || first === "msg!") {
        const parsed = parseMessageArgs(arg.slice(first.length))
        text =
          "error" in parsed
            ? parsed.error
            : await deps.host.message({ ...parsed, urgent: first === "msg!", from: "user", via: "command" }, sessionID)
      } else {
        text = arg ? await deps.host.statusText(first, sessionID) : await deps.host.listText(sessionID)
      }
      await show(deps, sessionID, text, "/workflows")
      void deps.reload().catch(() => {})
    },
  })

  editor.add({
    name: AUTHORING_COMMAND,
    description: "load the dynamic workflow authoring reference into this session",
    execute: async (input: Invocation) => {
      const sessionID = String(input.sessionID)
      await deps.session.synthetic({
        sessionID,
        text: `Reference for writing \`workflow\` tool scripts. Loading it does not itself authorize running a workflow.\n\n${AUTHORING_REFERENCE}`,
        description: "/workflow-authoring",
        resume: false,
      })
      const text = String(input.prompt?.text ?? "").trim()
      if (text) await deps.session.prompt({ ...input.prompt, sessionID, text, delivery: input.delivery })
    },
  })

  let saved: ReturnType<typeof listWorkflows> = []
  try {
    saved = listWorkflows(deps.cwd, deps.registryOptions)
  } catch {
    saved = []
  }
  for (const wf of saved) {
    const name = wf.meta.name
    if (RESERVED.has(name) || !COMMAND_NAME.test(name)) continue
    editor.add({
      name,
      description: `${wf.meta.description} (${wf.origin} workflow)${wf.meta.whenToUse ? `. When to use: ${wf.meta.whenToUse}` : ""}`,
      execute: async (input: Invocation) => {
        const sessionID = String(input.sessionID)
        const args = String(input.prompt?.text ?? "").trim()
        await deps.session.prompt({
          ...input.prompt,
          sessionID,
          text: workflowCommandPrompt(name, wf.meta.description, args, wf.meta.whenToUse),
          delivery: input.delivery,
        })
      },
    })
  }
}
