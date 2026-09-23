// On-disk run storage (host code: may use Date.now / crypto / fs).
//
// Layout: <root>/<sessionKey>/<runId>/{script.js, run.json, journal.jsonl, agents/<index>.json}
// Root: option > env OPENCODE_WORKFLOW_DATA_DIR > $XDG_DATA_HOME/opencode/workflows >
//       (win32) %LOCALAPPDATA%\opencode\workflows | (posix) ~/.local/share/opencode/workflows

import { randomBytes } from "node:crypto"
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { AgentRecord, JournalEntry, JournalMessage, RunSummary } from "./types.ts"

export const SCRIPT_FILE = "script.js"
export const SUMMARY_FILE = "run.json"
export const JOURNAL_FILE = "journal.jsonl"
export const AGENTS_DIR = "agents"

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/

export function defaultDataRoot(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
  home: string = homedir(),
): string {
  if (env.OPENCODE_WORKFLOW_DATA_DIR) return env.OPENCODE_WORKFLOW_DATA_DIR
  if (env.XDG_DATA_HOME) return join(env.XDG_DATA_HOME, "opencode", "workflows")
  if (platform === "win32") return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "opencode", "workflows")
  return join(home, ".local", "share", "opencode", "workflows")
}

let lastTs = 0
let seq = 0

/** Unique, lexicographically sortable (in creation order within a process) run id. */
export function newRunId(): string {
  const now = Date.now()
  if (now > lastTs) {
    lastTs = now
    seq = 0
  } else {
    seq++
  }
  // lastTs never goes backwards, so ids stay sorted even if the clock does.
  return `wf_${lastTs.toString(36).padStart(9, "0")}${seq.toString(36).padStart(4, "0")}_${randomBytes(4).toString("hex")}`
}

/** Maps an arbitrary session identifier to a single safe path segment. */
export function sanitizeSessionKey(key: string): string {
  const s = key.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128)
  return s || "_"
}

export interface RunLocation {
  runId: string
  sessionKey: string
  dir: string
}

export interface RunStoreOptions {
  root?: string
  /** rename() used by atomic writes (tests inject failures). Default node:fs/promises rename. */
  rename?: (from: string, to: string) => Promise<void>
  /**
   * Backoff (ms) between retries of a rename that failed with EPERM/EACCES/EBUSY. On Windows,
   * replacing a file fails while any other handle has it open (a concurrent reader of run.json,
   * an antivirus or indexer), so an atomic write retries like graceful-fs does. Default
   * RENAME_RETRY_DELAYS_MS (~1.5 s in total).
   */
  renameRetryDelaysMs?: readonly number[]
}

export const RENAME_RETRY_DELAYS_MS: readonly number[] = [5, 10, 20, 40, 80, 120, 160, 200, 250, 300, 350]
const TRANSIENT_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"])

function isNotFound(e: unknown): boolean {
  return (e as NodeJS.ErrnoException)?.code === "ENOENT"
}

export class RunStore {
  readonly root: string
  private locations = new Map<string, RunLocation>()
  private queues = new Map<string, Promise<unknown>>()
  private readonly renameFn: (from: string, to: string) => Promise<void>
  private readonly renameRetryDelaysMs: readonly number[]

  constructor(opts: RunStoreOptions = {}) {
    this.root = opts.root ?? defaultDataRoot()
    this.renameFn = opts.rename ?? rename
    this.renameRetryDelaysMs = opts.renameRetryDelaysMs ?? RENAME_RETRY_DELAYS_MS
  }

  newRunId(): string {
    return newRunId()
  }

  /** Creates the run directory. Throws if the id is unsafe or already exists. */
  async createRun(sessionKey: string, runId: string = newRunId()): Promise<RunLocation> {
    if (!SAFE_ID.test(runId)) throw new Error(`invalid run id: ${runId}`)
    if (await this.findRun(runId)) throw new Error(`run ${runId} already exists`)
    const key = sanitizeSessionKey(sessionKey)
    const dir = join(this.root, key, runId)
    await mkdir(join(this.root, key), { recursive: true })
    await mkdir(dir) // non-recursive: fails with EEXIST on a race
    await mkdir(join(dir, AGENTS_DIR))
    const loc = { runId, sessionKey: key, dir }
    this.locations.set(runId, loc)
    return loc
  }

  /** Locates a run by id across all session keys. */
  async findRun(runId: string): Promise<RunLocation | undefined> {
    if (!SAFE_ID.test(runId)) return undefined
    const cached = this.locations.get(runId)
    if (cached) return cached
    for (const key of await this.sessionKeys()) {
      const dir = join(this.root, key, runId)
      try {
        if ((await stat(dir)).isDirectory()) {
          const loc = { runId, sessionKey: key, dir }
          this.locations.set(runId, loc)
          return loc
        }
      } catch (e) {
        if (!isNotFound(e)) throw e
      }
    }
    return undefined
  }

  async runDir(runId: string): Promise<string> {
    const loc = await this.findRun(runId)
    if (!loc) throw new Error(`unknown run: ${runId}`)
    return loc.dir
  }

  /** Writes the run's script and returns its absolute path. */
  async writeScript(runId: string, source: string): Promise<string> {
    // Enqueue synchronously (before any await) so same-file writes keep their call order.
    return this.serialize(`${runId}:script`, async () => {
      const path = join(await this.runDir(runId), SCRIPT_FILE)
      await this.atomicWrite(path, source)
      return path
    })
  }

