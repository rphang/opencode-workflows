/** @jsxImportSource solid-js */
// The window setup of the desktop app companion (X28–X30). It talks to the server plugin only through
// the `dynamic-workflows` RPC of each SESSION's server (`ctx.servers.get(id).client`, not `ctx.client`,
// which is the app's own sidecar):
//   calls  list / control  → the target Location (the run's parent session's directory)
//   events delta / finished → one subscription per server, fanned out to its Locations' syncs
//
// State, all created here (no module state): one TreeSync (src/client/sync.ts) per server and Location
// that an open session needs, pruned as tabs close; one event link per server, subscribed again when
// the server reconnects or gets a new client (rpc events never reconnect by themselves); and per-tab
// view state (folds, scope, selection) keyed by session key. Surfaces: a composer pill (X28), the side
// panel `tree` with a command, a + menu entry and a mobile view (X29), and the finish notice (X30).

import { createMemo, createSignal, onCleanup, untrack } from "solid-js"
import {
  Command,
  ComposerPill,
  createKeyed,
  MenuItem,
  Panel,
  type Context,
  type MountedSession,
  type PanelTab,
  type SessionPanelMenuItem,
  type SessionRef,
} from "@opencode/plugin/gui"
import { TreeSync, type RpcEvent, type SyncRpc } from "../client/sync.ts"
import { actionFor, isActive, isOpen, rowsFor, runKey, type Action, type ControlRequest, type Expanded, type Row, type SessionLike } from "../client/tree.ts"
import type { FinishedEvent } from "../plugin/live.ts"
import { definition } from "../plugin/rpc-def.ts"
import {
  actionToast,
  controlToast,
  entryKey,
  notifyPlan,
  PANEL_ID,
  panelKey,
  panelLine,
  pillView,
  reconcilePlan,
  sessionTarget,
  shouldToast,
  wantedEntries,
  type SessionTarget,
  type Translate,
} from "./model.ts"
import { TreePanel } from "./panel.tsx"

const RESYNC_MS = 15_000
const TICK_MS = 1_000
const EVENTS = ["delta", "finished"] as const

type EventName = (typeof EVENTS)[number]

interface Link {
  /** The client the events are subscribed with (undefined while not subscribed). */
  client: unknown
  hub: Map<EventName, Set<(e: RpcEvent) => void>>
  offs: (() => void)[]
}

interface Entry {
  serverID: string
  directory: string
  sync: TreeSync
}

interface View {
  expanded: Expanded
  all: boolean
  selected: string | null
}

function errText(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message)
  return String(e)
}

function quietly(f: () => void): void {
  try {
    f()
  } catch {}
}

