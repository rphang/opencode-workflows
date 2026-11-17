// Background jobs of a workflow child (opencode 2.3+; PARITY X31).
//
// opencode 2.3's `subagent` tool always runs in the background: the call returns at once, the
// child's turn can end, and the job's `<subagent>` report wakes the child later into a new
// execution (core/tool/plugin/subagent.ts). session.wait() awaits executions, not jobs, and a job
// is visible to a plugin only in the `experimental.idle` event's `background` list. So the idle hook
// reports the child's own jobs here and the runner keeps waiting after wait() while the latest
// report lists any, then reads the reply that followed the report.
//
// Reports go to ctx.storage (shared by every instance of the plugin) because a worktree child's
// hook runs in the worktree instance. The runner opens a record when the child exists and removes
// it when the agent settles; a hook only writes a record that exists, so a report that wakes the
// child after it settled leaves nothing behind.
//
// Only subagent and image jobs are waited for: they finish and report. A background shell (a dev
// server, a watcher) may run for good; it is listed for information only, as core/plugin/goal.ts does.

import type { StorageLike } from "./submit.ts"

export const JOBS_STORAGE_PREFIX = "workflow-jobs/"

/** Default cap on how long the runner waits for an agent's background jobs. */
export const BACKGROUND_WAIT_MS = 30 * 60_000

/** The job kinds whose completion report wakes the child (and that therefore end). */
export const AWAITED_JOB_KINDS: readonly string[] = ["subagent", "image"]

export interface BackgroundJob {
  kind: string
  /** subagent: its description; image: its path. */
  label?: string
}

export interface JobReport {
  /** Bumped by every report; 0 = opened by the runner, nothing reported yet. */
  seq: number
  jobs: BackgroundJob[]
}

export interface JobTracker {
  /** Runner: the child exists; the hook's reports count from now on. */
  open(sessionID: string): Promise<void>
  /**
   * Hook: the child's own jobs as the execution ends. A child this instance does not run (`live`
   * false) is only reported while its record exists.
   */
  report(sessionID: string, jobs: BackgroundJob[], live: boolean): Promise<void>
  read(sessionID: string): Promise<JobReport | undefined>
  /** Runner: the agent settled. */
  close(sessionID: string): Promise<void>
}

/** The awaited own jobs of `sessionID` in an `experimental.idle` event's `background` list. */
export function ownJobs(sessionID: string, background: ReadonlyArray<Record<string, unknown>> | undefined): BackgroundJob[] {
  const out: BackgroundJob[] = []
  for (const w of background ?? []) {
    if (!w || w.sessionID !== sessionID || !AWAITED_JOB_KINDS.includes(String(w.kind))) continue
    const label = typeof w.description === "string" ? w.description : typeof w.path === "string" ? w.path : undefined
    out.push({ kind: String(w.kind), ...(label ? { label: label.slice(0, 120) } : {}) })
  }
  return out
}

function isReport(v: unknown): v is JobReport {
  return typeof v === "object" && v !== null && typeof (v as JobReport).seq === "number" && Array.isArray((v as JobReport).jobs)
}

export function createJobTracker(storage?: StorageLike): JobTracker {
  const mem = new Map<string, JobReport>()
  const key = (id: string) => JOBS_STORAGE_PREFIX + id

  async function stored(sessionID: string): Promise<{ readable: boolean; report?: JobReport }> {
    if (!storage) return { readable: false }
    try {
      const v = await storage.get(key(sessionID))
      return { readable: true, report: isReport(v) ? v : undefined }
    } catch {
      return { readable: false }
    }
  }

  async function write(sessionID: string, report: JobReport) {
    mem.set(sessionID, report)
    if (!storage) return
    try {
      await storage.set(key(sessionID), JSON.parse(JSON.stringify(report)))
    } catch {
      // best effort: this instance's memory still has it
    }
  }

  async function read(sessionID: string): Promise<JobReport | undefined> {
    const local = mem.get(sessionID)
    const s = await stored(sessionID)
    if (s.readable && !s.report) {
      mem.delete(sessionID)
      return undefined
    }
    const best = !s.report ? local : !local || s.report.seq >= local.seq ? s.report : local
    return best ? structuredClone(best) : undefined
  }

  return {
    async open(sessionID) {
      await write(sessionID, { seq: 0, jobs: [] })
    },
    async report(sessionID, jobs, live) {
      const prev = live && mem.has(sessionID) ? mem.get(sessionID) : await read(sessionID)
      if (!prev) return // not a running agent's child any more (or never opened)
      if (!jobs.length && !prev.jobs.length) return // nothing new
      await write(sessionID, { seq: prev.seq + 1, jobs })
    },
    read,
    async close(sessionID) {
      mem.delete(sessionID)
      if (!storage) return
      try {
        await storage.remove(key(sessionID))
      } catch {
        // best effort
      }
    },
  }
}
