// The `sidebar.content` summary of the viewed session's workflow runs (X26), after opencode's own
// sidebar sections (todo, MCP): a `Workflows` header, a collapse toggle when there are more than two
// runs (its state persisted in the plugin's storage), and one row per run with a colored dot, the
// name, `<done>/<total>` and a muted sub-line. Clicking a run opens the panel on it. The content comes
// from sidebarSummary() (src/client/tree.ts); this file only renders.

import { createMemo, createSignal, For, Show, type Accessor } from "solid-js"
import { sidebarSummary, type SidebarItem, type SidebarTone } from "./store.ts"
import type { RunView } from "../plugin/live.ts"

export interface SidebarProps {
  ctx: any
  /** The session whose runs are shown (already mapped from a workflow child to its parent). */
  sessionID: Accessor<string | null>
  runs: Accessor<RunView[]>
  /** Opens the panel, with this run selected (null: as it is). */
  openRun: (runId: string | null) => void
}

/** The collapse state: in the plugin's durable storage when the host has it, else in memory. */
function viewState(ctx: any): readonly [{ readonly open: boolean }, (open: boolean) => void] {
  const store = ctx.storage?.store
  if (typeof store === "function") {
    try {
      const [view, update] = store.call(ctx.storage, "sidebar", { initial: { open: true } })
      return [
        view,
        (open: boolean) =>
          void Promise.resolve(
            update((draft: { open: boolean }) => {
              draft.open = open
            }),
          ).catch(() => {}),
      ]
    } catch {}
  }
  const [open, setOpen] = createSignal(true)
  return [
    {
      get open() {
        return open()
      },
    },
    setOpen,
  ]
}

export function Sidebar(props: SidebarProps) {
  const theme = () => props.ctx.theme ?? {}
  const [view, setOpen] = viewState(props.ctx)
  const summary = createMemo(() => sidebarSummary(props.runs(), props.sessionID()))
  const open = () => !summary()?.collapsible || view.open

  const tone = (t: SidebarTone) => {
    const c = theme().text
    if (t === "running") return c?.feedback?.info?.base ?? c?.base
    if (t === "paused") return c?.feedback?.warning?.base ?? c?.muted
    if (t === "success") return c?.feedback?.success?.base ?? c?.base
    if (t === "error") return c?.feedback?.error?.base ?? c?.base
    return c?.muted
  }

  return (
    <Show when={summary()}>
      {(s) => (
        <box>
          <box
            flexDirection="row"
            gap={1}
            onMouseDown={() => {
              if (s().collapsible) setOpen(!view.open)
            }}
          >
            <Show when={s().collapsible}>
              <text fg={theme().text?.base}>{view.open ? "▼" : "▶"}</text>
            </Show>
            <text fg={theme().text?.base}>
              <b>Workflows</b>
              <Show when={!open()}>
                <span style={{ fg: theme().text?.muted }}> ({s().hint})</span>
              </Show>
            </text>
          </box>
          <Show when={open()}>
            <For each={s().items}>
              {(item: SidebarItem) => (
                <box onMouseUp={() => props.openRun(item.runId)}>
                  <box flexDirection="row" gap={1} minWidth={0}>
                    <text flexShrink={0} style={{ fg: tone(item.tone) }}>
                      •
                    </text>
                    <text fg={theme().text?.base} wrapMode="none" truncate flexGrow={1} flexShrink={1} minWidth={0}>
                      {item.name}
                    </text>
                    <text fg={theme().text?.muted} wrapMode="none" flexShrink={0}>
                      {item.progress}
                    </text>
                  </box>
                  <text fg={theme().text?.muted} wrapMode="none" truncate paddingLeft={2}>
                    {item.detail}
                  </text>
                </box>
              )}
            </For>
            <Show when={s().more > 0}>
              <text fg={theme().text?.muted} wrapMode="none" paddingLeft={2} onMouseUp={() => props.openRun(null)}>
                +{s().more} more
              </text>
            </Show>
          </Show>
        </box>
      )}
    </Show>
  )
}
