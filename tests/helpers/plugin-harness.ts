// Parity-suite harness: the real plugin (src/index.ts) over a fake opencode v2 plugin Context.
//
//   const h = await createHarness()              // temp project (with .git), config home, data dir
//   const p = await h.setup({ runner })          // plugin with a FakeRunner (engine-level agents)
//   const p = await h.setup({ real: true })      // plugin with the REAL opencode runner over the fake ctx
//   const out = await p.call({ script })         // `workflow` tool execute → parsed WorkflowOutput
//   const n = await p.notification(0)            // waits for the i-th <task-notification>
//   p.resultOf(n)                                // parsed <result> (JSON, or the raw string)
//   await h.dispose()                            // cleanup (stops runs, removes temp dirs)

import { mkdirSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPlugin } from "../../src/index.ts"
import { isRunActive } from "../../src/engine.ts"
import { createOpencodeRunner } from "../../src/opencode/runner.ts"
import type { PluginDeps } from "../../src/plugin/setup.ts"
import { RunStore } from "../../src/store.ts"
import type { WorkflowOutput } from "../../src/types.ts"
import { createFakeCtx, type FakeCtxOptions } from "./fake-opencode-ctx.ts"
import { FakeRunner, sleep } from "./fake-runner.ts"

export const SESSION = "ses_parent0000000000000000000"

export interface Registered {
  name: string
  description: string
  input: any
  options?: any
  execute: (input: any, tctx: any) => Promise<any>
}

export interface RegisteredCommand {
  name: string
  description?: string
  execute: (i: any) => Promise<void>
}

export function tctx(sessionID = SESSION, agent = "build") {
  return {
    sessionID,
    agent,
    messageID: "msg_1",
    id: "call_1",
    progress: async () => {},
    signal: new AbortController().signal,
  }
}

export async function waitFor(cond: () => boolean, what = "condition", ms = 5000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`)
    await sleep(5)
  }
}

/** `export const meta = <meta>\n<body>` */
export function script(body: string, meta = `{ name: "t-wf", description: "test workflow" }`): string {
  return `export const meta = ${meta}\n${body}`
}

/** Extracts <tag>…</tag> from a notification text. */
export function tag(text: string, name: string): string | undefined {
  const m = text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))
  return m?.[1]
}

function makePluginCtx(opts: FakeCtxOptions & { options?: Record<string, unknown> } = {}) {
  const fake = createFakeCtx(opts)
  const toolCbs: ((e: any) => void)[] = []
  const commandCbs: ((e: any) => void)[] = []
  const synthetic: any[] = []
  const prompts: any[] = []
  let reloads = 0

  function collect<T extends { name: string }>(cbs: ((e: any) => void)[]): Map<string, T> {
    const out = new Map<string, T>()
    const editor = {
      add: (d: T) => out.set(d.name, d),
      remove: (id: string) => out.delete(id),
      list: () => [...out.values()],
      get: (id: string) => out.get(id),
      update: () => {},
      namespace: () => {},
    }
    for (const cb of cbs) cb(editor)
    return out
  }

  const session = {
    ...fake.ctx.session,
    async synthetic(input: any) {
      synthetic.push(input)
      return { id: `syn_${synthetic.length}`, sessionID: input.sessionID, type: "synthetic" }
    },
    async prompt(input: any) {
      prompts.push(input)
      return fake.ctx.session.prompt(input)
    },
  }

  const ctx = {
    ...fake.ctx,
    options: opts.options ?? {},
    session,
    tool: {
      async transform(cb: (e: any) => void) {
        toolCbs.push(cb)
        return { dispose: async () => {} }
      },
      async reload() {},
    },
    command: {
      async transform(cb: (e: any) => void) {
        commandCbs.push(cb)
        return { dispose: async () => {} }
      },
      async reload() {
        reloads++
      },
      async list() {
        return []
      },
    },
  }

  return {
    fake,
    ctx: ctx as any,
    synthetic,
    prompts,
    tools: () => collect<Registered>(toolCbs),
    commands: () => collect<RegisteredCommand>(commandCbs),
    reloads: () => reloads,
  }
}

export interface SetupOptions {
  /** FakeRunner for engine-level agents (default: a fresh FakeRunner). Ignored with `real`. */
  runner?: FakeRunner
  /** Use the real opencode runner (src/opencode/runner.ts) over the fake ctx, with fake git. */
  real?: boolean
  /** Fake ctx options (responder, parent session, models, ...). */
  fake?: FakeCtxOptions
  env?: Record<string, string>
  options?: Record<string, unknown>
  deps?: Partial<PluginDeps>
}

export type Plugged = Awaited<ReturnType<Harness["setup"]>>

export interface Harness {
  base: string
  projectDir: string
  configHome: string
  dataDir: string
  store: RunStore
  setup(opts?: SetupOptions): Promise<ReturnType<typeof extend>>
  dispose(): Promise<void>
}

function extend(p: ReturnType<typeof makePluginCtx>, runner: FakeRunner, cleanup: (() => Promise<void>) | undefined) {
  const notifications = () => p.synthetic.filter((s) => String(s.text).includes("<task-notification>"))
  return {
    ...p,
    runner,
    cleanup,
    notifications,
    async call(input: any, sessionID = SESSION, agent = "build"): Promise<WorkflowOutput> {
      const tool = p.tools().get("workflow")!
      const res = await tool.execute(input, tctx(sessionID, agent))
      return JSON.parse(res.content)
    },
    async control(input: any, sessionID = SESSION): Promise<string> {
      const res = await p.tools().get("workflow_control")!.execute(input, tctx(sessionID))
      return typeof res.content === "string" ? res.content : res.content.map((c: any) => c.text).join("")
    },
    /** Waits for the i-th task notification (0-based) and returns it. */
    async notification(i = 0, ms = 10000): Promise<any> {
      await waitFor(() => notifications().length > i, `notification #${i}`, ms)
      return notifications()[i]
    },
    /** Parsed <result> of a notification: JSON when it parses, else the raw string. */
    resultOf(n: any): unknown {
      const raw = tag(String(n.text), "result") ?? ""
      try {
        return JSON.parse(raw)
      } catch {
        return raw
      }
    },
    /**
     * Holds every <task-notification> delivery (session.synthetic) until the returned release() is
     * called, so a test can observe a run that finished but has not notified its parent yet.
     */
    holdNotifications(): () => void {
      const orig = p.ctx.session.synthetic
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      p.ctx.session.synthetic = async (input: any) => {
        if (String(input?.text).includes("<task-notification>")) await gate
        return orig(input)
      }
      return () => release()
    },
    async settled(runId: string, ms = 10000) {
      await waitFor(() => !isRunActive(runId), `run ${runId} settled`, ms)
    },
    async command(name: string, text = "", sessionID = SESSION) {
      const cmd = p.commands().get(name)
      if (!cmd) throw new Error(`no command /${name}`)
      await cmd.execute({ sessionID, prompt: { text }, delivery: "steer" })
    },
  }
}

