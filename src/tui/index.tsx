// TUI companion of @rphang/opencode-workflows: the live progress tree (X14–X16).
//
// opencode loads it for every active server plugin whose package has a `./tui` entry (Host.resolve →
// features.tui): `exports["./tui"]` → dist/tui.js for package installs, and the repo-root tui.tsx for
// directory installs. It talks to the server plugin only through the `dynamic-workflows` RPC:
//   calls  list / status / control   → sent to the viewed session's Location (the run's parent)
//   events delta / finished          → one global stream, filtered here by Location and session
//
// Surfaces: the prompt footer (`wf <name> 7/12 · 81.2k · $0.42`), the home footer (`wf 2 running`), a
// session panel "workflows" with the tree (<leader>o, /wf), <leader>j to message an agent, and a
// desktop notification (or a toast) when a run finishes. If the RPC is unavailable (plugin disabled,
// older opencode) it stays silent; /workflows keeps working.

import { createMemo, createSignal, Show } from "solid-js"
import { TreeSync } from "../client/sync.ts"
import type { AgentView } from "../plugin/live.ts"
import { definition } from "../plugin/rpc-def.ts"
import { Panel } from "./panel.tsx"
import {
  footerParts,
  homeFooterText,
  isActive,
  isOpen,
  notifyFinished,
  rowsFor,
  targetFor,
  TreeStore,
  type Action,
  type ControlRequest,
  type Expanded,
  type Filter,
} from "./store.ts"

export const PANEL = "workflows"
const RESYNC_MS = 15_000
const TICK_MS = 1_000

function errText(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message)
  return String(e)
}

function clip(s: string, n = 400): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

