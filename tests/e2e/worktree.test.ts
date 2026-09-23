// Live e2e (opencode 2.0.15): isolation:'worktree' runs agents in fresh git worktrees; an unchanged
// worktree is removed, a changed one is kept and reported (P28). Enable with OPENCODE_E2E=1.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import {
  createProject,
  e2eEnabled,
  launchPrompt,
  readTranscript,
  recordRunCost,
  runPrompt,
  startServer,
  waitForNotification,
  workflowToolCalls,
  type E2EProject,
  type E2EServer,
} from "./harness.ts"

const SCRIPT = `export const meta = { name: "e2e-worktree", description: "worktree isolation" }
const [clean, dirty] = await parallel([
  () => agent("Reply with exactly: WT-CLEAN. Do not use any tools.", { label: "clean", isolation: "worktree" }),
  () => agent("Create a new file named wt-proof.txt in the current working directory containing exactly the text PROOF (use your file writing tool). Then reply DONE.", { label: "dirty", isolation: "worktree" }),
])
return { clean, dirty }
`

describe.skipIf(!e2eEnabled())("e2e worktree", () => {
  let server: E2EServer
  let project: E2EProject | undefined
  const kept: string[] = []
  beforeAll(async () => {
    server = await startServer({ label: "worktree" })
  }, 120_000)
  afterAll(async () => {
    await server?.stop()
    for (const dir of kept) {
      try {
        project?.git("worktree", "remove", "--force", dir)
      } catch {}
    }
  }, 60_000)

  test(
    "P28 worktree agents: clean worktree removed, changed worktree kept with the file",
    async () => {
      project = createProject("worktree")
      const r = await runPrompt(server, project, launchPrompt({ script: SCRIPT }), { label: "worktree" })
      const [call] = workflowToolCalls(r.events)
      expect(call?.output?.error).toBeUndefined()
      const runId = call.output!.runId!
      const { notification } = await waitForNotification(server, project, r.sessionID!, runId)
      expect(notification.status).toBe("completed")
      expect(String((notification.result as any).clean)).toContain("WT-CLEAN")

      const t = readTranscript(call.output!.transcriptDir!)
      recordRunCost("worktree", t.summary)
      const [clean, dirty] = t.agents
      expect(clean.status).toBe("completed")
      expect(dirty.status).toBe("completed")

      // Both children ran inside a worktree named wf-<runId>-<index>, not in the project.
      for (const a of [clean, dirty]) {
        const s = await server.session(project, a.sessionID!)
        const dir = String((s?.data ?? s).location?.directory ?? "")
        expect(dir).toContain(`wf-${runId}-${a.index}`)
        expect(resolve(dir)).not.toBe(resolve(project.dir))
      }

      // Clean one: removed, no worktree reported.
      expect(clean.worktree).toBeUndefined()
      const wtRoots = existsSync(server.worktreeRoot) ? readdirSync(server.worktreeRoot) : []
      for (const root of wtRoots) expect(existsSync(join(server.worktreeRoot, root, `wf-${runId}-0`))).toBe(false)

      // Dirty one: kept, reported on the agent record, file lives only in the worktree.
      expect(dirty.worktree).toBeDefined()
      kept.push(dirty.worktree!)
      expect(existsSync(join(dirty.worktree!, "wt-proof.txt"))).toBe(true)
      expect(readFileSync(join(dirty.worktree!, "wt-proof.txt"), "utf8")).toContain("PROOF")
      expect(existsSync(join(project.dir, "wt-proof.txt"))).toBe(false)
      expect(project.git("worktree", "list")).toContain(`wf-${runId}-1`)
    },
    600_000,
  )
})
