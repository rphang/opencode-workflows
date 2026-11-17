/** @jsxImportSource solid-js */
// The side panel tree (X29): run → phases → agents, each row with its status glyph, title, a muted
// detail line and icon buttons. It only renders: rows, buttons and texts come from src/gui/model.ts,
// and every button goes back through `run(row, key)` (actionFor, as the TUI keys do).

import { Index, Show, type Accessor, type JSX } from "solid-js"
import type { Context } from "@opencode/plugin/gui"
import type { Row } from "../client/tree.ts"
import { rowButtons, rowText, type RowTone, type Translate } from "./model.ts"

export interface TreePanelProps {
  ctx: Context
  t: Translate
  rows: Accessor<Row[]>
  now: Accessor<number>
  /** Why the tree is not there (one line), or "". */
  line: Accessor<string>
  /** What an empty tree says. */
  empty: Accessor<string>
  all: Accessor<boolean>
  setAll: (all: boolean) => void
  selected: Accessor<string | null>
  select: (key: string) => void
  viewedSessionID: Accessor<string | null>
  isOpen: (key: string) => boolean
  run: (row: Row, key: string) => void
}

// Fixed tones that read on light and dark themes alike (no undocumented host CSS variables).
const TONE_COLOR: Record<RowTone, string | undefined> = {
  danger: "#e5534b",
  warning: "#c69026",
  success: "#3fb950",
  muted: undefined,
}

const muted: JSX.CSSProperties = { opacity: 0.65 }

export function TreePanel(props: TreePanelProps): JSX.Element {
  const ui = props.ctx.ui
  return (
    <div
      style={{
        display: "flex",
        "flex-direction": "column",
        height: "100%",
        "min-height": "0",
        overflow: "auto",
        padding: "8px",
        gap: "2px",
        "font-size": "13px",
        "font-variant-numeric": "tabular-nums",
      }}
    >
      <div style={{ padding: "2px 4px 8px" }}>
        <ui.Switch label={props.t("panel.scope")} description={props.t("panel.scope.description")} checked={props.all()} onChange={props.setAll} />
      </div>
      <Show when={props.line()}>
        <div style={{ ...muted, padding: "4px" }}>{props.line()}</div>
      </Show>
      <Show when={!props.line() && props.rows().length === 0}>
        <div style={{ ...muted, padding: "4px" }}>{props.empty()}</div>
      </Show>
      <div role="tree" aria-label={props.t("panel.title")} style={{ display: "flex", "flex-direction": "column", gap: "2px" }}>
      <Index each={props.rows()}>
        {(row) => {
          const text = () => rowText(row(), props.now())
          const buttons = () => rowButtons(row(), { open: props.isOpen(row().key), viewedSessionID: props.viewedSessionID() }, props.t)
          const tone = () => {
            const t = text().tone
            return t ? TONE_COLOR[t] : undefined
          }
          return (
            <div
              role="treeitem"
              aria-level={text().depth + 1}
              aria-selected={props.selected() === row().key}
              onClick={() => props.select(row().key)}
              style={{
                display: "flex",
                "align-items": "center",
                gap: "6px",
                padding: "3px 4px",
                "padding-left": `${4 + text().depth * 14}px`,
                "border-radius": "4px",
                background: props.selected() === row().key ? "rgba(127, 127, 127, 0.14)" : "transparent",
                opacity: text().tone === "muted" ? 0.7 : 1,
              }}
            >
              <span aria-hidden="true" style={{ width: "1em", "text-align": "center", "flex-shrink": "0", color: tone() }}>
                {text().glyph}
              </span>
              <div style={{ display: "flex", "flex-direction": "column", "min-width": "0", flex: "1 1 auto" }}>
                <span style={{ "white-space": "nowrap", overflow: "hidden", "text-overflow": "ellipsis", "font-weight": row().kind === "run" ? 600 : 400 }}>
                  {text().title}
                </span>
                <span style={{ ...muted, "font-size": "12px", "white-space": "nowrap", overflow: "hidden", "text-overflow": "ellipsis" }} title={text().detail}>
                  {text().detail}
                </span>
              </div>
              <div style={{ display: "flex", "flex-shrink": "0", gap: "1px" }} onClick={(e) => e.stopPropagation()}>
                <Index each={buttons()}>
                  {(b) => (
                    <ui.Tooltip value={b().label}>
                      <ui.IconButton icon={b().icon} label={b().label} size="small" onClick={() => props.run(row(), b().key)} />
                    </ui.Tooltip>
                  )}
                </Index>
              </div>
            </div>
          )
        }}
      </Index>
      </div>
    </div>
  )
}
