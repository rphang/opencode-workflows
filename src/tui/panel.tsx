// The live progress tree panel (X15): rows from src/tui/store.ts, a selection, and the panel-local
// keys (active only while the panel has focus). Every key goes through actionFor(), so the behavior is
// the one unit-tested in tests/parity/tui.test.ts; this file only renders and dispatches.

import { createMemo, createSignal, For, Show, type Accessor } from "solid-js"
import { actionFor, helpText, rowText, type Action, type Row } from "./store.ts"

export interface PanelProps {
  ctx: any
  input: { readonly focused: boolean; readonly width: number; readonly close: () => void }
  rows: Accessor<Row[]>
  now: Accessor<number>
  scopeLabel: Accessor<string>
  status: Accessor<string>
  run: (action: Action) => void
}

export function Panel(props: PanelProps) {
  const theme = () => props.ctx.theme ?? {}
  const [selected, setSelected] = createSignal<string | null>(null)
  const index = createMemo(() => {
    const rows = props.rows()
    const i = rows.findIndex((r) => r.key === selected())
    return i < 0 ? 0 : i
  })
  const current = () => props.rows()[index()]
  const move = (delta: number) => {
    const rows = props.rows()
    if (!rows.length) return
    const i = Math.min(rows.length - 1, Math.max(0, index() + delta))
    setSelected(rows[i]!.key)
  }
  const press = (key: string) => {
    const action = actionFor(current(), key)
    if (action) props.run(action)
  }

  // Panel-local keys: only while the panel has focus, so the prompt keeps its own keys.
  props.ctx.keymap.layer(() => ({
    enabled: () => props.input.focused,
    priority: 10,
    commands: [
      { bind: "up,k", title: "Previous row", group: "Workflows", run: () => move(-1) },
      { bind: "down,j", title: "Next row", group: "Workflows", run: () => move(1) },
      { bind: "pageup", title: "Page up", group: "Workflows", run: () => move(-visible()) },
      { bind: "pagedown", title: "Page down", group: "Workflows", run: () => move(visible()) },
      { bind: "left,h", title: "Collapse", group: "Workflows", run: () => press("left") },
      { bind: "right,l", title: "Expand", group: "Workflows", run: () => press("right") },
      { bind: "return", title: "Open session", group: "Workflows", run: () => press("return") },
      { bind: "x", title: "Stop run / agent", group: "Workflows", run: () => press("x") },
      { bind: "p", title: "Pause / resume run", group: "Workflows", run: () => press("p") },
      { bind: "m", title: "Message agent(s)", group: "Workflows", run: () => press("m") },
      { bind: "shift+m", title: "Urgent message", group: "Workflows", run: () => press("M") },
      { bind: "a", title: "This session / whole project", group: "Workflows", run: () => press("a") },
      { bind: "escape", title: "Close workflows panel", group: "Workflows", run: () => props.input.close() },
    ],
  }))

  /** Text width inside the panel (its padding is 1 cell on each side). */
  const width = () => Math.max(10, Number(props.input.width ?? 80) - 2)

  /** Rows that fit: the terminal height minus the header, help line and host chrome. */
  const visible = () => Math.max(3, Number(props.ctx.renderer?.height ?? 30) - 8)
  const windowed = createMemo(() => {
    const rows = props.rows()
    const n = visible()
    const start = Math.max(0, Math.min(index() - Math.floor(n / 2), rows.length - n))
    return rows.slice(start, start + n)
  })

  const color = (row: Row) => {
    const t = theme()
    const status = row.kind === "agent" ? row.agent.status : row.kind === "run" ? row.run.status : "phase"
    if (status === "failed") return t.text?.feedback?.error?.base
    if (status === "completed" && row.kind === "run") return t.text?.feedback?.success?.base
    if (status === "queued" || status === "cached" || status === "stopped" || row.kind === "phase") return t.text?.muted
    return t.text?.base
  }

  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1} flexGrow={1}>
      <text fg={theme().text?.base} wrapMode="none" truncate>
        <b>Workflows</b> · {props.scopeLabel()}
      </text>
      <Show when={props.status()}>
        <text fg={theme().text?.muted} wrapMode="none" truncate>
          {props.status()}
        </text>
      </Show>
      <Show
        when={props.rows().length > 0}
        fallback={
          <text fg={theme().text?.muted} wrapMode="word">
            No workflow runs here yet. Runs started with the workflow tool appear live.
          </text>
        }
      >
        <For each={windowed()}>
          {(row) => {
            const isSel = () => row.key === current()?.key
            return (
              <text
                fg={isSel() && props.input.focused ? theme().text?.action?.primary?.selected ?? color(row) : color(row)}
                bg={isSel() ? theme().background?.action?.primary?.selected ?? theme().background?.raised?.high : undefined}
                wrapMode="none"
                truncate
              >
                {rowText(row, props.now(), width())}
              </text>
            )
          }}
        </For>
      </Show>
      <box flexGrow={1} />
      <text fg={theme().text?.muted} wrapMode="none" truncate>
        {helpText(width())}
      </text>
    </box>
  )
}