  /** Appends a result line, or a steering `message` line (X06; readJournal skips those). */
  async appendJournal(runId: string, entry: JournalEntry | JournalMessage): Promise<void> {
    const line = JSON.stringify(entry) + "\n"
    await this.serialize(`${runId}:journal`, async () => appendFile(join(await this.runDir(runId), JOURNAL_FILE), line, "utf8"))
  }

  /** Journal entries in file (completion) order. Torn/invalid lines are skipped. [] when absent. */
  async readJournal(runId: string): Promise<JournalEntry[]> {
    return (await this.readJournalLines(runId)).filter(isJournalEntry)
  }

  /** Steering message lines (X06), in file order. [] when absent. */
  async readJournalMessages(runId: string): Promise<JournalMessage[]> {
    return (await this.readJournalLines(runId)).filter(isJournalMessage)
  }

  private async readJournalLines(runId: string): Promise<unknown[]> {
    const loc = await this.findRun(runId)
    if (!loc) return []
    let text: string
    try {
      text = await readFile(join(loc.dir, JOURNAL_FILE), "utf8")
    } catch (e) {
      if (isNotFound(e)) return []
      throw e
    }
    const out: unknown[] = []
    for (const line of text.split("\n")) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line))
      } catch {
        // torn line
      }
    }
    return out
  }

  /** Atomically replaces run.json (tmp file + rename). */
  async writeSummary(summary: RunSummary): Promise<void> {
    const text = JSON.stringify(summary, null, 2)
    await this.serialize(`${summary.runId}:summary`, async () =>
      this.atomicWrite(join(await this.runDir(summary.runId), SUMMARY_FILE), text),
    )
  }

  async readSummary(runId: string): Promise<RunSummary | undefined> {
    const loc = await this.findRun(runId)
    if (!loc) return undefined
    return readJson<RunSummary>(join(loc.dir, SUMMARY_FILE))
  }

  async writeAgentRecord(runId: string, record: AgentRecord): Promise<string> {
    const text = JSON.stringify(record, null, 2)
    return this.serialize(`${runId}:agent:${record.index}`, async () => {
      const path = join(await this.runDir(runId), AGENTS_DIR, `${record.index}.json`)
      await mkdir(join(path, ".."), { recursive: true })
      await this.atomicWrite(path, text)
      return path
    })
  }

  async readAgentRecord(runId: string, index: number): Promise<AgentRecord | undefined> {
    const loc = await this.findRun(runId)
    if (!loc) return undefined
    return readJson<AgentRecord>(join(loc.dir, AGENTS_DIR, `${index}.json`))
  }

  /** Run summaries, newest first (startedAt desc, then runId desc). Runs without run.json are skipped. */
  async listRuns(sessionKey?: string): Promise<RunSummary[]> {
    const keys = sessionKey === undefined ? await this.sessionKeys() : [sanitizeSessionKey(sessionKey)]
    const out: RunSummary[] = []
    for (const key of keys) {
      for (const runId of await listDirs(join(this.root, key))) {
        if (!SAFE_ID.test(runId)) continue
        if (!this.locations.has(runId)) this.locations.set(runId, { runId, sessionKey: key, dir: join(this.root, key, runId) })
        const s = await readJson<RunSummary>(join(this.root, key, runId, SUMMARY_FILE))
        if (s) out.push(s)
      }
    }
    return out.sort((a, b) => b.startedAt - a.startedAt || (a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0))
  }

  private async sessionKeys(): Promise<string[]> {
    return listDirs(this.root)
  }

  private async atomicWrite(path: string, data: string): Promise<void> {
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
    try {
      await writeFile(tmp, data, "utf8")
      await this.renameWithRetry(tmp, path)
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => {})
      throw e
    }
  }

  /** rename(), retried with backoff while it fails with a transient Windows sharing error. */
  private async renameWithRetry(from: string, to: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.renameFn(from, to)
      } catch (e) {
        const code = (e as NodeJS.ErrnoException)?.code
        if (!code || !TRANSIENT_RENAME_CODES.has(code) || attempt >= this.renameRetryDelaysMs.length) throw e
        await new Promise((r) => setTimeout(r, this.renameRetryDelaysMs[attempt]))
      }
    }
  }

  /** Runs fn after every previously queued op with the same key (per-file write ordering). */
  private serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(key) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    const settled = next.then(
      () => {},
      () => {},
    )
    this.queues.set(key, settled)
    void settled.then(() => {
      if (this.queues.get(key) === settled) this.queues.delete(key)
    })
    return next
  }
}

function isJournalEntry(v: unknown): v is JournalEntry {
  if (!v || typeof v !== "object") return false
  const e = v as Record<string, unknown>
  return (
    e.type === "result" &&
    typeof e.index === "number" &&
    typeof e.key === "string" &&
    (e.status === "completed" || e.status === "failed" || e.status === "stopped")
  )
}

function isJournalMessage(v: unknown): v is JournalMessage {
  if (!v || typeof v !== "object") return false
  const e = v as Record<string, unknown>
  return e.type === "message" && typeof e.index === "number" && typeof e.id === "string"
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T
  } catch (e) {
    if (isNotFound(e) || e instanceof SyntaxError) return undefined
    throw e
  }
}

async function listDirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter((e) => e.isDirectory()).map((e) => e.name)
  } catch (e) {
    if (isNotFound(e)) return []
    throw e
  }
}
