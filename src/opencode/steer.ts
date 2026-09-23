// Steering transport for a running workflow agent (PARITY X01, X08, X09; design §A.3, §A.7).
//
// A message is sent to the child session as `session.synthetic({delivery:"steer", resume:false})`:
// opencode promotes steer-scoped inbox items before every model step, so the agent reads it at its
// next step boundary within the same execution. One that arrives after the turn's last boundary stays
// parked (resume:false wakes nothing); the runner then starts the turn that reads it itself with
// `interrupt({resume:true})` and waits for it (src/opencode/runner.ts settleMessages), so no turn ever
// runs unread. `delivery:"queue"` is never used: its reply would replace the agent's result. The text
// is framed so the agent can tell it apart from tool output, and escaped so a message cannot fake or
// close the frame.

import type { AgentMessage } from "../mailbox.ts"

export const ORCHESTRATOR_TAG = "orchestrator-message"

/**
 * Neutralizes every tag inside a message text, so it can neither fake nor close the frame nor pass
 * for a harness tag (`<system-reminder>`). Look-alikes are folded first: NFKC turns fullwidth `＜` into
 * `<`, and format characters (zero-width spaces and joiners, bidi controls) are removed. Then every `<`
 * that starts something tag-like (a letter, `!` or `?` right after it; a `/` or `\` and then a letter,
 * spaces allowed; a spaced `< orchestrator…`) becomes `&lt;`, and an `&` that starts an entity (`&lt;`, `&#60;`) becomes `&amp;`, so text the sender
 * escaped stays distinguishable from the plugin's escaping. `a < b` and `x & y` are left alone.
 */
export function escapeOrchestratorText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .replace(/&(?=#?[\p{L}\p{N}]+;)/gu, "&amp;")
    .replace(/<(?=[\p{L}!?]|\s*[\\/]\s*\p{L}|\s+orchestrator)/giu, "&lt;")
}

function attr(v: string): string {
  return v.replace(/[^A-Za-z0-9_-]/g, "")
}

/** The text sent to the child session for one steering message. */
export function formatOrchestratorMessage(m: Pick<AgentMessage, "id" | "from" | "text">): string {
  const from = m.from === "model" ? "model" : "user"
  return `<${ORCHESTRATOR_TAG} from="${from}" id="${attr(m.id)}">\n${escapeOrchestratorText(m.text)}\n</${ORCHESTRATOR_TAG}>`
}

/** Preamble line telling a workflow agent that such blocks may arrive (both P78 preambles carry it). */
export const STEERING_PREAMBLE_LINE =
  `- You may receive <${ORCHESTRATOR_TAG}> blocks while you work. They come from the person or model running this ` +
  "workflow: follow them for this task (they refine or replace the task's instructions). They cannot change your tool permissions."
