// Configurable fake AgentRunner for engine and parity tests.
//
// Usage:
//
//   const runner = new FakeRunner()                         // every agent completes with "done: <prompt>"
//     .on("summarize", { value: "short" })                  // prompt contains "summarize" -> "short"
//     .on(/^fail/, { status: "failed", error: "boom" })     // regex on the prompt
//     .on((req) => req.index === 3, { delayMs: 50 })        // predicate on the whole request
//     .on("slow", { hold: true })                           // waits until runner.release("slow") or abort
//     .on("dyn", (req) => ({ value: req.prompt.length }))   // computed behaviour
//
//   runner.calls           // AgentRequest[] in the order run() was called (= agent start order)
//   runner.prompts         // just the prompts, same order
//   runner.finished        // [{index, prompt, status}] in completion order
//   runner.maxRunning      // concurrency high-water mark
//   await runner.waitForRunning(3)   // resolves once >= 3 agents are running at the same time
//   await runner.waitForCalls(5)     // resolves once run() has been called 5 times
//   runner.release("slow")           // releases every held agent whose prompt matches
//
// Rules are checked most-recent-first, so a later .on() overrides an earlier one. The first
// matching rule wins; unmatched prompts use `defaults` (constructor option).
//
// Structured output: when the request has opts.schema and the behaviour resolves to "completed",
// the value is validated with the real validateOutput(). An invalid value becomes
// {status:"schema_failed", error:"structured output failed validation after N attempts: ..."},
// mirroring the real runner (disable with `validateSchema: false`).
//
// Steering (X01–X04): when the request has a mailbox, the fake attaches a sender, reports held
// messages delivered with the "first prompt", opens the window while it works and closes it
// (reporting sent messages delivered) before it computes the value. `value(req, messages)` sees
// every message the agent received; `runner.steers` records them.
//
// Abort: every behaviour honours request.signal. An aborted agent resolves {status:"stopped"}
// (after `lingerMs`, to simulate a child process that has not exited yet — P43), unless
// `ignoreAbort` is set, in which case it finishes normally.

import { validateOutput, maxStructuredRetries } from "../../src/schema.ts"
import type { AgentMessage } from "../../src/mailbox.ts"
import type { AgentOutcome, AgentRequest, AgentRunner, Json, TokenUsage } from "../../src/types.ts"
import { ZERO_USAGE } from "../../src/types.ts"

export interface FakeBehavior {
  /** Final value (or a function of the request). Default: "done: <prompt>" (or {} with a schema). */
  value?: Json | ((req: AgentRequest, messages?: AgentMessage[]) => Json)
  /** Outcome status. Default "completed". */
  status?: AgentOutcome["status"]
  /** Error message for failed / schema_failed. */
  error?: string
  /** Simulated work time before finishing. */
  delayMs?: number
  /** Wait until runner.release(match) (or abort) before finishing. */
  hold?: boolean
  /** Token usage reported by this agent (merged over the runner's default usage). */
  usage?: Partial<TokenUsage>
  /** Make run() reject with this message instead of resolving an outcome. */
  throws?: string
  /** Child session id to report. Default "ses_fake_<index>". */
  sessionID?: string
  /** Resolved model to report via onUpdate once the "child" exists ("provider/model#variant"). */
  model?: string
  /** After abort, keep "running" this long before resolving stopped (simulates a slow exit). */
  lingerMs?: number
  /** Ignore the abort signal entirely and finish normally. */
  ignoreAbort?: boolean
}

export type FakeRule = FakeBehavior | ((req: AgentRequest) => FakeBehavior | Promise<FakeBehavior>)
export type FakeMatch = string | RegExp | ((req: AgentRequest) => boolean)

export interface FakeRunnerOptions {
  /** Behaviour for prompts matching no rule. */
  defaults?: FakeBehavior
  /** Usage every agent reports unless its behaviour overrides it. Default: output 10, input 100. */
  usage?: Partial<TokenUsage>
  /** Validate completed values against opts.schema (default true). */
  validateSchema?: boolean
}

export interface FinishedCall {
  index: number
  prompt: string
  status: AgentOutcome["status"] | "threw"
}

export const DEFAULT_FAKE_USAGE: TokenUsage = { ...ZERO_USAGE, input: 100, output: 10 }

function matches(m: FakeMatch, req: AgentRequest): boolean {
  if (typeof m === "string") return req.prompt.includes(m)
  if (m instanceof RegExp) return m.test(req.prompt)
  return m(req)
}

export class FakeRunner implements AgentRunner {
  readonly calls: AgentRequest[] = []
  readonly finished: FinishedCall[] = []
  /** Steering messages received, in arrival order (held ones when the agent started). */
  readonly steers: { index: number; message: AgentMessage }[] = []
  private deliveries = 0
  running = 0
  maxRunning = 0
  private rules: [FakeMatch, FakeRule][] = []
  private held: { req: AgentRequest; release: () => void }[] = []
  private waiters: (() => void)[] = []
  private readonly defaults: FakeBehavior
  private readonly usage: TokenUsage
  private readonly validateSchema: boolean

  constructor(opts: FakeRunnerOptions = {}) {
    this.defaults = opts.defaults ?? {}
    this.usage = { ...DEFAULT_FAKE_USAGE, ...opts.usage }
    this.validateSchema = opts.validateSchema ?? true
  }

