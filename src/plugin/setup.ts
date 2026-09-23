// Plugin setup: registers the tools and commands and returns the cleanup that stops every run.

import { existsSync, watch, type FSWatcher } from "node:fs"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { listWorkflows, personalWorkflowsDir, projectWorkflowDirs, type RegistryOptions } from "../registry.ts"
import { createOpencodeRunner } from "../opencode/runner.ts"
import { createChildAskGuard, effectiveSessionRules } from "../opencode/permissions.ts"
import { createSubmitRegistry, createSubmitTool, type SubmitRegistry } from "../opencode/submit.ts"
import { RunStore } from "../store.ts"
import type { AgentRunner } from "../types.ts"
import { addCommands } from "./commands.ts"
import { largeWorkflowThreshold, resolveSizeGuideline, sizeGuidelineAdvice } from "./guideline.ts"
import { WorkflowHost } from "./host.ts"
import { CONTROL_TOOL_NAME, createControlTool, createWorkflowTool, WORKFLOW_TOOL_NAME, workflowToolDescription } from "./tools.ts"

export const PLUGIN_ID = "dynamic-workflows"
export const DISABLE_ENV = "OPENCODE_DISABLE_WORKFLOWS"

/** Injection seams (tests) and host overrides. Everything is optional. */
export interface PluginDeps {
  env?: Record<string, string | undefined>
  /** Run data root (default: plugin option `dataDir`, then defaultDataRoot()). */
  dataDir?: string
  store?: RunStore
  registryOptions?: RegistryOptions
  /** Replaces the opencode child-session runner (tests use FakeRunner). */
  createRunner?: (input: { ctx: Plugin.Context; parentSessionID: string; parentAgent?: string; runId: string; registry: SubmitRegistry }) => AgentRunner
  /** Watch the saved-workflow directories and reload commands on change. Default true. */
  watch?: boolean
  now?: () => number
  summaryThrottleMs?: number
  /** Parent-location keep-alive period while a run is active (default KEEP_ALIVE_MS; 0 disables). */
  keepAliveMs?: number
}

const TRUTHY = /^(1|true|yes|on)$/i

/** P57: env OPENCODE_DISABLE_WORKFLOWS=1 (true/yes/on) or plugin option `disabled: true`. */
export function isDisabled(env: Record<string, string | undefined>, options: Record<string, unknown> | undefined): boolean {
  const raw = env[DISABLE_ENV]
  if (raw !== undefined && TRUTHY.test(raw.trim())) return true
  const opt = options?.disabled
  return opt === true || (typeof opt === "string" && TRUTHY.test(opt.trim()))
}

