// Live e2e (opencode 2.0.15), no model calls: command registration, /workflow-authoring (P58),
// /workflows on an empty session (P50) and the disable switch (P57). Enable with OPENCODE_E2E=1.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  createProject,
  e2eEnabled,
  startServer,
  syntheticEntries,
  waitForPlugin,
  waitUntil,
  type E2EProject,
  type E2EServer,
} from "./harness.ts"

async function newSession(server: E2EServer, project: E2EProject): Promise<string> {
  const s = await server.api(project, "POST", "/api/session", { title: "e2e commands", location: { directory: project.dir } })
  const id = (s?.data ?? s)?.id
  expect(id).toMatch(/^ses_/)
  return id
}

const commandNames = async (server: E2EServer, project: E2EProject): Promise<string[]> =>
  ((await server.api<{ data: { name: string }[] }>(project, "GET", "/api/command"))?.data ?? []).map((c) => c.name)

describe.skipIf(!e2eEnabled())("e2e commands (no model calls)", () => {
  let server: E2EServer
  let disabled: E2EServer
  beforeAll(async () => {
    ;[server, disabled] = await Promise.all([
      startServer({ label: "commands" }),
      startServer({ label: "disabled", env: { OPENCODE_DISABLE_WORKFLOWS: "1" } }),
    ])
  }, 120_000)
  afterAll(async () => {
    await Promise.all([server?.stop(), disabled?.stop()])
  }, 30_000)

  test(
    "P58 P50 P54 /workflow-authoring and /workflows post synthetic text without starting a turn",
    async () => {
      const project = createProject("commands")
      await waitForPlugin(server, project)
      const names = await commandNames(server, project)
      for (const n of ["workflows", "workflow-authoring", "deep-research"]) expect(names).toContain(n)

      const sid = await newSession(server, project)
      await server.api(project, "POST", `/api/session/${sid}/command`, { name: "workflow-authoring", text: "" })
      await server.api(project, "POST", `/api/session/${sid}/command`, { name: "workflows", text: "" })
      const synth = await waitUntil(
        async () => {
          const s = await syntheticEntries(server, project, sid)
          return s.length >= 2 ? s : undefined
        },
        { timeoutMs: 30_000, what: "two synthetic entries" },
      )
      const texts = synth.map((s) => s.text)
      expect(texts.some((t) => t.includes("Reference for writing") && t.includes("parallel(") && t.includes("pipeline("))).toBe(true)
      expect(texts.some((t) => t.includes("No workflow runs in this session."))).toBe(true)
      // resume:false -> no assistant turn was started (the entries wait in the inbox for the next turn)
      const msgs = await server.messages(project, sid)
      expect(msgs.filter((m) => m.type === "assistant")).toHaveLength(0)
    },
    120_000,
  )

  test(
    "P57 OPENCODE_DISABLE_WORKFLOWS=1 registers no workflow commands",
    async () => {
      const project = createProject("disabled")
      await waitForPlugin(disabled, project) // plugin loaded (setup ran) but registered nothing
      const names = await commandNames(disabled, project)
      expect(names.length).toBeGreaterThan(0) // builtins (init, review) are there
      expect(names).not.toContain("workflows")
      expect(names).not.toContain("workflow-authoring")
      expect(names).not.toContain("deep-research")
    },
    120_000,
  )
})
