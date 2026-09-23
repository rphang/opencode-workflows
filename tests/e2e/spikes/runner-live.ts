// Throwaway live check of src/opencode/runner.ts against real opencode 2.0.15.
// Loaded via .sandbox/rproj/.opencode/plugins/loader.js (committed in that repo so worktrees load it too).
// Run: see docs/OPENCODE-API-NOTES.md ("Live verification recipe"). Logs JSON lines to $SPIKE_LOG.
import { appendFileSync, existsSync } from "node:fs"
import { createOpencodeRunner } from "../../../src/opencode/runner.ts"
import { createSubmitRegistry, createSubmitTool } from "../../../src/opencode/submit.ts"
import type { AgentOptions, AgentRecord } from "../../../src/types.ts"

const L = (...a: unknown[]) =>
  appendFileSync(
    process.env.SPIKE_LOG!,
    a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ") + "\n",
  )

export default {
  id: "wf-runner-live",
  async setup(ctx: any) {
    L("setup", ctx.location.directory)
    const registry = createSubmitRegistry(ctx.storage)
    await ctx.session.hook("context", (input: any) => {
      L("TOOLS", input.sessionID, Object.keys(input.tools).sort().join(","))
    })
    await ctx.tool.transform((e: any) => {
      e.add(createSubmitTool(registry))
      e.add({
        name: "workflow",
        description: "Dummy workflow tool (live spike). Never call it.",
        input: { type: "object", properties: {} },
        options: { codemode: false },
        execute: async () => ({ content: "noop" }),
      })
      e.add({
        name: "rt_live",
        description: "Runner live test. Call it with {mode: string}.",
        input: { type: "object", properties: { mode: { type: "string" } }, required: ["mode"] },
        options: { codemode: false },
        execute: async (input: any, tctx: any) => {
          const runner = createOpencodeRunner(ctx, { parentSessionID: tctx.sessionID, runId: "live1", registry })
          const modes = String(input.mode).split(",")
          let index = 0
          const go = async (name: string, prompt: string, opts: AgentOptions, abortAfterMs?: number) => {
            if (!modes.includes("all") && !modes.includes(name)) return
            const controller = new AbortController()
            const updates: Partial<AgentRecord>[] = []
            if (abortAfterMs) setTimeout(() => controller.abort(), abortAfterMs)
            const t0 = Date.now()
            try {
              const out = await runner.run({
                runId: "live1",
                index: index++,
                prompt,
                opts,
                signal: controller.signal,
                onUpdate: (u) => updates.push(u),
              })
              const child = out.sessionID ? await ctx.session.get({ sessionID: out.sessionID }) : undefined
              L("RESULT", name, { ms: Date.now() - t0, out, updates, child: child && { model: child.model, outcome: child.outcome, title: child.title, metadata: child.metadata, permissions: child.permissions, location: child.location } })
              const wt = updates.find((u) => u.worktree)?.worktree
              if (wt) L("WORKTREE-KEPT", name, wt, existsSync(wt))
            } catch (e: any) {
              L("THROW", name, String(e), e?.stack)
            }
          }
          await go("plain", "Reply with exactly: PLAIN-OK", { label: "plain" })
          await go("schema", "The color is blue and the number is 3. Report them.", {
            label: "schema",
            schema: { type: "object", properties: { color: { type: "string" }, n: { type: "number" } }, required: ["color", "n"], additionalProperties: false },
          })
          await go("effort", "Reply with exactly: EFFORT-OK", { label: "effort", effort: "high" })
          await go("abort", "Write a 3000-word essay about the history of the ocean. Do not use tools.", { label: "abort" }, 3000)
          await go("wtclean", "Reply with exactly: WT-OK. Do not use any tools.", { label: "wtclean", isolation: "worktree" })
          await go("wtdirty", "Create a new file named hello.txt containing the word hi in the current working directory (use your file editing tool), then reply DONE.", { label: "wtdirty", isolation: "worktree" })
          await go("wtschema", "The answer is 42. Report it.", {
            label: "wtschema",
            isolation: "worktree",
            schema: { type: "object", properties: { answer: { type: "number" } }, required: ["answer"] },
          })
          await go("retry", "Submit the code value 'abc' exactly as given (do not transform it yourself unless the tool rejects it).", {
            label: "retry",
            schema: { type: "object", properties: { code: { type: "string", pattern: "^ZX-[0-9]{4}$" } }, required: ["code"] },
          })
          return { content: "rt_live done" }
        },
      })
    })
  },
}
