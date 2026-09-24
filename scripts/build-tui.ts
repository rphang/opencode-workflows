// Builds the TUI entry (src/tui/index.tsx) into one precompiled ESM file, dist/tui.js (X14).
//
// opencode's TUI swaps in its own copies of solid-js, @opentui/* and @opencode/plugin/tui for
// plugins, including those under node_modules, but it does NOT JSX-transform files under
// node_modules. So the JSX is compiled here with @opentui/solid's Babel transform (Solid "universal"
// mode, module @opentui/solid), and every host-provided module stays external: the bundle ships no
// copy of solid-js or opentui, only our own code.

import path from "node:path"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

/** Modules the TUI host provides at runtime; never bundled. */
export const TUI_EXTERNALS = [
  "solid-js",
  "solid-js/store",
  "@opentui/core",
  "@opentui/solid",
  "@opentui/keymap",
  "@opencode/plugin",
  "@opencode/plugin/tui",
]

export async function buildTui(outdir: string): Promise<string> {
  const root = path.resolve(import.meta.dir, "..")
  const result = await Bun.build({
    entrypoints: [path.join(root, "src", "tui", "index.tsx")],
    outdir,
    naming: "tui.js",
    target: "bun",
    format: "esm",
    external: TUI_EXTERNALS,
    plugins: [createSolidTransformPlugin()],
    sourcemap: "none",
    minify: false,
  })
  if (!result.success) {
    throw new Error(`TUI build failed:\n${result.logs.map((l) => String(l)).join("\n")}`)
  }
  return path.join(outdir, "tui.js")
}