export async function setupPlugin(ctx: Plugin.Context, deps: PluginDeps = {}): Promise<Plugin.Cleanup | void> {
  const env = deps.env ?? process.env
  const options = (ctx.options ?? {}) as Record<string, unknown>
  if (isDisabled(env, options)) return

  const cwd = String(ctx.location.directory)
  const registryOptions: RegistryOptions = { env, ...deps.registryOptions }
  const dataDir = deps.dataDir ?? (typeof options.dataDir === "string" && options.dataDir ? options.dataDir : undefined)
  const store = deps.store ?? new RunStore(dataDir ? { root: dataDir } : {})
  const submitRegistry = createSubmitRegistry(ctx.storage)

  const createRunner =
    deps.createRunner ??
    ((input: { ctx: Plugin.Context; parentSessionID: string; parentAgent?: string; runId: string; registry: SubmitRegistry }) =>
      createOpencodeRunner(input.ctx, {
        parentSessionID: input.parentSessionID,
        parentAgent: input.parentAgent,
        runId: input.runId,
        registry: input.registry,
        // P60: workflow agents can neither launch nor manage workflows.
        deniedTools: [WORKFLOW_TOOL_NAME, CONTROL_TOOL_NAME],
      }))

  const sizeGuideline = resolveSizeGuideline(env, options)
  const sizeAdvice = sizeGuidelineAdvice(sizeGuideline)

  // Saved workflows appear both as /<name> commands and in the `workflow` tool description (P59),
  // so a change reloads both.
  const reloadCommands = async () => {
    await ctx.command.reload()
    await ctx.tool.reload?.()
  }

  const host = new WorkflowHost({
    cwd,
    store,
    registryOptions,
    createRunner: ({ parentSessionID, parentAgent, runId }) =>
      createRunner({ ctx, parentSessionID, parentAgent, runId, registry: submitRegistry }),
    notify: (input) => ctx.session.synthetic(input as any),
    onSaved: reloadCommands,
    now: deps.now,
    summaryThrottleMs: deps.summaryThrottleMs,
    largeWorkflowThreshold: largeWorkflowThreshold(sizeGuideline),
    // opencode evicts a location (disposing this plugin and its runs) after 60 min without session
    // events there. Renaming the parent to its current title is a no-op durable event that keeps it.
    keepAlive: async (sessionID) => {
      const info = (await ctx.session.get({ sessionID } as any)) as any
      if (typeof info?.title === "string") await ctx.session.update({ sessionID, title: info.title } as any)
    },
    keepAliveMs: deps.keepAliveMs,
    // P76: scriptPath reads honour the caller's read/external_directory rules, like opencode's read tool.
    projectRoots: projectRoot(ctx),
    permissionRules: (sessionID, agent) => effectiveSessionRules(ctx, sessionID, agent),
  })

  const registrations: { dispose: () => Promise<void> }[] = []
  // P63: an "ask" in a workflow child would wait forever (nobody sees that session): deny it instead.
  // Registered by every instance, so a worktree instance guards the children in its own location.
  const permissionHook = (ctx as any).permission?.hook as Plugin.Context["permission"]["hook"] | undefined
  if (typeof permissionHook === "function") {
    registrations.push(await permissionHook("evaluate", createChildAskGuard(ctx)))
  }
  registrations.push(
    await ctx.tool.transform((editor) => {
      let saved: ReturnType<typeof listWorkflows> = []
      try {
        saved = listWorkflows(cwd, registryOptions)
      } catch {}
      editor.add(createWorkflowTool(host, workflowToolDescription({ saved, sizeAdvice })))
      editor.add(createControlTool(host))
      editor.add(createSubmitTool(submitRegistry))
    }),
  )
  registrations.push(
    await ctx.command.transform((editor) => {
      addCommands(editor, {
        host,
        cwd,
        registryOptions,
        reload: reloadCommands,
        session: {
          synthetic: (input) => ctx.session.synthetic(input as any),
          prompt: (input) => ctx.session.prompt(input),
        },
      })
    }),
  )

  const watchers = deps.watch === false ? [] : watchWorkflowDirs(cwd, registryOptions, reloadCommands)

  return async () => {
    for (const w of watchers) {
      try {
        w.close()
      } catch {}
    }
    await host.dispose()
    for (const r of registrations) {
      try {
        await r.dispose()
      } catch {}
    }
  }
}

/** Reloads commands (debounced) when a saved-workflow directory changes (P53). Best effort. */
function watchWorkflowDirs(cwd: string, registryOptions: RegistryOptions, reload: () => Promise<void>): FSWatcher[] {
  const dirs = [...projectWorkflowDirs(cwd)]
  try {
    dirs.push(
      registryOptions.configHome
        ? join(registryOptions.configHome, "opencode", "workflows")
        : personalWorkflowsDir(registryOptions.env ?? process.env, registryOptions.home),
    )
  } catch {}
  let timer: ReturnType<typeof setTimeout> | undefined
  const trigger = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void reload().catch(() => {}), 250)
    ;(timer as any).unref?.()
  }
  const out: FSWatcher[] = []
  for (const d of dirs) {
    if (!existsSync(d)) continue
    try {
      const w = watch(d, { persistent: false }, trigger)
      w.on("error", () => {})
      out.push(w)
    } catch {}
  }
  return out
}

/** The project (worktree) root, which opencode's file access also treats as internal. */
function projectRoot(ctx: Plugin.Context): string[] {
  const dir = (ctx.location as any)?.project?.directory
  return typeof dir === "string" && dir ? [dir] : []
}