const plugin = {
  id: "dynamic-workflows.tui",
  setup(ctx: any) {
    const rpc = ctx.client.rpc(definition)
    const tree = new TreeStore()
    const [version, setVersion] = createSignal(0)
    const bump = () => setVersion((v) => v + 1)
    const [allRuns, setAllRuns] = createSignal(false)
    const [available, setAvailable] = createSignal(false)
    const [status, setStatus] = createSignal("")
    const [now, setNow] = createSignal(Date.now())
    const expanded: Expanded = new Map()
    const cleanups: (() => void)[] = []

    const defaultDirectory = () => String(ctx.data?.location?.default?.()?.directory ?? ctx.location?.directory ?? "")
    const getSession = (id: string) => ctx.data?.session?.get?.(id)
    const target = () => targetFor(ctx.ui.router.current(), getSession, defaultDirectory())
    const filter = (): Filter => {
      const t = target()
      return { directory: t.directory, sessionID: allRuns() ? null : t.sessionID }
    }
    const location = () => ({ location: { directory: target().directory } })

    // The resync driver (src/client/sync.ts): one `list` at a time, events replayed over it, gap and
    // epoch resyncs, and the finish notification once per run of the viewed session.
    const sync = new TreeSync({
      rpc,
      target: filter,
      tree,
      onChange: () => {
        setAvailable(sync.available)
        setStatus(sync.status)
        bump()
      },
      onFinished: (d) => void notifyFinished(d, { attention: ctx.attention, toast: ctx.ui.toast }),
    })
    const resync = () => sync.resync()
    sync.start()
    cleanups.push(() => sync.dispose())
    // A plugin was (re)loaded or changed: start over (X27; a cold start may have given up already).
    const offPlugins = ctx.data?.on?.("plugin.updated", () => void sync.refresh())
    if (typeof offPlugins === "function") cleanups.push(offPlugins)

    // Resync when the viewed session (and so the target) or the scope changes, and periodically
    // while a run is active (missed events, reconnects).
    const watchTarget = setInterval(() => sync.checkTarget(), 500)
    const periodic = setInterval(() => {
      if ([...tree.runs.values()].some(isActive)) void resync()
    }, RESYNC_MS)
    const ticker = setInterval(() => {
      if ([...tree.runs.values()].some(isActive)) setNow(Date.now())
    }, TICK_MS)
    for (const t of [watchTarget, periodic, ticker]) (t as any).unref?.()
    cleanups.push(() => {
      clearInterval(watchTarget)
      clearInterval(periodic)
      clearInterval(ticker)
    })

    const visibleRuns = createMemo(() => {
      version()
      return tree.visibleRuns({ directory: target().directory, sessionID: null })
    })
    const rows = createMemo(() => {
      version()
      return rowsFor(tree, expanded, filter())
    })

    // ---- actions ------------------------------------------------------------------------------

    const toast = (message: string, variant: "info" | "success" | "warning" | "error" = "info", title?: string) =>
      ctx.ui.toast.show({ ...(title ? { title } : {}), message: clip(message), variant })

    const control = async (req: ControlRequest) => {
      try {
        const res = await rpc.control(req, location())
        toast(String(res?.message ?? "done"), res?.ok ? "success" : "warning", "Workflows")
      } catch (e) {
        toast(errText(e), "error", "Workflows")
      }
      void resync()
    }

    const openSession = (sessionID: string) => {
      const focused = ctx.ui.tabs?.enabled?.() ? ctx.ui.tabs.focus(sessionID) : false
      if (!focused) ctx.ui.router.navigate({ type: "session", sessionID })
    }

    const runAction = async (a: Action) => {
      switch (a.type) {
        case "open":
          return openSession(a.sessionID)
        case "toast":
          return toast(a.message, a.variant)
        case "control":
          return control(a.control)
        case "confirm": {
          const ok = await ctx.ui.dialog.confirm({ title: a.title, message: a.message, label: { confirm: "Stop", cancel: "Cancel" } })
          if (ok) await control(a.control)
          return
        }
        case "prompt": {
          const text = await ctx.ui.dialog.prompt({ title: a.title, description: a.description, placeholder: "instruction for the agent" })
          if (typeof text === "string" && text.trim()) await control({ ...a.control, text: text.trim() })
          return
        }
        case "expand":
          expanded.set(a.key, a.open)
          return bump()
        case "toggle": {
          expanded.set(a.key, !isOpen(rows(), a.key))
          return bump()
        }
        case "filter":
          setAllRuns((v) => !v)
          toast(allRuns() ? "Showing every run of this project" : "Showing this session's runs")
          return
      }
    }

    const openPanel = () => {
      if (ctx.ui.panel.current()?.name === PANEL) return ctx.ui.panel.close()
      if (ctx.ui.panel.open(PANEL)) return void resync()
      // Home route: go to the session that owns the newest active run first.
      const run = visibleRuns().find(isActive) ?? visibleRuns()[0]
      if (!run?.parentSessionID) return toast("Open a session first: the workflows panel lives next to a session", "info")
      ctx.ui.router.navigate({ type: "session", sessionID: run.parentSessionID })
      setTimeout(() => {
        if (!ctx.ui.panel.open(PANEL)) toast("Could not open the workflows panel here", "warning")
      }, 50)
    }

    /** <leader>j: message the agent selected in the panel, or pick a running agent. */
    const messageAgent = async () => {
      const running: AgentView[] = []
      for (const r of tree.visibleRuns(filter())) {
        if (!isActive(r)) continue
        for (const a of tree.agentsOf(r.runId)) if (a.status === "running" || a.status === "queued") running.push(a)
      }
      if (!running.length) return toast("No running workflow agent to message", "info")
      const picked: AgentView | undefined =
        running.length === 1
          ? running[0]
          : await ctx.ui.dialog.select({
              title: "Message which agent?",
              options: running.map((a) => ({
                title: `#${a.index} ${a.label}`,
                value: a,
                description: `${a.status}${a.phase ? ` · ${a.phase}` : ""}`,
                category: tree.runs.get(a.runId)?.workflowName ?? a.runId,
              })),
            })
      if (!picked) return
      await runAction({
        type: "prompt",
        title: `Message #${picked.index} ${picked.label}`,
        description: "Read at the agent's next step boundary, without restarting it.",
        control: { runId: picked.runId, action: "message", agentIndex: picked.index, urgent: false },
      })
    }

    // ---- surfaces -----------------------------------------------------------------------------

    const muted = () => ctx.theme?.text?.muted

    cleanups.push(
      ctx.ui.slot({
        append: "prompt.footer.status",
        render: (input: { sessionID?: string }) => {
          const parts = () => {
            version()
            const sid = input.sessionID ? targetFor({ type: "session", sessionID: input.sessionID }, getSession, "").sessionID : null
            return available() ? footerParts(visibleRuns(), sid) : null
          }
          // Two texts so that, when the footer is narrow, only the name is shortened: the counts,
          // tokens and cost (flexShrink 0) always show whole. The separator is a no-break space: a
          // plain leading space (or a flex gap) was not drawn between the two texts (seen live).
          return (
            <Show when={parts()}>
              {(p) => (
                <box flexDirection="row" flexShrink={1} minWidth={0}>
                  <text fg={muted()} wrapMode="none" truncate flexShrink={1} minWidth={0}>
                    {p().name}
                  </text>
                  <text fg={muted()} wrapMode="none" flexShrink={0}>
                    {` ${p().stats.trimStart()}`}
                  </text>
                </box>
              )}
            </Show>
          )
        },
      }),
    )
    cleanups.push(
      ctx.ui.slot({
        append: "home.footer.status",
        render: () => {
          const text = () => (available() ? homeFooterText(visibleRuns()) : "")
          return (
            <Show when={text()}>
              <text fg={muted()} wrapMode="none" truncate>
                {text()}
              </text>
            </Show>
          )
        },
      }),
    )
    cleanups.push(
      ctx.ui.slot({
        append: "session.panel",
        render: (input: any) => (
          <Show when={input.name === PANEL}>
            <Panel
              ctx={ctx}
              input={input}
              rows={rows}
              now={now}
              status={status}
              scopeLabel={() => (allRuns() ? "all runs of this project (a: this session)" : "this session (a: all runs)")}
              run={(a) => void runAction(a)}
            />
          </Show>
        ),
      }),
    )
    cleanups.push(
      ctx.ui.slot({
        append: "app",
        render() {
          ctx.keymap.layer(() => ({
            mode: "global",
            commands: [
              {
                id: "workflows.panel",
                title: "Workflows: toggle the live progress tree",
                group: "Workflows",
                bind: "<leader>o",
                palette: true,
                slash: { name: "wf" },
                run: () => openPanel(),
              },
              {
                id: "workflows.message",
                title: "Workflows: message a running agent",
                group: "Workflows",
                bind: "<leader>j",
                palette: true,
                run: () => void messageAgent(),
              },
            ],
          }))
          return null
        },
      }),
    )

    return () => {
      for (const c of cleanups.splice(0).reverse()) {
        try {
          c()
        } catch {}
      }
    }
  },
}

export default plugin
