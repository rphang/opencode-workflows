// Live end-to-end harness: drives the real opencode 2.0.15 CLI against the plugin in an isolated
// sandbox (.sandbox/e2e-*). See docs/E2E.md for the design and the findings.
//
// Shape of a live test:
//   const server = await startServer()                    // `opencode serve` (long-lived: keeps
//                                                         //  background runs alive after `run` exits)
//   const project = createProject("basic")                // fresh git repo + plugin loader
//   const r = await runPrompt(server, project, "...")     // `opencode run --server ... --format json`
//   const [call] = workflowToolCalls(r.events)            // parsed `workflow` tool output (P02)
//   const note = await waitForNotification(server, project, r.sessionID, runId)   // P06
//   const t = readTranscript(call.output.transcriptDir)   // P40
//   await server.stop()

import { spawn, type ChildProcess } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { execFileSync } from "node:child_process"
import type { AgentRecord, JournalEntry, RunSummary, WorkflowOutput } from "../../src/types.ts"

// ---- constants --------------------------------------------------------------------------------

export const REPO = resolve(import.meta.dir, "..", "..")
export const SANDBOX = join(REPO, ".sandbox")
/** The real CLI binary (spawned directly: `.cmd` shims mangle multi-line arguments on Windows). */
export const OPENCODE_BIN =
  process.env.OPENCODE_E2E_BIN ??
  (process.platform === "win32"
    ? join(REPO, "node_modules", "@opencode", "cli", "bin", "opencode.exe")
    : join(REPO, "node_modules", ".bin", "opencode2"))
export const PLUGIN_ENTRY = join(REPO, "src", "index.ts")
export const PARENT_MODEL = process.env.OPENCODE_E2E_MODEL ?? "openai/gpt-5.4-mini"
export const PASSWORD = "e2e-password"
export const COST_LOG = join(SANDBOX, "e2e-costs.jsonl")

/** Live e2e tests only run when explicitly enabled (they cost money and take minutes). */
export function e2eEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.OPENCODE_E2E === "1" && !!env.OPENAI_API_KEY
}

/** Isolated XDG dirs: the user's real opencode data/config is never touched. */
export function sandboxEnv(extra: Record<string, string> = {}): Record<string, string> {
  const base: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) base[k] = v
  return {
    ...base,
    XDG_DATA_HOME: join(SANDBOX, "e2e-data"),
    XDG_CONFIG_HOME: join(SANDBOX, "e2e-config"),
    XDG_STATE_HOME: join(SANDBOX, "e2e-state"),
    XDG_CACHE_HOME: join(SANDBOX, "e2e-cache"),
    // opencode loads every AGENTS.md from the project up to the home dir (under home) or the project root;
    // with the home moved to .sandbox, this repo's own AGENTS.md never reaches the live models.
    OPENCODE_TEST_HOME: SANDBOX,
    OPENCODE_PASSWORD: PASSWORD,
    ...extra,
  }
}

