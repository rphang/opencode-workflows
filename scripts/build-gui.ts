// Builds the desktop app companion (src/gui/index.tsx) into one CommonJS file,
// dist/gui-experimental.cjs (X28–X30), the package's `./gui-experimental` export.
//
// It uses opencode's own preset, `gui()` from @opencode/plugin/gui/vite (Vite + vite-plugin-solid): Solid
// JSX compiled for the DOM, every dynamic import inlined (the app loads no second chunk), and the modules
// the app provides (GUI_PROVIDED: solid-js, @opencode/plugin/gui, …) kept external, so the bundle shares
// the app's instances. The shared client logic (src/client) is bundled in. The preset fails the build on
// an Effect, Solid or OpenCode module the app does not provide, but not on others (e.g. @opentui/*):
// tests/unit/install-docs.test.ts checks the output.

import path from "node:path"
import { gui } from "@opencode/plugin/gui/vite"
import { build } from "vite"

/** The GUI entry, relative to the repo root. */
export const GUI_ENTRY = "src/gui/index.tsx"

/**
 * The modules the app provides to a `./gui-experimental` bundle (a copy of the preset's
 * pluginSharedModules + pluginWindowModules, which @opencode/plugin does not export; a test keeps them
 * equal). Nothing else may be required at runtime.
 */
export const GUI_PROVIDED: readonly string[] = [
  "effect",
  "@opencode/plugin/gui",
  "@opencode/plugin/gui/main",
  "@opencode/plugin/rpc",
  "@opencode/schema/rpc",
  "@opencode/client",
  "@opencode/client/effect",
  "solid-js",
  "solid-js/web",
  "solid-js/store",
  "@opencode/plugin/gui/file",
  "@opencode/plugin/gui/review",
  "@opencode/plugin/gui/browser",
  "@opencode/client/solid",
]

/** Writes the bundle to `outFile` (an absolute path) and returns it. */
export async function buildGui(outFile: string): Promise<string> {
  const root = path.resolve(import.meta.dir, "..")
  await build({
    root,
    configFile: false,
    envFile: false,
    publicDir: false,
    logLevel: "warn",
    plugins: gui({ entry: path.join(root, GUI_ENTRY), outFile }),
    // The `@jsxImportSource solid-js` pragma is for tsc (the root tsconfig defaults to opentui's JSX);
    // vite-plugin-solid compiles the JSX, so esbuild's note about the pragma is noise.
    esbuild: { logOverride: { "unsupported-jsx-comment": "silent" } },
    // Readable output: the bundle is small, and a stack trace from the app should point somewhere.
    build: { minify: false, reportCompressedSize: false, copyPublicDir: false },
  })
  return outFile
}
