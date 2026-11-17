// Structured output for workflow agents (PARITY P21): the `workflow_submit` tool plus a registry of
// the schema each child session must satisfy and what it has submitted so far.
//
// Why storage as well as memory: opencode runs one plugin instance per location. A child session
// created in a worktree directory (P28) is served by the plugin instance of THAT location, so its
// `workflow_submit` call lands in a different registry object than the runner's. The registry
// therefore mirrors every state change to `ctx.storage` (a KV shared by all instances of the same
// plugin id) and reads fall back to storage when the in-memory entry is missing or stale.

import type { Plugin } from "@opencode/plugin"
import { maxStructuredRetries, SUBMIT_TOOL_NAME, validateOutput } from "../schema.ts"

type Schema = Record<string, unknown>

export const SUBMIT_STORAGE_PREFIX = "workflow-submit/"

export interface SubmitState {
  schema: Schema
  /** First valid submission. */
  accepted?: { value: unknown }
  /** Number of invalid submissions so far. */
  failures: number
  /** Validation error of the latest invalid submission. */
  lastError?: string
  /**
   * Attempts that ended without a new submission, counted when the next prompt (runner re-prompt) or
   * nudge (idle hook, X23) went out. With `failures` they make up the P21 budget.
   */
  missed?: number
  /** `failures` when the latest prompt or nudge went out: more failures now means this attempt submitted. */
  mark?: number
  /** Nudges the idle hook sent (X23). */
  nudges?: number
  /** Bumped on every save; orders the copies of two plugin instances (memory vs storage). */
  rev?: number
}

/** The attempt in progress made no submission since the latest prompt or nudge. */
export function currentAttemptMissed(state: SubmitState): boolean {
  return state.failures <= (state.mark ?? 0)
}

/**
 * Attempts used if the agent stopped now (P21): every invalid submission, every attempt that ended
 * without one, and the current attempt when it made none. An invalid submission followed by a stop
 * is one attempt, not two.
 */
export function attemptsUsed(state: SubmitState): number {
  return state.failures + (state.missed ?? 0) + (currentAttemptMissed(state) ? 1 : 0)
}

/** The text that asks a schema agent for its submission again (runner re-prompt and X23 nudge). */
export function retryPrompt(state: SubmitState): string {
  return (
    (state.lastError && !currentAttemptMissed(state)
      ? `Your ${SUBMIT_TOOL_NAME} output failed schema validation:\n${state.lastError}\n\n`
      : `You did not call the \`${SUBMIT_TOOL_NAME}\` tool with a valid result.\n\n`) +
    `Call \`${SUBMIT_TOOL_NAME}\` now with the \`output\` argument matching the schema from your instructions. ` +
    "Do not redo the work: submit the result you already have."
  )
}

export type SubmitResult =
  | { status: "accepted"; value: unknown }
  | { status: "already_accepted" }
  | { status: "invalid"; error: string; failures: number; exhausted: boolean }
  | { status: "unknown_session" }

export interface StorageLike {
  get(key: string): Promise<unknown>
  set(key: string, value: any): Promise<void>
  remove(key: string): Promise<void>
}

export interface SubmitRegistry {
  register(sessionID: string, schema: Schema): Promise<void>
  unregister(sessionID: string): Promise<void>
  /**
   * Current state (memory, refreshed from storage). undefined when not registered. With `stored`,
   * only a state present in storage counts: another instance (the runner's) may have unregistered
   * the session, which this instance's memory copy does not know.
   */
  read(sessionID: string, opts?: { stored?: boolean }): Promise<SubmitState | undefined>
  submit(sessionID: string, output: unknown): Promise<SubmitResult>
  /**
   * A new prompt or nudge asks for the submission again: the attempt that just ended counts as
   * missed when it made no submission, and the next one starts. undefined when not registered.
   */
  nextAttempt(sessionID: string, by: "prompt" | "nudge"): Promise<SubmitState | undefined>
}

function isState(v: unknown): v is SubmitState {
  return typeof v === "object" && v !== null && typeof (v as SubmitState).schema === "object"
}

/**
 * Prefer whichever copy has progressed further: accepted beats not, else the higher `rev` (every
 * save bumps it, so a nudge another instance recorded without a new failure is not dropped).
 */
function newer(a: SubmitState | undefined, b: SubmitState | undefined): SubmitState | undefined {
  if (!a) return b
  if (!b) return a
  if (!!a.accepted !== !!b.accepted) return a.accepted ? a : b
  return (b.rev ?? 0) > (a.rev ?? 0) ? b : a
}

