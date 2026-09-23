// Parity: the examples from the Claude Code workflows docs (https://code.claude.com/docs/en/workflows),
// run end to end.
//  - "What the saved script looks like": the audit-routes script (P10, P12, P20, P21, P23, P30, P53)
//  - the bundled /deep-research workflow (P54) with every agent faked
// (The A, B-fails, C, D resume example is in runs-resume.test.ts, P41.)

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { AgentRequest } from "../../src/types.ts"
import { FakeRunner } from "../helpers/fake-runner.ts"
import { createHarness, tag, type Harness } from "../helpers/plugin-harness.ts"

let h: Harness
beforeEach(async () => {
  h = await createHarness()
})
afterEach(async () => {
  await h.dispose()
})

// Verbatim from the Claude Code docs ("What the saved script looks like").
const AUDIT_ROUTES = `export const meta = {
  name: 'audit-routes',
  description: 'Audit every route handler for missing auth checks',
}

const found = await agent('List every .ts file under src/routes/.', {
  schema: { type: 'object', required: ['files'], properties: { files: { type: 'array', items: { type: 'string' } } } },
})

const audits = await pipeline(found.files, file =>
  agent(\`Audit \${file} for missing authentication checks.\`, { label: file }),
)

return audits.filter(Boolean)
`

const ROUTES = ["src/routes/users.ts", "src/routes/admin.ts", "src/routes/health.ts"]

describe("doc example: audit-routes", () => {
  test("P12 P21 P30 audit-routes runs verbatim: schema agent → pipeline per file → filter(Boolean) drops the null", async () => {
    const runner = new FakeRunner()
      .on("List every .ts file", { value: { files: ROUTES } })
      .on("Audit src/routes/", (req) => ({ value: `${req.opts.label}: ok` }))
      .on("admin.ts", { status: "failed", error: "API error" }) // unrecoverable API error → null
    const p = await h.setup({ runner })
    const out = await p.call({ script: AUDIT_ROUTES })
    expect(out.error).toBeUndefined()
    expect(out.workflowName).toBe("audit-routes")
    const n = await p.notification(0)
    expect(tag(String(n.text), "status")).toBe("completed")
    expect(p.resultOf(n)).toEqual(["src/routes/users.ts: ok", "src/routes/health.ts: ok"])
    expect(runner.calls.map((c) => c.opts.label ?? null)).toEqual([null, ...ROUTES])
    expect(tag(String(n.text), "usage")).toMatch(/agent_count: 4/)
  })

  test("P20 P21 P62 audit-routes with the real opencode runner: structured output through workflow_submit", async () => {
    const p = await h.setup({
      real: true,
      fake: {
        // The runner prefixes every child prompt with a subagent preamble ending in "Your task:" (P78); the fake model reads the task after it.
        respond: ({ text }) => {
          const marker = "Your task:\n\n"
          const task = text.slice(text.indexOf(marker) + marker.length)
          return task.startsWith("List every .ts file") ? { submit: [{ files: ROUTES.slice(0, 2) }], text: "done" } : { text: `audited: ${task.split(" ")[1]}` }
        },
      },
    })
    const out = await p.call({ script: AUDIT_ROUTES })
    expect(p.resultOf(await p.notification(0))).toEqual(["audited: src/routes/users.ts", "audited: src/routes/admin.ts"])
    const titles = p.fake.calls.create.map((c: any) => c.title)
    expect(titles).toEqual([
      `[wf:${out.runId}] List every .ts file under src/routes/.`,
      `[wf:${out.runId}] src/routes/users.ts`,
      `[wf:${out.runId}] src/routes/admin.ts`,
    ])
  })

  test("P53 audit-routes saved in .opencode/workflows runs as /audit-routes", async () => {
    mkdirSync(join(h.projectDir, ".opencode", "workflows"), { recursive: true })
    writeFileSync(join(h.projectDir, ".opencode", "workflows", "audit-routes.js"), AUDIT_ROUTES)
    const runner = new FakeRunner().on("List every .ts file", { value: { files: ["src/routes/a.ts"] } })
    const p = await h.setup({ runner })
    expect(p.commands().get("audit-routes")!.description).toContain("Audit every route handler")
    await p.command("audit-routes")
    const input = JSON.parse(String(p.prompts.at(-1).text).match(/\{"name".*\}/)![0])
    await p.call(input)
    expect(p.resultOf(await p.notification(0))).toEqual(["done: Audit src/routes/a.ts for missing authentication checks."])
  })

  test("P41 P44 stopping the whole audit run mid-fan-out, then resuming: cached prefix, the rest reruns", async () => {
    const runner = new FakeRunner().on("List every .ts file", { value: { files: ROUTES } }).on("admin.ts", { hold: true })
    const p = await h.setup({ runner })
    const out = await p.call({ script: AUDIT_ROUTES })
    await runner.waitForHeld(1)
    await p.control({ action: "stop", runId: out.runId })
    const n = await p.notification(0)
    expect(tag(String(n.text), "status")).toBe("stopped")
    await p.settled(out.runId!)

    const r2 = new FakeRunner().on("List every .ts file", { value: { files: ["changed.ts"] } })
    const p2 = await h.setup({ runner: r2 })
    await p2.call({ script: AUDIT_ROUTES, resumeFromRunId: out.runId })
    const res = p2.resultOf(await p2.notification(0)) as string[]
    expect(res.length).toBe(3)
    // The listing (#0, completed) comes from cache — so the stale "changed.ts" listing is never used —
    // and the users audit (#1) too. The stopped admin audit (#2) starts over, and so does every agent
    // STARTED after it (#3 health), even though it had completed.
    expect(r2.prompts.sort()).toEqual([
      "Audit src/routes/admin.ts for missing authentication checks.",
      "Audit src/routes/health.ts for missing authentication checks.",
    ])
  })
})