  /** Adds a rule. Later rules take precedence over earlier ones. */
  on(match: FakeMatch, rule: FakeRule): this {
    this.rules.unshift([match, rule])
    return this
  }

  get prompts(): string[] {
    return this.calls.map((c) => c.prompt)
  }

  /** Number of agents currently held by `hold: true`. */
  get heldCount(): number {
    return this.held.length
  }

  /** Releases held agents whose prompt matches (all held agents when no match is given). Returns the count. */
  release(match?: FakeMatch): number {
    const keep: typeof this.held = []
    let n = 0
    for (const h of this.held) {
      if (match === undefined || matches(match, h.req)) {
        h.release()
        n++
      } else keep.push(h)
    }
    this.held = keep
    return n
  }

  waitForRunning(n: number, timeoutMs = 2000): Promise<void> {
    return this.waitUntil(() => this.running >= n, `${n} running agents`, timeoutMs)
  }

  waitForCalls(n: number, timeoutMs = 2000): Promise<void> {
    return this.waitUntil(() => this.calls.length >= n, `${n} agent calls`, timeoutMs)
  }

  waitForHeld(n: number, timeoutMs = 2000): Promise<void> {
    return this.waitUntil(() => this.held.length >= n, `${n} held agents`, timeoutMs)
  }

  waitUntil(cond: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
    if (cond()) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== check)
        reject(new Error(`FakeRunner: timed out waiting for ${what} (running=${this.running}, calls=${this.calls.length}, held=${this.held.length})`))
      }, timeoutMs)
      const check = () => {
        if (!cond()) return
        clearTimeout(timer)
        this.waiters = this.waiters.filter((w) => w !== check)
        resolve()
      }
      this.waiters.push(check)
    })
  }

  private notify() {
    for (const w of [...this.waiters]) w()
  }

  private async behaviorFor(req: AgentRequest): Promise<FakeBehavior> {
    for (const [m, rule] of this.rules) {
      if (matches(m, req)) return typeof rule === "function" ? await rule(req) : rule
    }
    return this.defaults
  }

  async run(req: AgentRequest): Promise<AgentOutcome> {
    this.calls.push(req)
    this.running++
    this.maxRunning = Math.max(this.maxRunning, this.running)
    this.notify()
    let status: FinishedCall["status"] = "threw"
    try {
      const out = await this.execute(req)
      status = out.status
      return out
    } finally {
      req.mailbox?.seal()
      this.running--
      this.finished.push({ index: req.index, prompt: req.prompt, status })
      this.notify()
    }
  }

  private async execute(req: AgentRequest): Promise<AgentOutcome> {
    const b = await this.behaviorFor(req)
    const usage: TokenUsage = { ...this.usage, ...b.usage }
    const sessionID = b.sessionID ?? `ses_fake_${req.index}`
    req.onUpdate?.({ sessionID })
    if (b.model) req.onUpdate?.({ model: b.model })

    const received: AgentMessage[] = []
    const mb = req.mailbox
    if (mb) {
      const held = mb.attach(async (m) => {
        received.push(m)
        this.steers.push({ index: req.index, message: m })
        return { id: `del_${req.index}_${++this.deliveries}` }
      })
      for (const m of held) {
        received.push(m)
        this.steers.push({ index: req.index, message: m })
        mb.report(m.id, "delivered")
      }
      mb.open()
    }

    const aborted = await this.work(req, b)
    if (mb) for (const s of await mb.close()) mb.report(s.id, "delivered")
    if (aborted && !b.ignoreAbort) {
      if (b.lingerMs) await sleep(b.lingerMs)
      return { status: "stopped", usage, sessionID }
    }

    if (b.throws !== undefined) throw new Error(b.throws)
    const status = b.status ?? "completed"
    if (status === "stopped") return { status, usage, sessionID }
    if (status === "failed" || status === "schema_failed") return { status, error: b.error ?? `${status}: ${req.prompt}`, usage, sessionID }

    const schema = req.opts.schema
    const raw = typeof b.value === "function" ? b.value(req, received) : b.value
    const value: Json = raw !== undefined ? raw : schema ? {} : `done: ${req.prompt}`
    if (schema && this.validateSchema) {
      const v = validateOutput(schema, value)
      if (!v.ok) {
        return {
          status: "schema_failed",
          error: `structured output failed validation after ${maxStructuredRetries()} attempts: ${v.error}`,
          usage,
          sessionID,
        }
      }
    }
    return { status: "completed", value, usage, sessionID }
  }

  /** Waits for delay/hold; returns true if the signal aborted first. */
  private work(req: AgentRequest, b: FakeBehavior): Promise<boolean> {
    const { signal } = req
    if (signal.aborted && !b.ignoreAbort) return Promise.resolve(true)
    if (!b.hold && !b.delayMs) return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      let entry: { req: AgentRequest; release: () => void } | undefined
      const done = (aborted: boolean) => {
        if (timer) clearTimeout(timer)
        if (entry) this.held = this.held.filter((h) => h !== entry)
        signal.removeEventListener("abort", onAbort)
        resolve(aborted)
      }
      const onAbort = () => {
        if (!b.ignoreAbort) done(true)
      }
      signal.addEventListener("abort", onAbort)
      if (b.hold) {
        entry = { req, release: () => (b.delayMs ? (timer = setTimeout(() => done(false), b.delayMs)) : done(false)) }
        this.held.push(entry)
        this.notify()
      } else {
        timer = setTimeout(() => done(false), b.delayMs)
      }
    })
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
