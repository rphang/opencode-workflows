// TUI companion of @rphang/opencode-workflows: the live progress tree (X14–X16).
//
// opencode loads it for every active server plugin whose package has a `./tui` entry (Host.resolve →
// features.tui): `exports["./tui"]` → dist/tui.js for package installs, and the repo-root tui.tsx for
// directory installs. It talks to the server plugin only through the `dynamic-workflows` RPC:
//   calls  list / status / control   → sent to the viewed session's Location (the run's parent)
//   events delta / finished          → one global stream, filtered here by Location and session
//
// Surfaces: the prompt footer (`wf <name> 7/12 · 81.2k · $0.42`), the home footer (`wf 2 running`), a
// session panel "workflows" with the tree (<leader>o, /wf), the agent dialog (<leader>j, X25), a
// sidebar summary (X26), and a desktop notification (or a toast) when a run finishes. If the RPC is
// unavailable (plugin disabled) it retries a few times (X27), then stays quiet; /workflows keeps working.
//
// The host-agnostic state and sync live in src/client/ (shared with a GUI companion); this file only
// wires them to the opencode 2.3 TUI plugin API (@opencode/plugin/tui, types only: the host provides it).

import type { Plugin } from "@opencode/plugin/tui"
import { createEffect, createMemo, createRoot, createSignal, Show, untrack } from "solid-js"
import { TreeSync } from "../client/sync.ts"
import { definition } from "../plugin/rpc-def.ts"
import { Panel } from "./panel.tsx"
import { Sidebar } from "./sidebar.tsx"
import {
  footerParts,
  homeFooterText,
  isActive,
  isOpen,
  notifyFinished,
  PICKER_ACTIONS,
  pickerAction,
  pickerCurrent,
  pickerOptions,
  pickerSearch,
  rowsFor,
  runKey,
  targetFor,
  TreeStore,
  viewedSession,
  type Action,
  type ControlRequest,
  type Expanded,
  type Filter,
  type PickerKey,
  type PickerValue,
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
  setup(ctx: Plugin.Context) {
    const rpc = ctx.client.rpc(definition)
    const tree = new TreeStore()
    const [version, setVersion] = createSignal(0)
    const bump = () => setVersion((v) => v + 1)
    const [allRuns, setAllRuns] = createSignal(false)
    const [available, setAvailable] = createSignal(false)
    const [status, setStatus] = createSignal("")
    const [now, setNow] = createSignal(Date.now())
    /** Key of the row selected in the panel (kept here so the agent dialog can start on it). */
    const [selected, setSelected] = createSignal<string | null>(null)
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

    // Resync when the viewed session (and so the target) or the scope changes: the router's route and
    // the session data are Solid stores in opencode 2.3 (route.tsx createStore/reconcile, the client's
    // data store), so an effect over filter() sees every change. Its own root: setup has no owner.
    createRoot((dispose) => {
      cleanups.push(dispose)
      createEffect(() => {
        filter()
        untrack(() => sync.checkTarget())
      })
    })
    // Periodically while a run is active (missed events, reconnects).
    const periodic = setInterval(() => {
      if ([...tree.runs.values()].some(isActive)) void resync()
    }, RESYNC_MS)
    const ticker = setInterval(() => {
      if ([...tree.runs.values()].some(isActive)) setNow(Date.now())
    }, TICK_MS)
    for (const t of [periodic, ticker]) (t as { unref?: () => void }).unref?.()
    cleanups.push(() => {
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
        // The output schema is a plain object; the handler answers {ok, message} (src/plugin/rpc-def.ts).
        const res = (await rpc.control(req, location())) as { ok?: boolean; message?: string } | undefined
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

    /** Sidebar click (X26): opens the panel (if needed) with the run selected and unfolded. */
    const showRun = (runId: string | null) => {
      if (runId) {
        setSelected(runKey(runId))
        expanded.set(runKey(runId), true)
        bump()
      }
      if (ctx.ui.panel.current()?.name !== PANEL && !ctx.ui.panel.open(PANEL)) return toast("Could not open the workflows panel here", "warning")
      void resync()
    }

    /**
     * <leader>j (X25): one searchable dialog of the running and queued agents. Enter steers the
     * highlighted agent; ctrl+u (urgent steer), ctrl+d (stop) and ctrl+o (open) are footer actions.
     * An action does not close the dialog, but the prompt or confirm it shows replaces it.
     */
    const agentDialog = async () => {
      const options = pickerOptions(tree, filter())
      if (!options.length) return toast("No running workflow agent", "info")
      const act = (value: PickerValue, key: PickerKey) => {
        const a = pickerAction(tree, value, key)
        if (a.type === "open") ctx.ui.dialog.clear()
        void runAction(a)
      }
      const picked = await ctx.ui.dialog.select({
        title: "Workflow agents",
        placeholder: "#index, label, phase, workflow or run id",
        options,
        current: pickerCurrent(options, selected()),
        search: pickerSearch,
        actions: PICKER_ACTIONS.map((a) => ({ bind: a.bind, title: a.title, onTrigger: (v: PickerValue) => act(v, a.key) })),
      })
      if (picked) await runAction(pickerAction(tree, picked, "steer"))
    }

    // ---- global commands ----------------------------------------------------------------------

    // A setup-time layer (opencode 2.3 registers it for the plugin's lifetime; it used to need an
    // `app` slot render that returned null).
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
          title: "Workflows: agents (steer, stop, open)",
          group: "Workflows",
          bind: "<leader>j",
          palette: true,
          run: () => void agentDialog(),
        },
      ],
    }))

    // ---- surfaces -----------------------------------------------------------------------------

    const muted = () => ctx.theme?.text?.muted

    cleanups.push(
      ctx.ui.slot({
        append: "prompt.footer.status",
        render: (input: { sessionID?: string }) => {
          const parts = () => {
            version()
            return available() ? footerParts(visibleRuns(), viewedSession(input.sessionID, getSession)) : null
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
        render: (input) => (
          <Show when={input.name === PANEL}>
            <Panel
              ctx={ctx}
              input={input}
              rows={rows}
              now={now}
              status={status}
              selected={selected}
              select={setSelected}
              scopeLabel={() => (allRuns() ? "all runs of this project (a: this session)" : "this session (a: all runs)")}
              run={(a) => void runAction(a)}
            />
          </Show>
        ),
      }),
    )
    cleanups.push(
      ctx.ui.slot({
        append: "sidebar.content",
        render: (input: { sessionID?: string }) => (
          <Sidebar
            ctx={ctx}
            sessionID={() => (available() ? viewedSession(input.sessionID, getSession) : null)}
            runs={visibleRuns}
            openRun={showRun}
          />
        ),
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
} satisfies Plugin.Definition

export default plugin
