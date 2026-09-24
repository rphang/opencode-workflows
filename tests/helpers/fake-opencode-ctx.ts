// Fake opencode v2 plugin Context for runner unit tests. Shapes mirror what opencode 2.0.15
// returned live (see docs/OPENCODE-API-NOTES.md):
//
//   session.create -> Session.Info {id, projectID, model?, cost, tokens:{input,output,reasoning,
//                     cache:{read,write}}, time, title, metadata, permissions, location}
//   session.prompt -> {id, sessionID, time, type:"user", payload:{text}, delivery:"steer"}
//   session.wait   -> undefined once the session is idle
//   session.get    -> Session.Info with `outcome: "succeeded"|"failed"|"interrupted"` after a turn
//   session.context-> [{type:"user", text}, {type:"assistant", content:[{type:"reasoning"}|
//                     {type:"text", text}|{type:"tool", ...}], error?, tokens, cost},
//                     {type:"idle", outcome}]   (a failed turn may have NO assistant message)
//   session.interrupt -> {interrupted: true}; with {resume:true} the session carries on with a
//                     successor turn that reads the inbox (verified live, design §A.3). On an IDLE
//                     session it interrupts nothing, but {resume:true} still wakes it when a steer
//                     item is pending (opencode: execution.interrupt → nextPromotable → wake)
//   session.synthetic -> {id, sessionID, type:"synthetic", delivery}. Steering model (verified live
//                     on 2.0.15, design §A.3): the item waits in the session inbox and becomes a
//                     context message {id: <that id>, type:"synthetic", text} at the next step
//                     boundary of the running turn (the inbox is drained before every step). An item
//                     that arrives after the last boundary, or while the session is idle, starts a
//                     successor turn when resume:true (after `successorDelayMs`) and stays parked
//                     otherwise. session.wait covers a successor already scheduled (awaitIdle
//                     re-checks); an item admitted after wait() resolved needs another wait().
//   worktree.create -> {directory}; worktree.remove -> undefined
//   model.list -> {location, data: ModelInfo[] (variants: [{id}])}
//
// Usage:
//   const fake = createFakeCtx({ respond: ({ text, turn }) => ({ text: "hello" }) })
//   const runner = createOpencodeRunner(fake.ctx as any, { parentSessionID: fake.parentID, runId: "r1", git: fake.git })

import type { Tool } from "@opencode/schema/tool"

export interface FakeTurn {
  /** Final assistant text for this turn (omit for no text part). */
  text?: string
  /** Values the model passes to workflow_submit during this turn, in order. */
  submit?: unknown[]
  /** Session outcome after this turn. Default "succeeded". */
  outcome?: "succeeded" | "failed" | "interrupted"
  /** Structured error on the assistant message (API errors). */
  error?: { type: string; message: string }
  /** When true, no assistant message is recorded at all (live: bad model -> only an idle entry). */
  noAssistant?: boolean
  tokens?: Partial<{ input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }>
  cost?: number
  /** Turn never finishes on its own; only interrupt() ends it. */
  hang?: boolean
  delayMs?: number
  /** Marks the session's directory (worktree) dirty. */
  writeFile?: boolean
  /** Model steps in this turn (default 1). The inbox is drained before each step. */
  steps?: number
  /** Duration of each step. */
  stepDelayMs?: number
  /** Called at the start of each step, after the inbox was drained (0-based). */
  onStep?: (step: number) => void | Promise<void>
  /** Called after the last step, before the turn ends: a message sent here misses this turn. */
  afterSteps?: () => void | Promise<void>
  /** The session's model after this turn (an opencode fallback mid-run); get() reports it from then on. */
  model?: { providerID: string; id: string; variant?: string }
  /** Final text computed when the turn ends (sees messages delivered during it). Overrides `text`. */
  textFn?: (session: FakeSession) => string
  /** Called after this turn's `submit` values went through workflow_submit, before the turn ends. */
  afterSubmit?: () => void | Promise<void>
}

export interface TurnInput {
  sessionID: string
  text: string
  /** 0-based turn number within this session. */
  turn: number
  session: FakeSession
  /** A turn opencode started by itself to read inbox items (resume:true), not a prompt. */
  successor?: boolean
}

export type Responder = (input: TurnInput) => FakeTurn | Promise<FakeTurn>