export function setup(ctx: Context): void {
  const t: Translate = (key, params) => ctx.t(key, params)
  const key = panelKey(ctx.id)
  const [version, setVersion] = createSignal(0)
  const bump = () => setVersion((v) => v + 1)
  const [now, setNow] = createSignal(Date.now())
  const links = new Map<string, Link>()
  const entries = new Map<string, Entry>()
  const views = new Map<string, View>()

  const rpcOf = (serverID: string) => {
    const client = ctx.servers.get(serverID)?.client
    if (!client) throw new Error("server unavailable")
    return client.rpc(definition)
  }

  // ---- targets ------------------------------------------------------------------------------

  const targetOf = (s: SessionRef | MountedSession): SessionTarget | undefined => {
    const directory = ("directory" in s && s.directory) || s.location?.directory
    if (!directory) return undefined
    const server = s.server
    const get = (id: string) => server.data?.session?.get?.(id) as SessionLike | undefined
    return sessionTarget({ serverID: server.id, sessionID: s.id, directory }, get)
  }
  const entryOf = (target: SessionTarget | undefined) => (target ? entries.get(entryKey(target.serverID, target.directory)) : undefined)
  const openSessions = (): (SessionRef | MountedSession)[] => {
    const cur = ctx.sessions.current()
    return cur ? [...ctx.sessions.list(), cur] : [...ctx.sessions.list()]
  }

  // ---- event links (one subscription per server) --------------------------------------------

  const linkFor = (serverID: string): Link => {
    let l = links.get(serverID)
    if (!l) links.set(serverID, (l = { client: undefined, hub: new Map(), offs: [] }))
    return l
  }
  const detach = (l: Link) => {
    for (const off of l.offs.splice(0)) quietly(off)
    l.client = undefined
  }
  /** Subscribes the server's events again when its client changed; true if it did (the syncs missed events). */
  const attach = (serverID: string): boolean => {
    const l = linkFor(serverID)
    const server = ctx.servers.get(serverID)
    const client = server?.connected ? server.client : undefined
    if (client === l.client) return false
    detach(l)
    if (!server || !client) return true
    l.client = client
    try {
      const rpc = client.rpc(definition)
      for (const name of EVENTS) {
        l.offs.push(
          rpc.events.on(name, (e) => {
            for (const h of [...(l.hub.get(name) ?? [])]) h(e as RpcEvent)
          }),
        )
      }
    } catch (e) {
      console.error(e)
    }
    // A plugin was (re)loaded or changed on that server: start over (it may have been missing).
    const off = server.data?.on?.("plugin.updated", () => refreshServer(serverID))
    if (typeof off === "function") l.offs.push(off)
    return true
  }
  const refreshServer = (serverID: string) => {
    for (const e of entries.values()) if (e.serverID === serverID) void e.sync.refresh()
  }

  // ---- syncs (one per server and Location) --------------------------------------------------

  const createEntry = (k: string, serverID: string, directory: string) => {
    const l = linkFor(serverID)
    const rpc: SyncRpc = {
      list: (input, options) => rpcOf(serverID).list(input, { ...options, signal: ctx.signal }),
      events: {
        on: (name, handler) => {
          let set = l.hub.get(name)
          if (!set) l.hub.set(name, (set = new Set()))
          set.add(handler)
          return () => void set.delete(handler)
        },
      },
    }
    const sync = new TreeSync({
      rpc,
      // Every run of the Location: the pill, the panel and the notice filter by session.
      target: () => ({ directory, sessionID: null }),
      onChange: bump,
      onFinished: (e) => finished(serverID, e),
    })
    entries.set(k, { serverID, directory, sync })
    sync.start()
  }

  const reconcile = (wanted: ReturnType<typeof wantedEntries>) => {
    const plan = reconcilePlan(entries.keys(), wanted)
    for (const k of plan.dispose) {
      entries.get(k)?.sync.dispose()
      entries.delete(k)
    }
    const servers = new Set([...wanted.values()].map((w) => w.serverID))
    for (const id of servers) if (attach(id)) refreshServer(id)
    for (const k of plan.create) {
      const w = wanted.get(k)!
      createEntry(k, w.serverID, w.directory)
    }
    for (const [id, l] of links) {
      if (servers.has(id)) continue
      detach(l)
      links.delete(id)
    }
    bump()
  }

  // The server/Location pairs the open tabs need (connected servers only). Runs again when a tab opens
  // or closes, a session moves, a child's metadata arrives, or a server (re)connects.
  const wanted = () =>
    wantedEntries(openSessions().flatMap((s) => (s.server.connected ? [targetOf(s)].filter((x): x is SessionTarget => !!x) : [])))
  createKeyed(
    () => [...wanted().keys()].join("\u0000"),
    () => reconcile(untrack(wanted)),
    { otherwise: () => reconcile(new Map()) },
  )

  // Another session was routed: a sync that gave up (plugin missing there) tries again.
  createKeyed(
    () => ctx.sessions.current()?.key,
    () => {
      const e = entryOf(untrack(() => {
        const cur = ctx.sessions.current()
        return cur ? targetOf(cur) : undefined
      }))
      if (e && (e.sync.state === "unavailable" || e.sync.state === "error")) void e.sync.refresh()
    },
  )

  // Forgets the view state of tabs that closed.
  createKeyed(
    () => openSessions().map((s) => s.key).join("\u0000"),
    () => {
      const keep = new Set(untrack(openSessions).map((s) => s.key))
      for (const k of views.keys()) if (!keep.has(k)) views.delete(k)
    },
  )

  const anyActive = () => [...entries.values()].some((e) => [...e.sync.tree.runs.values()].some(isActive))
  // Resync while a run is active (missed events), and catch a new client under the same server id.
  const periodic = setInterval(() => {
    for (const id of [...links.keys()]) if (attach(id)) refreshServer(id)
    for (const e of entries.values()) if ([...e.sync.tree.runs.values()].some(isActive)) void e.sync.resync()
  }, RESYNC_MS)
  const ticker = setInterval(() => {
    if (anyActive()) setNow(Date.now())
  }, TICK_MS)
  onCleanup(() => {
    clearInterval(periodic)
    clearInterval(ticker)
    for (const e of entries.values()) e.sync.dispose()
    entries.clear()
    for (const l of links.values()) detach(l)
    links.clear()
    views.clear()
  })

  // ---- finish notice (X30) ------------------------------------------------------------------

  const finished = (serverID: string, e: FinishedEvent) => {
    // A tab counts for its target session: a workflow child's tab stands for its parent.
    const open = untrack(openSessions).flatMap((s) => {
      const target = targetOf(s)
      return target?.sessionID ? [{ serverID: target.serverID, sessionID: target.sessionID }] : []
    })
    const plan = notifyPlan(e, serverID, open)
    if (!plan) return
    void ctx.attention.notify(plan.notify).then((r) => {
      if (ctx.signal.aborted) return
      const cur = ctx.sessions.current()
      const target = cur ? targetOf(cur) : undefined
      const showsSession = !!target && target.serverID === serverID && target.sessionID === e.parentSessionID
      const focused = typeof document !== "undefined" && document.hasFocus()
      if (shouldToast(r, { showsSession, focused })) ctx.toast.show(plan.toast)
    })
  }

  // ---- actions ------------------------------------------------------------------------------

  const viewOf = (sessionKey: string): View => {
    let v = views.get(sessionKey)
    if (!v) views.set(sessionKey, (v = { expanded: new Map(), all: false, selected: null }))
    return v
  }

  const control = async (target: SessionTarget, req: ControlRequest) => {
    try {
      const res = await rpcOf(target.serverID).control(req, { location: { directory: target.directory }, signal: ctx.signal })
      if (ctx.signal.aborted) return
      ctx.toast.show(controlToast(res, t))
    } catch (e) {
      if (ctx.signal.aborted) return
      ctx.toast.show({ title: t("control.title"), description: errText(e), variant: "error" })
    }
    void entryOf(target)?.sync.resync()
  }

  const runAction = async (a: Action, target: SessionTarget, view: View, rows: () => Row[]) => {
    switch (a.type) {
      case "open":
        return ctx.tabs.open({ server: target.serverID, id: a.sessionID }, { focus: true })
      case "toast":
        return void ctx.toast.show(actionToast(a))
      case "control":
        return control(target, a.control)
      case "confirm": {
        const ok = await ctx.dialogs.confirm({ title: a.title, description: a.message, confirm: t("confirm.stop"), danger: true })
        if (ok && !ctx.signal.aborted) await control(target, a.control)
        return
      }
      case "prompt": {
        const text = await ctx.dialogs.prompt({ title: a.title, description: a.description, placeholder: t("prompt.placeholder"), submit: t("prompt.submit") })
        if (!ctx.signal.aborted && typeof text === "string" && text.trim()) await control(target, { ...a.control, text: text.trim() })
        return
      }
      case "expand":
        view.expanded.set(a.key, a.open)
        return bump()
      case "toggle":
        view.expanded.set(a.key, !isOpen(rows(), a.key))
        return bump()
      case "filter":
        view.all = !view.all
        return bump()
    }
  }

  // ---- side panel (X29) ---------------------------------------------------------------------

  const togglePanel = () => {
    const session = ctx.sessions.current()
    if (!session) return void ctx.toast.show({ title: t("command.noSession") })
    ctx.layout.toggle(key, session)
  }
  /** Opens the panel next to a session with one run selected and unfolded (from the pill). */
  const showRun = (session: SessionRef, runId: string) => {
    const v = viewOf(session.key)
    v.expanded.set(runKey(runId), true)
    v.selected = runKey(runId)
    bump()
    ctx.layout.open(key, session)
  }

  const tab: PanelTab = {
    id: PANEL_ID,
    get title() {
      return ctx.t("panel.title")
    },
  }

  ctx.add(Panel, {
    id: PANEL_ID,
    region: "side",
    width: "narrow",
    mobile: {
      get title() {
        return ctx.t("panel.mobile")
      },
      order: 60,
      kind: "menu",
      icon: "branch-out",
    },
    list: (input) => (input.open.includes(PANEL_ID) ? [tab] : []),
    render: (props) => {
      const target = () => targetOf(props.session)
      const entry = () => {
        version()
        return entryOf(target())
      }
      const view = () => {
        version()
        return viewOf(props.session.key)
      }
      const rows = createMemo((): Row[] => {
        const e = entry()
        const tg = target()
        if (!e?.sync.available || !tg) return []
        const v = view()
        return rowsFor(e.sync.tree, v.expanded, { directory: e.directory, sessionID: v.all ? null : tg.sessionID })
      })
      return (
        <TreePanel
          ctx={ctx}
          t={t}
          rows={rows}
          now={now}
          line={() => panelLine(entry()?.sync, t)}
          empty={() => t(view().all ? "panel.empty.all" : "panel.empty.session")}
          all={() => view().all}
          setAll={(all) => {
            view().all = all
            bump()
          }}
          selected={() => view().selected}
          select={(k) => {
            view().selected = k
            bump()
          }}
          viewedSessionID={() => target()?.sessionID ?? null}
          isOpen={(k) => isOpen(rows(), k)}
          run={(row, k) => {
            const tg = target()
            const a = actionFor(row, k)
            if (tg && a) void runAction(a, tg, view(), rows)
          }}
        />
      )
    },
  })

  ctx.add(
    Command,
    (): Command => ({
      id: PANEL_ID,
      title: ctx.t("command.tree"),
      group: ctx.t("command.group"),
      section: "session",
      slash: { name: "wf" },
      run: togglePanel,
    }),
  )

  ctx.add(MenuItem, (): SessionPanelMenuItem => {
    const session = ctx.sessions.current()
    return {
      id: PANEL_ID,
      menu: "session.panel",
      title: ctx.t("panel.title"),
      icon: "branch-out",
      opened: !!session && ctx.layout.state(key, session) !== "closed",
      run: togglePanel,
    }
  })

  // ---- composer pill (X28) ------------------------------------------------------------------

  ctx.add(ComposerPill, {
    id: "workflows",
    show: (input) => {
      version()
      const target = targetOf(input.session)
      const e = entryOf(target)
      if (!target || !e?.sync.available) return undefined
      const v = pillView(e.sync.tree, target.sessionID, t)
      if (!v) return undefined
      const session = input.session
      return {
        label: v.label,
        icon: v.icon,
        title: v.title,
        ...(v.tone ? { tone: v.tone } : {}),
        rows: v.rows.map((r) => ({ ...r, run: () => showRun(session, r.id) })),
      }
    },
  })
}