// ---- small utils ------------------------------------------------------------------------------

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export async function waitUntil<T>(
  fn: () => T | undefined | false | null | Promise<T | undefined | false | null>,
  opts: { timeoutMs: number; intervalMs?: number; what: string },
): Promise<T> {
  const deadline = Date.now() + opts.timeoutMs
  let lastErr: unknown
  for (;;) {
    try {
      const v = await fn()
      if (v) return v as T
    } catch (e) {
      lastErr = e
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${opts.timeoutMs}ms waiting for ${opts.what}${lastErr ? ` (last error: ${String(lastErr)})` : ""}`)
    }
    await sleep(opts.intervalMs ?? 1000)
  }
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T
  } catch {
    return undefined
  }
}

/** Appends one line to .sandbox/e2e-costs.jsonl (spend tracking across runs). */
export function recordCost(label: string, data: Record<string, unknown>): void {
  try {
    mkdirSync(SANDBOX, { recursive: true })
    appendFileSync(COST_LOG, JSON.stringify({ at: new Date().toISOString(), label, ...data }) + "\n")
  } catch {}
}

// ---- `opencode run --format json` events ------------------------------------------------------

export interface RunEvent {
  type: string
  timestamp?: number
  sessionID?: string
  part?: any
  [k: string]: unknown
}

export function parseRunEvents(stdout: string): RunEvent[] {
  const out: RunEvent[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim()
    if (!t.startsWith("{")) continue
    try {
      const v = JSON.parse(t)
      if (v && typeof v === "object" && typeof v.type === "string") out.push(v)
    } catch {}
  }
  return out
}

export interface ToolUse {
  tool: string
  status?: string
  input: any
  outputRaw?: string
  error?: string
  timestamp?: number
}

export interface RunDigest {
  sessionID?: string
  texts: string[]
  toolUses: ToolUse[]
  cost: number
  tokens: { input: number; output: number; reasoning: number; cacheRead: number }
}

export function summarizeRun(events: RunEvent[]): RunDigest {
  const d: RunDigest = { texts: [], toolUses: [], cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0 } }
  for (const e of events) {
    if (!d.sessionID && typeof e.sessionID === "string") d.sessionID = e.sessionID
    const p = e.part ?? {}
    if (e.type === "text" && typeof p.text === "string") d.texts.push(p.text)
    if (e.type === "tool_use") {
      const st = p.state ?? {}
      d.toolUses.push({
        tool: p.tool,
        status: st.status,
        input: st.input,
        outputRaw: typeof st.output === "string" ? st.output : undefined,
        error: typeof st.error === "string" ? st.error : undefined,
        timestamp: e.timestamp,
      })
    }
    if (e.type === "step_finish") {
      d.cost += Number(p.cost) || 0
      const t = p.tokens ?? {}
      d.tokens.input += Number(t.input) || 0
      d.tokens.output += Number(t.output) || 0
      d.tokens.reasoning += Number(t.reasoning) || 0
      d.tokens.cacheRead += Number(t.cache?.read) || 0
    }
  }
  return d
}

export interface WorkflowCall {
  input: any
  status?: string
  output?: WorkflowOutput
  raw?: string
  timestamp?: number
}

/** Every `workflow` tool call in the run, with its output parsed as WorkflowOutput JSON. */
export function workflowToolCalls(events: RunEvent[], tool = "workflow"): WorkflowCall[] {
  return summarizeRun(events)
    .toolUses.filter((t) => t.tool === tool)
    .map((t) => {
      let output: WorkflowOutput | undefined
      try {
        output = t.outputRaw ? JSON.parse(t.outputRaw) : undefined
      } catch {}
      return { input: t.input, status: t.status, output, raw: t.outputRaw ?? t.error, timestamp: t.timestamp }
    })
}

/**
 * The first workflow call that launched a run. Throws right away when the parent never called the
 * workflow tool or the launch failed, instead of waiting minutes for a notification that cannot come.
 */
export function requireLaunch(calls: WorkflowCall[]): WorkflowCall & { output: WorkflowOutput & { runId: string } } {
  if (!calls.length) throw new Error("parent did not call the workflow tool")
  const ok = calls.find((c) => typeof c.output?.runId === "string" && !c.output?.error)
  if (!ok) {
    const last = calls.at(-1)!
    throw new Error(`workflow tool returned no runId: ${last.output?.error ?? last.raw ?? "(no output)"}`)
  }
  return ok as WorkflowCall & { output: WorkflowOutput & { runId: string } }
}

// ---- task notification -------------------------------------------------------------------------

export interface ParsedNotification {
  taskId?: string
  runId?: string
  status?: string
  summary?: string
  resultRaw?: string
  result?: unknown
  usage: { agent_count?: number; tokens?: number; duration_ms?: number }
  warnings?: string
  scriptPath?: string
  transcriptDir?: string
}

export function parseNotification(text: string): ParsedNotification | undefined {
  if (typeof text !== "string" || !text.includes("<task-notification>")) return undefined
  const tag = (name: string) => {
    const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)
    return m ? m[1] : undefined
  }
  const usage: ParsedNotification["usage"] = {}
  for (const line of (tag("usage") ?? "").split(/\r?\n/)) {
    const m = /^\s*(agent_count|tokens|duration_ms):\s*(-?\d+(?:\.\d+)?)\s*$/.exec(line)
    if (m) (usage as any)[m[1]] = Number(m[2])
  }
  const resultRaw = tag("result")
  let result: unknown = resultRaw
  if (resultRaw !== undefined) {
    try {
      result = JSON.parse(resultRaw)
    } catch {}
  }
  return {
    taskId: tag("task-id"),
    runId: tag("run-id"),
    status: tag("status"),
    summary: tag("summary"),
    resultRaw,
    result,
    usage,
    warnings: tag("warnings"),
    scriptPath: tag("script-path"),
    transcriptDir: tag("transcript-dir"),
  }
}

export interface SessionMessage {
  id: string
  type: string
  text?: string
  metadata?: Record<string, any>
  description?: string
  content?: any[]
  time?: { created?: number; completed?: number }
  [k: string]: unknown
}

export function findSyntheticNotification(
  messages: SessionMessage[],
  match: string | ((m: SessionMessage) => boolean),
): SessionMessage | undefined {
  const pred = typeof match === "string" ? (m: SessionMessage) => m.metadata?.workflowRunId === match : match
  return messages.find((m) => m.type === "synthetic" && pred(m))
}

// ---- transcript dir ----------------------------------------------------------------------------

export interface Transcript {
  script?: string
  journal: JournalEntry[]
  journalRawLines: number
  summary?: RunSummary
  agents: AgentRecord[]
}

export function readTranscript(dir: string): Transcript {
  let script: string | undefined
  try {
    script = readFileSync(join(dir, "script.js"), "utf8")
  } catch {}
  const journal: JournalEntry[] = []
  let journalRawLines = 0
  try {
    for (const line of readFileSync(join(dir, "journal.jsonl"), "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue
      journalRawLines++
      try {
        const v = JSON.parse(line)
        if (v && v.type === "result") journal.push(v)
      } catch {}
    }
  } catch {}
  const agents: AgentRecord[] = []
  try {
    const files = readdirSync(join(dir, "agents")).filter((f) => /^\d+\.json$/.test(f))
    for (const f of files) {
      const r = readJson<AgentRecord>(join(dir, "agents", f))
      if (r) agents.push(r)
    }
  } catch {}
  agents.sort((a, b) => a.index - b.index)
  return { script, journal, journalRawLines, summary: readJson<RunSummary>(join(dir, "run.json")), agents }
}

// ---- projects ------------------------------------------------------------------------------------

export interface E2EProject {
  dir: string
  /** Writes a file relative to the project root (creating parent dirs). */
  write(rel: string, content: string): string
  commit(message?: string): void
  git(...args: string[]): string
}

function gitIn(dir: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.email=e2e@example.com", "-c", "user.name=e2e", "-c", "core.autocrlf=false", ...args], {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
}

/**
 * Fresh git repo under .sandbox/e2e-<name>-<ts>, with a committed plugin loader
 * (`.opencode/plugins/workflows.js` statically re-exporting src/index.ts by absolute path).
 * Committed so opencode worktrees (P28) load the plugin too.
 */
export function createProject(name: string, files: Record<string, string> = {}): E2EProject {
  const dir = join(SANDBOX, `e2e-${name}-${Date.now().toString(36)}`)
  mkdirSync(join(dir, ".opencode", "plugins"), { recursive: true })
  const entry = PLUGIN_ENTRY.replace(/\\/g, "/")
  writeFileSync(join(dir, ".opencode", "plugins", "workflows.js"), `export { default } from ${JSON.stringify(entry)}\n`)
  writeFileSync(join(dir, "README.md"), `# e2e ${name}\n`)
  const project: E2EProject = {
    dir,
    write(rel, content) {
      const p = join(dir, rel)
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, content)
      return p
    },
    commit(message = "e2e") {
      gitIn(dir, ["add", "-A"])
      gitIn(dir, ["commit", "-q", "--allow-empty", "-m", message])
    },
    git: (...args) => gitIn(dir, args),
  }
  for (const [rel, content] of Object.entries(files)) project.write(rel, content)
  gitIn(dir, ["init", "-q"])
  project.commit("init")
  return project
}

// ---- server --------------------------------------------------------------------------------------

export interface E2EServer {
  url: string
  logPath: string
  /** Root of the plugin's run data (defaultDataRoot under the sandbox XDG_DATA_HOME). */
  dataRoot: string
  worktreeRoot: string
  api<T = any>(project: E2EProject | string, method: string, path: string, body?: unknown): Promise<T>
  messages(project: E2EProject | string, sessionID: string): Promise<SessionMessage[]>
  session(project: E2EProject | string, sessionID: string): Promise<any>
  stop(): Promise<void>
}

function dirOf(p: E2EProject | string): string {
  return typeof p === "string" ? p : p.dir
}

/**
 * Starts `opencode serve --port 0` with the sandbox env. The server outlives each `opencode run`
 * client, so background workflow runs keep going (and their notification wakes the parent) after
 * the client that launched them has exited.
 */
export async function startServer(opts: { label?: string; env?: Record<string, string>; timeoutMs?: number } = {}): Promise<E2EServer> {
  mkdirSync(SANDBOX, { recursive: true })
  const logPath = join(SANDBOX, `e2e-serve-${opts.label ?? "x"}-${Date.now().toString(36)}.log`)
  const env = sandboxEnv({ PWD: SANDBOX, ...opts.env })
  let proc: ChildProcess | undefined
  let url: string | undefined
  for (let attempt = 1; attempt <= 3 && !url; attempt++) {
    proc = spawn(OPENCODE_BIN, ["serve", "--port", "0", "--hostname", "127.0.0.1", "--print-logs", "--log-level", "info"], {
      cwd: SANDBOX,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
    const p = proc
    url = await new Promise<string | undefined>((res) => {
      const t = setTimeout(() => res(undefined), opts.timeoutMs ?? 60_000)
      const onData = (b: Buffer) => {
        const s = b.toString()
        appendFileSync(logPath, s)
        const m = /server listening on (http:\/\/\S+)/.exec(s)
        if (m) {
          clearTimeout(t)
          res(m[1].replace(/\/$/, ""))
        }
      }
      p.stdout!.on("data", onData)
      p.stderr!.on("data", onData)
      p.on("exit", () => {
        clearTimeout(t)
        res(undefined)
      })
    })
    if (!url) {
      try {
        p.kill()
      } catch {}
    }
  }
  if (!url || !proc) throw new Error(`opencode serve did not start (log: ${logPath})`)
  const server = proc
  const auth = "Basic " + Buffer.from(`opencode:${PASSWORD}`).toString("base64")

  const api = async <T = any>(project: E2EProject | string, method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(url + path, {
      method,
      headers: {
        authorization: auth,
        "content-type": "application/json",
        "x-opencode-directory": encodeURIComponent(dirOf(project)),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`)
    try {
      return JSON.parse(text) as T
    } catch {
      return text as unknown as T
    }
  }

  return {
    url,
    logPath,
    dataRoot: join(env.XDG_DATA_HOME, "opencode", "workflows"),
    worktreeRoot: join(env.XDG_DATA_HOME, "opencode", "worktree"),
    api,
    async messages(project, sessionID) {
      // Page size is capped at 200 by the server; follow cursors (oldest first).
      const out: SessionMessage[] = []
      let path = `/api/session/${sessionID}/message?order=asc&limit=200`
      for (let page = 0; page < 20; page++) {
        const r = await api<{ data: SessionMessage[]; cursor?: { next?: string | null } }>(project, "GET", path)
        out.push(...(r?.data ?? []))
        const next = r?.cursor?.next
        if (!next || !(r?.data ?? []).length) break
        path = `/api/session/${sessionID}/message?limit=200&cursor=${encodeURIComponent(next)}`
      }
      return out
    },
    session: (project, sessionID) => api(project, "GET", `/api/session/${sessionID}`),
    async stop() {
      if (server.exitCode !== null) return
      await new Promise<void>((res) => {
        const t = setTimeout(() => {
          if (process.platform === "win32" && server.pid) {
            try {
              execFileSync("taskkill", ["/pid", String(server.pid), "/t", "/f"], { stdio: "ignore" })
            } catch {}
          }
          res()
        }, 5000)
        server.once("exit", () => {
          clearTimeout(t)
          res()
        })
        try {
          server.kill()
        } catch {}
      })
    },
  }
}

// ---- `opencode run` ------------------------------------------------------------------------------

export interface RunResult extends RunDigest {
  events: RunEvent[]
  stdout: string
  stderr: string
  exitCode: number | null
  ms: number
  attempts: number
}

/**
 * `opencode run --server <url> --auto --format json -m <model> [--session id] <message>` in the
 * project dir. Retries (up to `retries`) only when the attempt produced no events at all (the known
 * startup stall), so a prompt is never delivered twice.
 */
export async function runPrompt(
  server: E2EServer,
  project: E2EProject,
  message: string,
  opts: { session?: string; model?: string; timeoutMs?: number; retries?: number; label?: string } = {},
): Promise<RunResult> {
  const args = ["run", "--server", server.url, "--auto", "--format", "json", "-m", opts.model ?? PARENT_MODEL]
  if (opts.session) args.push("--session", opts.session)
  args.push(message)
  const retries = opts.retries ?? 2
  let last: RunResult | undefined
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    const t0 = Date.now()
    const { stdout, stderr, exitCode } = await new Promise<{ stdout: string; stderr: string; exitCode: number | null }>((res) => {
      // `opencode run` resolves its directory from $PWD before cwd, so PWD must point at the project.
      const p = spawn(OPENCODE_BIN, args, { cwd: project.dir, env: sandboxEnv({ PWD: project.dir }), stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
      let so = ""
      let se = ""
      p.stdout!.on("data", (b) => (so += b.toString()))
      p.stderr!.on("data", (b) => (se += b.toString()))
      const t = setTimeout(() => {
        se += `\n[harness] killed after ${opts.timeoutMs ?? 240_000}ms`
        try {
          p.kill()
        } catch {}
      }, opts.timeoutMs ?? 240_000)
      p.on("exit", (code) => {
        clearTimeout(t)
        // let the pipes drain
        setTimeout(() => res({ stdout: so, stderr: se, exitCode: code }), 50)
      })
    })
    const events = parseRunEvents(stdout)
    last = { ...summarizeRun(events), events, stdout, stderr, exitCode, ms: Date.now() - t0, attempts: attempt }
    recordCost(opts.label ?? "run", { kind: "parent", attempt, ms: last.ms, cost: last.cost, tokens: last.tokens, sessionID: last.sessionID })
    try {
      writeFileSync(join(SANDBOX, `e2e-last-run-${opts.label ?? "run"}.log`), `${args.slice(0, -1).join(" ")}\n--- stdout\n${stdout}\n--- stderr\n${stderr}\n`)
    } catch {}
    if (!shouldRetryRun(events, opts)) return last
  }
  return last!
}

/**
 * Whether a `runPrompt` attempt should be retried without risking a double delivery:
 * - no events at all: the known startup stall (the prompt never reached a model);
 * - a FRESH session whose turn called no tool at all: the model refused or ignored the prompt
 *   (seen live: gpt-5.4-mini occasionally answers "I can't help launch that workflow"). Nothing ran,
 *   so a retry in a new session is side-effect free. Every live test prompt asks for a tool call.
 * A no-tool turn in an existing session is not retried (it would add to that session's history).
 */
export function shouldRetryRun(events: RunEvent[], opts: { session?: string }): boolean {
  if (events.length === 0) return true
  if (opts.session) return false
  return !events.some((e) => e.type === "tool_use")
}

/** Parent-session message list polled until the run's task notification (synthetic) arrives. */
export async function waitForNotification(
  server: E2EServer,
  project: E2EProject,
  sessionID: string,
  match: string | ((m: SessionMessage) => boolean),
  timeoutMs = 300_000,
): Promise<{ message: SessionMessage; notification: ParsedNotification; messages: SessionMessage[] }> {
  return waitUntil(
    async () => {
      const messages = await server.messages(project, sessionID)
      const message = findSyntheticNotification(messages, match)
      if (!message) return undefined
      return { message, notification: parseNotification(message.text ?? "")!, messages }
    },
    { timeoutMs, intervalMs: 2000, what: `task notification in ${sessionID}` },
  )
}

/**
 * A location's plugins load lazily on the first request for that directory. Waits until the
 * `dynamic-workflows` plugin is active there (also true when it is disabled: setup ran, registered nothing).
 */
export async function waitForPlugin(server: E2EServer, project: E2EProject, timeoutMs = 60_000): Promise<void> {
  await waitUntil(
    async () => {
      const p = await server.api<{ data: any[] }>(project, "GET", "/api/plugin")
      const cmds = await server.api<{ data: any[] }>(project, "GET", "/api/command")
      const ours = (p?.data ?? []).find((x) => x?.id === "dynamic-workflows")
      return ours?.state?.status === "active" && (cmds?.data ?? []).length > 0
    },
    { timeoutMs, intervalMs: 500, what: "dynamic-workflows plugin active" },
  )
}

export interface InboxItem {
  id: string
  type: string
  payload?: { text?: string; description?: string; metadata?: Record<string, any> }
  delivery?: string
  time?: { created?: number }
}

/**
 * Synthetic texts of a session: delivered ones (message list) plus pending ones (inbox). A
 * `synthetic({resume:false})` on an idle session stays in the inbox until the next turn.
 */
export async function syntheticEntries(
  server: E2EServer,
  project: E2EProject,
  sessionID: string,
): Promise<{ id: string; text: string; created: number; pending: boolean }[]> {
  const msgs = await server.messages(project, sessionID)
  const inbox = await server.api<{ data: InboxItem[] }>(project, "GET", `/api/session/${sessionID}/inbox`)
  return [
    ...msgs.filter((m) => m.type === "synthetic").map((m) => ({ id: m.id, text: String(m.text ?? ""), created: m.time?.created ?? 0, pending: false })),
    ...(inbox?.data ?? [])
      .filter((i) => i.type === "synthetic")
      .map((i) => ({ id: i.id, text: String(i.payload?.text ?? ""), created: i.time?.created ?? 0, pending: true })),
  ]
}

/** Waits until an assistant message was created after `afterMs` and the session is idle again. */
export async function waitForAssistantAfter(
  server: E2EServer,
  project: E2EProject,
  sessionID: string,
  afterMs: number,
  timeoutMs = 120_000,
): Promise<SessionMessage> {
  return waitUntil(
    async () => {
      const messages = await server.messages(project, sessionID)
      const idx = messages.findIndex((m) => m.type === "assistant" && (m.time?.created ?? 0) >= afterMs)
      if (idx < 0) return undefined
      const idleAfter = messages.slice(idx + 1).some((m) => m.type === "idle")
      return idleAfter ? messages[idx] : undefined
    },
    { timeoutMs, intervalMs: 2000, what: `assistant reply in ${sessionID} after ${afterMs}` },
  )
}

/** Concatenated text parts of an assistant message. */
export function assistantText(m: SessionMessage | undefined): string {
  return (m?.content ?? [])
    .filter((c: any) => c?.type === "text")
    .map((c: any) => String(c.text))
    .join("")
}

/** Tool parts (`{type:"tool", name, state}`) across a session's assistant messages. */
export function toolParts(messages: SessionMessage[]): { name: string; state: any }[] {
  const out: { name: string; state: any }[] = []
  for (const m of messages) {
    if (m.type !== "assistant") continue
    for (const c of m.content ?? []) if (c?.type === "tool") out.push({ name: c.name ?? c.tool, state: c.state })
  }
  return out
}

/** Records the children's spend (from run.json usage) to the cost log. */
export function recordRunCost(label: string, summary: RunSummary | undefined): void {
  if (!summary) return
  recordCost(label, { kind: "children", runId: summary.runId, agents: summary.agentCount, usage: summary.usage })
}

/** Prompt telling the parent model to call the workflow tool with an exact input and then stop. */
export function launchPrompt(input: Record<string, unknown>, after = "reply with the single word LAUNCHED and stop"): string {
  const lines = ["Call the `workflow` tool exactly once with exactly this JSON input (copy every field verbatim, including the whole `script` string if present):", "```json", JSON.stringify(input, null, 2), "```", `Then ${after}. Do not call any other tool.`]
  return lines.join("\n")
}

export function fileExists(p: string): boolean {
  return existsSync(p)
}

/** The assistant text of a `runPrompt` turn (the launch turn in the demo), or a placeholder when it had none. */
export function launchTurnText(r: Pick<RunDigest, "texts">): string {
  const text = r.texts.join("\n").trim()
  return text || "(no assistant text)"
}