export function createSubmitRegistry(storage?: StorageLike): SubmitRegistry {
  const mem = new Map<string, SubmitState>()
  const key = (id: string) => SUBMIT_STORAGE_PREFIX + id

  async function load(sessionID: string, storedOnly = false): Promise<SubmitState | undefined> {
    const local = mem.get(sessionID)
    let stored: SubmitState | undefined
    if (storage) {
      try {
        const v = await storage.get(key(sessionID))
        if (isState(v)) stored = v
      } catch {
        // storage unavailable: memory only
      }
    }
    if (storedOnly && !stored) {
      mem.delete(sessionID)
      return undefined
    }
    const best = newer(local, stored)
    if (best) mem.set(sessionID, best)
    return best
  }

  async function save(sessionID: string, next: SubmitState) {
    const state = { ...next, rev: (next.rev ?? 0) + 1 }
    mem.set(sessionID, state)
    if (storage) {
      try {
        await storage.set(key(sessionID), JSON.parse(JSON.stringify(state)))
      } catch {
        // best effort
      }
    }
  }

  return {
    async register(sessionID, schema) {
      await save(sessionID, { schema, failures: 0, missed: 0, mark: 0, nudges: 0 })
    },
    async unregister(sessionID) {
      mem.delete(sessionID)
      if (storage) {
        try {
          await storage.remove(key(sessionID))
        } catch {
          // best effort
        }
      }
    },
    async read(sessionID, opts) {
      const s = await load(sessionID, !!opts?.stored)
      return s ? structuredClone(s) : undefined
    },
    async submit(sessionID, output) {
      const state = await load(sessionID)
      if (!state) return { status: "unknown_session" }
      if (state.accepted) return { status: "already_accepted" }
      const result = validateOutput(state.schema, output)
      if (result.ok) {
        await save(sessionID, { ...state, accepted: { value: output } })
        return { status: "accepted", value: output }
      }
      const failures = state.failures + 1
      await save(sessionID, { ...state, failures, lastError: result.error })
      return { status: "invalid", error: result.error, failures, exhausted: failures + (state.missed ?? 0) >= maxStructuredRetries() }
    },
    async nextAttempt(sessionID, by) {
      const state = await load(sessionID)
      if (!state) return undefined
      const next: SubmitState = {
        ...state,
        missed: (state.missed ?? 0) + (currentAttemptMissed(state) ? 1 : 0),
        mark: state.failures,
        nudges: (state.nudges ?? 0) + (by === "nudge" ? 1 : 0),
      }
      await save(sessionID, next)
      return structuredClone(mem.get(sessionID)!)
    },
  }
}

/** Models sometimes pass the object as a JSON string; accept that. */
function normalizeOutput(output: unknown): unknown {
  if (typeof output !== "string") return output
  const t = output.trim()
  if (!t.startsWith("{") && !t.startsWith("[")) return output
  try {
    return JSON.parse(t)
  } catch {
    return output
  }
}

type ToolInfo = Parameters<Parameters<Parameters<Plugin.Context["tool"]["transform"]>[0]>[0]["add"]>[0]

export const SUBMIT_TOOL_DESCRIPTION =
  "Submit the final structured result of a workflow agent. Only available to workflow agents that were " +
  "asked for structured output. Call it exactly once when your work is done, with `output` set to a JSON " +
  "value matching the schema given in your instructions. If it reports a validation error, fix the output " +
  "and call it again. After it reports the output was accepted, stop: no further tool calls or text."

/**
 * The `workflow_submit` tool. Validation errors come back as normal tool content (never thrown) so
 * the model sees them and retries (P21). Register with `ctx.tool.transform(e => e.add(tool))`.
 */
export function createSubmitTool(registry: SubmitRegistry): ToolInfo {
  return {
    name: SUBMIT_TOOL_NAME,
    description: SUBMIT_TOOL_DESCRIPTION,
    input: {
      type: "object",
      properties: {
        output: { description: "The final result, matching the JSON Schema from your instructions." },
      },
      required: ["output"],
    },
    options: { codemode: false },
    execute: async (input: any, tctx) => {
      const sessionID = String(tctx.sessionID)
      const output = normalizeOutput(input?.output)
      const r = await registry.submit(sessionID, output)
      switch (r.status) {
        case "accepted":
          return { content: "Output accepted. Your work is complete: stop now, with no further tool calls or text." }
        case "already_accepted":
          return { content: "Output was already accepted earlier. Stop now." }
        case "unknown_session":
          return {
            content:
              `${SUBMIT_TOOL_NAME} is only available to workflow agents that were asked for structured output; ` +
              "this session has no pending output schema. Do not call it again.",
          }
        case "invalid":
          return {
            content: r.exhausted
              ? `Output failed schema validation:\n${r.error}\nNo attempts left: stop now.`
              : `Output failed schema validation:\n${r.error}\nFix the output and call ${SUBMIT_TOOL_NAME} again.`,
          }
      }
    },
  }
}