export interface FakeSession {
  info: Record<string, any>
  messages: any[]
  busy?: Promise<void>
  finishTurn?: (outcome: "succeeded" | "failed" | "interrupted") => void
  turns: number
  /** Steer items not yet delivered (session.synthetic). */
  inbox: InboxItem[]
  /** Steer items delivered so far (they are also context messages). */
  delivered: InboxItem[]
  /** A turn is executing (between its start and its idle marker). */
  running?: boolean
  /** interrupt() while running: stop at the next step. */
  interruptFlag?: { resume: boolean }
  /** The last turn was interrupted with resume:true: a successor turn follows. */
  resumeAfterInterrupt?: boolean
  successorScheduled?: boolean
}

export interface InboxItem {
  id: string
  text: string
  resume: boolean
  delivery: string
  description?: string
  metadata?: Record<string, unknown>
}

export interface FakeModel {
  id: string
  modelID?: string
  providerID: string
  variants?: string[]
  enabled?: boolean
  released?: number
}

export interface FakeCtxOptions {
  respond?: Responder
  parent?: Record<string, any>
  models?: FakeModel[]
  /** Tool to run for `submit` entries (normally createSubmitTool(registry)). Settable later via fake.setSubmitTool. */
  submitTool?: { execute: (input: any, ctx: any) => Promise<Tool.Result> }
  worktreeCreateError?: string
  createError?: string
  getParentError?: string
  projectID?: string
  directory?: string
  /** Agents known to ctx.agent.get (default DEFAULT_AGENTS). */
  agents?: FakeAgent[]
  /** Delay before a resume:true successor turn starts (default 5 ms). */
  successorDelayMs?: number
  /** Never start successor turns (a steer that misses the running turn stays orphaned). */
  noSuccessor?: boolean
  /** interrupt({resume:true}) on an idle session does not wake it (a wake that never delivers). */
  ignoreWake?: boolean
  /** session.synthetic returns no id (the delivery cannot be verified in context()). */
  syntheticNoId?: boolean
  /**
   * The model a created child actually gets, from the requested one (default: the requested one with
   * variant "default"); undefined = no model (get() shows none, like opencode's default model).
   */
  childModel?: (requested: any) => { providerID: string; id: string; variant?: string } | undefined
}

export interface FakeAgent {
  id: string
  mode: "subagent" | "primary" | "all"
  permissions: { action: string; resource: string; effect: "allow" | "deny" | "ask" }[]
}

/** Mirrors opencode 2.0.15's built-ins: build/plan are primary (plan denies edit), explore/general are subagents. */
export const DEFAULT_AGENTS: FakeAgent[] = [
  { id: "build", mode: "primary", permissions: [] },
  {
    id: "plan",
    mode: "primary",
    permissions: [
      { action: "question", resource: "*", effect: "allow" },
      { action: "edit", resource: "*", effect: "deny" },
      { action: "edit", resource: "/home/u/.opencode/plan/*", effect: "allow" },
    ],
  },
  { id: "explore", mode: "subagent", permissions: [{ action: "edit", resource: "*", effect: "deny" }] },
  { id: "general", mode: "subagent", permissions: [] },
]

const PARENT_ID = "ses_parent0000000000000000000"

export const DEFAULT_MODELS: FakeModel[] = [
  { id: "gpt-5.4-mini", providerID: "openai", variants: ["none", "low", "medium", "high", "xhigh"], released: 3 },
  { id: "gpt-5.4-mini-fast", modelID: "gpt-5.4-mini", providerID: "openai", variants: ["none", "low", "medium", "high", "xhigh"], released: 3 },
  { id: "gpt-5", providerID: "openai", variants: ["minimal", "low", "medium", "high"], released: 2 },
  { id: "claude-haiku-4-5", providerID: "anthropic", variants: ["high", "max"], released: 2 },
  { id: "claude-haiku-4", providerID: "anthropic", variants: [], released: 1 },
  { id: "mimo-v2.6-flash-free", providerID: "opencode", variants: [], released: 1 },
]

function modelInfo(m: FakeModel) {
  return {
    id: m.id,
    modelID: m.modelID ?? m.id,
    providerID: m.providerID,
    name: m.id,
    capabilities: {},
    variants: (m.variants ?? []).map((id) => ({ id })),
    time: { released: m.released ?? 0 },
    cost: [],
    status: "active",
    enabled: m.enabled ?? true,
    limit: { context: 1000, output: 100 },
  }
}

