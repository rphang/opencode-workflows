// Throwaway live spike: captures real opencode 2.0.15 shapes for the runner.
// Loaded from .sandbox/rproj/.opencode/plugins/loader.js. Logs to $SPIKE_LOG.
import { appendFileSync } from "node:fs"
const L = (...a) =>
  appendFileSync(
    process.env.SPIKE_LOG,
    a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ") + "\n",
  )

export default {
  id: "spike-explore",
  async setup(ctx) {
    L("setup", ctx.location)
    await ctx.session.hook("context", (input) => {
      L("HOOK context", input.sessionID, input.agent, Object.keys(input.tools).sort())
    })
    await ctx.tool.transform((e) => {
      e.add({
        name: "workflow",
        description: "Dummy workflow tool (spike). Never call it.",
        input: { type: "object", properties: {} },
        options: { codemode: false },
        execute: async () => ({ content: "noop" }),
      })
      e.add({
        name: "spike_probe",
        description: "Probe tool. Call it with {mode: string}.",
        input: { type: "object", properties: { mode: { type: "string" } }, required: ["mode"] },
        options: { codemode: false },
        execute: async (input, tctx) => {
          try {
            L("probe from", ctx.location.directory, tctx.sessionID, input)
            const stored = await ctx.storage.get("xloc")
            L("probe storage xloc", stored)
            await ctx.storage.set("probe-" + tctx.sessionID, { at: ctx.location.directory })
            return { content: "probe ok from " + ctx.location.directory }
          } catch (e) {
            L("probe ERR", String(e))
            return { content: "err" }
          }
        },
      })
      e.add({
        name: "spike_rt",
        description: "Runner spike. Call it with {q: string}.",
        input: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
        options: { codemode: false },
        execute: async (input, tctx) => {
          const step = async (name, fn) => {
            try {
              const r = await fn()
              L("OK", name, r)
              return r
            } catch (e) {
              L("ERR", name, String(e), e && e._tag, e && JSON.stringify(e))
            }
          }
          const parent = await step("parent.get", () => ctx.session.get({ sessionID: tctx.sessionID }))
          const models = await step("model.list", async () => {
            const r = await ctx.model.list()
            return {
              keys: Object.keys(r),
              n: r.data.length,
              sample: r.data
                .filter((m) => m.providerID === "openai" && /gpt-5.4-mini|gpt-5$/.test(m.id))
                .map((m) => ({ id: m.id, modelID: m.modelID, providerID: m.providerID, variants: m.variants.map((v) => v.id), enabled: m.enabled })),
              opencodeFree: r.data.filter((m) => m.providerID === "opencode").slice(0, 3).map((m) => ({ id: m.id, variants: m.variants.map((v) => v.id) })),
            }
          })
          await step("storage.set xloc", () => ctx.storage.set("xloc", { from: "parent-instance" }))
          // 1. permissions: deny workflow
          const perms = [...(parent?.permissions ?? []), { action: "workflow", resource: "*", effect: "deny" }]
          const c1 = await step("create denied", () =>
            ctx.session.create({
              title: "[wf:spike] denied",
              metadata: { workflowRunId: "spike", workflowAgentIndex: 0 },
              model: parent.model,
              permissions: perms,
            }),
          )
          await step("prompt c1", () => ctx.session.prompt({ sessionID: c1.id, text: "List the exact names of every tool you have, comma separated, nothing else." }))
          await step("wait c1", () => ctx.session.wait({ sessionID: c1.id }))
          await step("get c1", () => ctx.session.get({ sessionID: c1.id }))
          const cx1 = await step("context c1", () => ctx.session.context({ sessionID: c1.id }))
          // 2. worktree
          const wt = await step("worktree.create", () => ctx.worktree.create({ projectID: parent.projectID, name: "wf-spike-" + Date.now() }))
          if (wt) {
            const c2 = await step("create in worktree", () =>
              ctx.session.create({ title: "[wf:spike] wt", model: parent.model, location: { directory: wt.directory } }),
            )
            await step("prompt c2", () =>
              ctx.session.prompt({ sessionID: c2.id, text: "Call the spike_probe tool with mode 'wt'. Then reply DONE." }),
            )
            await step("wait c2", () => ctx.session.wait({ sessionID: c2.id }))
            await step("get c2", () => ctx.session.get({ sessionID: c2.id }))
            await step("context c2", () => ctx.session.context({ sessionID: c2.id }))
            await step("vcs.status wt", () => ctx.vcs.status({ location: { directory: wt.directory } }))
            await step("worktree.list", () => ctx.worktree.list({ projectID: parent.projectID }))
            await step("worktree.remove", () => ctx.worktree.remove({ projectID: parent.projectID, directory: wt.directory, force: false }))
          }
          // 3. interrupt
          const c3 = await step("create c3", () => ctx.session.create({ title: "[wf:spike] int", model: parent.model }))
          await step("prompt c3", () => ctx.session.prompt({ sessionID: c3.id, text: "Write a 2000-word essay about the ocean." }))
          await new Promise((r) => setTimeout(r, 2500))
          await step("interrupt c3", () => ctx.session.interrupt({ sessionID: c3.id }))
          await step("wait c3", () => ctx.session.wait({ sessionID: c3.id }))
          await step("get c3", () => ctx.session.get({ sessionID: c3.id }))
          await step("context c3", () => ctx.session.context({ sessionID: c3.id }))
          // 4. bad model -> failure
          const c4 = await step("create c4", () => ctx.session.create({ title: "[wf:spike] bad", model: { providerID: "openai", id: "no-such-model-xyz" } }))
          await step("prompt c4", () => ctx.session.prompt({ sessionID: c4.id, text: "hi" }))
          await step("wait c4", () => Promise.race([ctx.session.wait({ sessionID: c4.id }), new Promise((r) => setTimeout(() => r("TIMEOUT"), 30000))]))
          await step("get c4", () => ctx.session.get({ sessionID: c4.id }))
          await step("context c4", () => ctx.session.context({ sessionID: c4.id }))
          // 5. variant
          const c5 = await step("create c5 variant", () => ctx.session.create({ title: "[wf:spike] var", model: { ...parent.model, variant: "high" } }))
          await step("get c5", () => ctx.session.get({ sessionID: c5.id }))
          return { content: "spike done" }
        },
      })
    })
    L("registered")
  },
}