export async function createHarness(): Promise<Harness> {
  const base = await mkdtemp(join(tmpdir(), "wf-parity-"))
  const projectDir = join(base, "proj")
  const configHome = join(base, "config")
  const dataDir = join(base, "data")
  mkdirSync(join(projectDir, ".git"), { recursive: true })
  mkdirSync(configHome, { recursive: true })
  const cleanups: (() => Promise<void>)[] = []

  return {
    base,
    projectDir,
    configHome,
    dataDir,
    store: new RunStore({ root: dataDir }),
    async setup(opts: SetupOptions = {}) {
      const p = makePluginCtx({ directory: projectDir, options: opts.options, ...opts.fake })
      const runner = opts.runner ?? new FakeRunner()
      const createRunner: PluginDeps["createRunner"] = opts.real
        ? ({ ctx, parentSessionID, parentAgent, runId, registry }) =>
            createOpencodeRunner(ctx as any, {
              parentSessionID,
              parentAgent,
              runId,
              registry,
              deniedTools: ["workflow", "workflow_control"],
              git: p.fake.git,
            })
        : () => runner
      const deps: PluginDeps = {
        env: { XDG_CONFIG_HOME: configHome, ...opts.env },
        dataDir,
        registryOptions: { configHome },
        watch: false,
        summaryThrottleMs: 5,
        createRunner,
        ...opts.deps,
      }
      const cleanup = await createPlugin(deps).setup(p.ctx)
      const c = typeof cleanup === "function" ? (cleanup as () => Promise<void>) : undefined
      if (c) cleanups.push(c)
      // The fake ctx executes `submit` turns through the plugin's real workflow_submit tool.
      const submit = p.tools().get("workflow_submit")
      if (submit) p.fake.setSubmitTool(submit as any)
      return extend(p, runner, c)
    },
    async dispose() {
      for (const c of cleanups.reverse()) {
        try {
          await c()
        } catch {}
      }
      await rm(base, { recursive: true, force: true, maxRetries: 3 })
    },
  }
}