export function createFakeCtx(opts: FakeCtxOptions = {}) {
  const projectID = opts.projectID ?? "c5e10c0c9e7101b2ebb26df6bb5168d3292fd570"
  const directory = opts.directory ?? "C:\\proj"
  const respond: Responder = opts.respond ?? (() => ({ text: "ok" }))
  let submitTool = opts.submitTool
  const sessions = new Map<string, FakeSession>()
  const storage = new Map<string, unknown>()
  const dirty = new Set<string>()
  const calls = {
    create: [] as any[],
    prompt: [] as { sessionID: string; text: string }[],
    interrupt: [] as any[],
    wait: [] as any[],
    worktreeCreate: [] as any[],
    worktreeRemove: [] as any[],
    modelList: 0,
    parentGet: 0,
    agentGet: [] as string[],
    submitResults: [] as { sessionID: string; result: Tool.Result }[],
    update: [] as any[],
    synthetic: [] as any[],
  }
  /** permission.hook("evaluate", cb) registrations (opencode runs them on every rule evaluation). */
  const permissionHooks: { name: string; cb: (event: any) => unknown }[] = []
  let seq = 0

  const parentInfo = {
    id: PARENT_ID,
    projectID,
    model: { id: "gpt-5.4-mini", providerID: "openai", variant: "default" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
    title: "parent",
    location: { directory },
    ...opts.parent,
  }
  sessions.set(PARENT_ID, { info: parentInfo, messages: [], turns: 0, inbox: [], delivered: [] })

  function need(sessionID: string): FakeSession {
    const s = sessions.get(sessionID)
    if (!s) throw new Error(`Session not found: ${sessionID}`)
    return s
  }

  /** Promotes every inbox item to a context message (what opencode does before each model step). */
  function drain(s: FakeSession): InboxItem[] {
    const items = s.inbox.splice(0)
    for (const it of items) {
      s.messages.push({ id: it.id, time: { created: 2 }, type: "synthetic", text: it.text, ...(it.description ? { description: it.description } : {}) })
      s.delivered.push(it)
    }
    return items
  }

  /** resume:true: opencode wakes the idle session and runs a successor turn over the inbox. */
  function scheduleSuccessor(s: FakeSession) {
    if (opts.noSuccessor || s.successorScheduled) return
    s.successorScheduled = true
    setTimeout(() => {
      s.successorScheduled = false
      if (!s.inbox.length && !s.resumeAfterInterrupt) return
      const turn = s.turns++
      const prev = s.busy ?? Promise.resolve()
      delete s.info.outcome
      s.busy = prev.then(() => runTurn(s, null, turn))
    }, opts.successorDelayMs ?? 5)
  }

  async function runTurn(s: FakeSession, text: string | null, turn: number) {
    s.running = true
    const successor = text === null
    s.resumeAfterInterrupt = false
    const first = drain(s)
    const spec = await respond({ sessionID: s.info.id, text: successor ? first.map((i) => i.text).join("\n\n") : text, turn, session: s, successor })
    if (spec.delayMs) await new Promise((r) => setTimeout(r, spec.delayMs))
    let outcome: "succeeded" | "failed" | "interrupted" = spec.outcome ?? "succeeded"
    for (let i = 0; i < (spec.steps ?? 1); i++) {
      if (i > 0) drain(s)
      await spec.onStep?.(i)
      if (spec.stepDelayMs) await new Promise((r) => setTimeout(r, spec.stepDelayMs))
      if (s.interruptFlag) break
    }
    if (s.interruptFlag) {
      outcome = "interrupted"
      s.resumeAfterInterrupt = s.interruptFlag.resume
      s.interruptFlag = undefined
    }
    if (spec.hang && outcome !== "interrupted") {
      outcome = await new Promise<"succeeded" | "failed" | "interrupted">((resolve) => {
        s.finishTurn = resolve
      })
      s.finishTurn = undefined
    }
    if (outcome !== "interrupted") await spec.afterSteps?.()
    const content: any[] = [{ type: "reasoning", text: "thinking", state: {} }]
    for (const value of spec.submit ?? []) {
      if (!submitTool) throw new Error("fake: submit requested but no submitTool configured")
      const callID = `call_${++seq}`
      const result = await submitTool.execute(
        { output: value },
        {
          sessionID: s.info.id,
          agent: s.info.agent ?? "build",
          messageID: `msg_${seq}`,
          id: callID,
          progress: async () => {},
          signal: new AbortController().signal,
        },
      )
      calls.submitResults.push({ sessionID: s.info.id, result })
      content.push({
        type: "tool",
        id: callID,
        name: "workflow_submit",
        state: {
          status: "completed",
          input: { output: value },
          content: typeof result.content === "string" ? [{ type: "text", text: result.content }] : result.content,
        },
        time: { created: 1 },
      })
    }
    if (spec.afterSubmit && outcome !== "interrupted") await spec.afterSubmit()
    const finalText = spec.textFn ? spec.textFn(s) : spec.text
    if (finalText !== undefined && outcome !== "interrupted") content.push({ type: "text", text: finalText })
    if (spec.writeFile) dirty.add(s.info.location.directory)
    if (spec.model) s.info.model = { ...spec.model }
    const t = spec.tokens ?? {}
    const tokens = {
      input: t.input ?? 100,
      output: t.output ?? 10,
      reasoning: t.reasoning ?? 5,
      cache: { read: t.cacheRead ?? 0, write: t.cacheWrite ?? 0 },
    }
    const cost = spec.cost ?? 0.001
    if (!spec.noAssistant) {
      s.messages.push({
        id: `msg_a${++seq}`,
        time: { created: 1, completed: 2 },
        type: "assistant",
        agent: s.info.agent ?? "build",
        model: s.info.model,
        content,
        finish: outcome === "failed" ? "error" : "stop",
        ...(spec.error ? { error: spec.error } : {}),
        cost,
        tokens,
      })
      if (outcome !== "interrupted") {
        const acc = s.info.tokens
        acc.input += tokens.input
        acc.output += tokens.output
        acc.reasoning += tokens.reasoning
        acc.cache.read += tokens.cache.read
        acc.cache.write += tokens.cache.write
        s.info.cost += cost
      }
    }
    s.messages.push({ id: `msg_i${++seq}`, time: { created: 3 }, type: "idle", outcome })
    s.info.outcome = outcome
    s.info.time.idle = 3
    s.running = false
    if (s.inbox.some((i) => i.resume) || s.resumeAfterInterrupt) scheduleSuccessor(s)
  }

  const ctx = {
    location: { directory, project: { id: projectID, directory, canonical: directory } },
    session: {
      async create(input: any = {}) {
        calls.create.push(input)
        if (opts.createError) throw new Error(opts.createError)
        const id = `ses_child${String(++seq).padStart(4, "0")}`
        const info: Record<string, any> = {
          id,
          projectID,
          ...(() => {
            const m = opts.childModel ? opts.childModel(input.model) : input.model ? { variant: "default", ...input.model } : undefined
            return m ? { model: m } : {}
          })(),
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1, updated: 1 },
          ...(input.title ? { title: input.title } : {}),
          ...(input.agent ? { agent: input.agent } : {}),
          ...(input.metadata ? { metadata: input.metadata } : {}),
          ...(input.permissions ? { permissions: input.permissions } : {}),
          location: input.location ?? { directory },
        }
        sessions.set(id, { info, messages: [], turns: 0, inbox: [], delivered: [] })
        return structuredClone(info)
      },
      async get(input: { sessionID: string }) {
        if (input.sessionID === PARENT_ID) {
          calls.parentGet++
          if (opts.getParentError) throw new Error(opts.getParentError)
        }
        return structuredClone(need(input.sessionID).info)
      },
      async prompt(input: { sessionID: string; text: string }) {
        const s = need(input.sessionID)
        calls.prompt.push({ sessionID: input.sessionID, text: input.text })
        s.messages.push({ id: `msg_u${++seq}`, time: { created: 1 }, text: input.text, type: "user" })
        const turn = s.turns++
        const prev = s.busy ?? Promise.resolve()
        delete s.info.outcome
        s.busy = prev.then(() => runTurn(s, input.text, turn))
        return {
          id: `msg_u${seq}`,
          sessionID: input.sessionID,
          time: { created: 1 },
          type: "user",
          payload: { text: input.text },
          delivery: "steer",
        }
      },
      async wait(input: { sessionID: string }) {
        calls.wait.push(input)
        const s = need(input.sessionID)
        // opencode's wait is execution.awaitIdle: after an execution settles it checks again, so a
        // successor turn started at settle (resume:true doorbell, interrupt({resume:true})) is covered.
        for (;;) {
          const busy = s.busy
          await busy
          if (s.busy === busy && !s.successorScheduled) return
          if (s.successorScheduled) await new Promise((r) => setTimeout(r, 1))
        }
      },
      async context(input: { sessionID: string }) {
        return structuredClone(need(input.sessionID).messages)
      },
      /** Live: a rename publishes a durable Session.Renamed event (touches the session's location). */
      async update(input: { sessionID: string; title?: string; permissions?: any[] }) {
        calls.update.push(input)
        const s = need(input.sessionID)
        if (input.title !== undefined) s.info.title = input.title
        if (input.permissions !== undefined) s.info.permissions = input.permissions
      },
      async interrupt(input: { sessionID: string; resume?: boolean }) {
        calls.interrupt.push(input)
        const s = need(input.sessionID)
        if (s.finishTurn) {
          s.resumeAfterInterrupt = !!input.resume
          s.finishTurn("interrupted")
          return { interrupted: true }
        }
        if (s.running) {
          s.interruptFlag = { resume: !!input.resume }
          return { interrupted: true }
        }
        if (input.resume && !opts.ignoreWake && s.inbox.length) scheduleSuccessor(s)
        return { interrupted: false }
      },
      async synthetic(input: { sessionID: string; text: string; description?: string; metadata?: any; delivery?: string; resume?: boolean }) {
        calls.synthetic.push(input)
        const s = need(input.sessionID)
        const id = `msg_s${++seq}`
        s.inbox.push({
          id,
          text: input.text,
          resume: !!input.resume,
          delivery: input.delivery ?? "steer",
          description: input.description,
          metadata: input.metadata,
        })
        if (!s.running && input.resume) scheduleSuccessor(s)
        if (opts.syntheticNoId) return { sessionID: input.sessionID, type: "synthetic", delivery: input.delivery ?? "steer", time: { created: 1 } }
        return { id, sessionID: input.sessionID, type: "synthetic", delivery: input.delivery ?? "steer", time: { created: 1 } }
      },
    },
    permission: {
      async hook(name: string, cb: (event: any) => unknown) {
        const entry = { name, cb }
        permissionHooks.push(entry)
        return {
          dispose: async () => {
            const i = permissionHooks.indexOf(entry)
            if (i >= 0) permissionHooks.splice(i, 1)
          },
        }
      },
      async list() {
        return []
      },
      async get(input: { requestID: string }) {
        throw new Error(`Permission request not found: ${input.requestID}`)
      },
      async reply() {},
    },
    agent: {
      async get(input: { agentID: string }) {
        calls.agentGet.push(input.agentID)
        const a = (opts.agents ?? DEFAULT_AGENTS).find((x) => x.id === input.agentID)
        if (!a) throw new Error(`Agent not found: ${input.agentID}`)
        return { location: { directory }, data: { name: a.id, hidden: false, ...structuredClone(a) } }
      },
      async list() {
        return { location: { directory }, data: structuredClone(opts.agents ?? DEFAULT_AGENTS) }
      },
    },
    model: {
      async list() {
        calls.modelList++
        return { location: { directory }, data: (opts.models ?? DEFAULT_MODELS).map(modelInfo) }
      },
    },
    worktree: {
      async create(input: any) {
        calls.worktreeCreate.push(input)
        if (opts.worktreeCreateError) throw new Error(opts.worktreeCreateError)
        return { directory: `C:\\data\\opencode\\worktree\\${projectID.slice(0, 6)}\\${input.name ?? "slug"}` }
      },
      async remove(input: any) {
        calls.worktreeRemove.push(input)
      },
      async list() {
        return []
      },
    },
    storage: {
      async get(key: string) {
        return storage.has(key) ? structuredClone(storage.get(key)) : undefined
      },
      async set(key: string, value: unknown) {
        storage.set(key, structuredClone(value))
      },
      async remove(key: string) {
        storage.delete(key)
      },
      async scan() {
        return { entries: [] }
      },
    },
  }

  /** Fake `git` for worktree change detection: HEAD is constant; status is dirty per `writeFile`. */
  async function git(args: string[], cwd: string): Promise<string> {
    if (args[0] === "rev-parse") return "0123456789abcdef\n"
    if (args[0] === "status") return dirty.has(cwd) ? " M README.md\n" : ""
    throw new Error(`fake git: unsupported ${args.join(" ")}`)
  }

  return {
    ctx,
    parentID: PARENT_ID,
    projectID,
    sessions,
    storage,
    dirty,
    calls,
    git,
    permissionHooks,
    /**
     * Mirrors core/src/permission.ts evaluateInput: the rule effect goes through every `evaluate`
     * hook, which may rewrite effect/message; returns the final event.
     */
    async evaluatePermission(event: { sessionID: string; action: string; resources: string[]; agent?: string; effect: "allow" | "deny" | "ask" }) {
      const draft: any = { ...event }
      for (const h of permissionHooks) if (h.name === "evaluate") await h.cb(draft)
      return draft as typeof event & { message?: string }
    },
    setSubmitTool(tool: FakeCtxOptions["submitTool"]) {
      submitTool = tool
    },
    /** Child sessions created so far (excludes the parent). */
    children() {
      return [...sessions.values()].filter((s) => s.info.id !== PARENT_ID)
    },
  }
}