describe("doc example: /deep-research", () => {
  function deepResearchRunner() {
    const angle = (req: AgentRequest) => (req.opts.label ?? "").replace(/^(Research|Extract): /, "")
    return new FakeRunner()
      .on("You are planning web research", {
        value: {
          angles: [
            { title: "Official", query: "node docs" },
            { title: "Changelog", query: "node changelog" },
            { title: "Discussion", query: "issues" },
          ],
        },
      })
      .on("Research one angle", (req) => ({ value: `notes for ${angle(req)}: fact (https://example.com/${angle(req)})` }))
      .on("Extract atomic factual claims", (req) => ({
        value: { claims: [{ claim: `Claim from ${angle(req)}`, sources: [{ url: `https://example.com/${angle(req)}` }], confidence: "high" }] },
      }))
      .on("skeptical fact-checker", (req) => {
        if (req.prompt.includes("Claim from Changelog")) return { value: { refuted: true, couldNotCheck: false, reasoning: "outdated" } }
        if (req.prompt.includes("Claim from Discussion")) return { status: "failed", error: "rate limited" }
        return { value: { refuted: false, couldNotCheck: false, reasoning: "supported" } }
      })
      .on("Write the final research report", (req) => ({ value: `# REPORT\n${req.prompt}` }))
  }

  test("P54 /deep-research end to end: plan → research/extract pipeline → 3 skeptics per claim → report", async () => {
    const runner = deepResearchRunner()
    const p = await h.setup({ runner })
    const out = await p.call({ name: "deep-research", args: "What changed in the Node.js permission model between v20 and v22?" })
    expect(out.error).toBeUndefined()
    const n = await p.notification(0, 20000)
    expect(tag(String(n.text), "status")).toBe("completed")
    const report = String(p.resultOf(n))
    expect(report.startsWith("# REPORT")).toBe(true)
    const verifiedPart = report.slice(report.indexOf("VERIFIED CLAIMS"), report.indexOf("UNVERIFIED CLAIMS"))
    const unverifiedPart = report.slice(report.indexOf("UNVERIFIED CLAIMS"))
    // verified: all 3 skeptics support
    expect(verifiedPart).toContain("Claim from Official")
    // refuted by majority: dropped
    expect(report).not.toContain("Claim from Changelog")
    // verifiers errored (rate limit): listed as unverified, NOT counted as refuted
    expect(unverifiedPart).toContain("Claim from Discussion")
    expect(report).toContain("1 other claim(s) were refuted")
    // 1 plan + 3 research + 3 extract + 9 skeptics + 1 report
    expect(runner.calls.length).toBe(17)
    await p.settled(out.runId!)
    const s = await h.store.readSummary(out.runId!)
    expect(s!.phases.map((x) => [x.title, x.agents])).toEqual([
      ["Plan", 1],
      ["Research", 3],
      ["Extract", 3],
      ["Verify", 9],
      ["Synthesize", 1],
    ])
  })

  test("P54 deep-research: skeptics whose web tools failed abstain (couldNotCheck); a tool outage is never a refutation", async () => {
    const runner = deepResearchRunner().on("skeptical fact-checker", (req) =>
      req.prompt.includes("Claim from Official")
        ? { value: { refuted: true, couldNotCheck: true, reasoning: "websearch failed: Web search cancelled" } }
        : { value: { refuted: false, couldNotCheck: false, reasoning: "supported" } },
    )
    const p = await h.setup({ runner })
    const out = await p.call({ name: "deep-research", args: "q?" })
    const report = String(p.resultOf(await p.notification(0, 20000)))
    const unverifiedPart = report.slice(report.indexOf("UNVERIFIED CLAIMS"))
    expect(unverifiedPart).toContain("Claim from Official")
    expect(report).toContain("0 other claim(s) were refuted")
    await p.settled(out.runId!)
  })

  test("P54 deep-research skeptic prompt reserves refuted=true for evidence and asks for couldNotCheck on tool failure", async () => {
    const runner = deepResearchRunner()
    const p = await h.setup({ runner })
    const out = await p.call({ name: "deep-research", args: "q?" })
    await p.notification(0, 20000)
    await p.settled(out.runId!)
    const skeptic = runner.calls.find((c) => c.prompt.includes("skeptical fact-checker"))!
    expect(skeptic.prompt).toContain("couldNotCheck")
    expect(skeptic.prompt).not.toMatch(/default to refuted=true if you cannot find support/)
    expect(JSON.stringify(skeptic.opts.schema)).toContain("couldNotCheck")
    const researcher = runner.calls.find((c) => c.prompt.includes("Research one angle"))!
    expect(researcher.prompt).toContain("NO_WEB_ACCESS")
  })

  test("P54 deep-research stops early with a setup hint when most researchers report NO_WEB_ACCESS", async () => {
    const runner = deepResearchRunner().on("Research one angle", { value: "NO_WEB_ACCESS" })
    const p = await h.setup({ runner })
    const out = await p.call({ name: "deep-research", args: "q?" })
    const n = await p.notification(0, 20000)
    expect(tag(String(n.text), "status")).toBe("completed")
    const result = String(p.resultOf(n))
    expect(result).toMatch(/web search/i)
    expect(result).toContain("3 of 3")
    // nothing is extracted from memory and no skeptic runs
    expect(runner.prompts.some((x) => x.includes("Extract atomic factual claims"))).toBe(false)
    expect(runner.prompts.some((x) => x.includes("skeptical fact-checker"))).toBe(false)
    await p.settled(out.runId!)
  })
})
