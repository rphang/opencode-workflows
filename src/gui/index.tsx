/** @jsxImportSource solid-js */
// Desktop app companion of @rphang/opencode-workflows (X28–X30): a composer pill with the session's
// active runs, the live progress tree as a side panel, and a system notification when a run finishes.
//
// opencode's desktop app loads it for every active server plugin whose package has a
// `./gui-experimental` entry (Host.resolve → gui): `exports["./gui-experimental"]` →
// dist/gui-experimental.cjs, one CommonJS file built by scripts/build-gui.ts with the app's modules
// (solid-js, @opencode/plugin/gui, …) external. The app evaluates it in each window and in its main
// process (with the window-only modules inert), so this module does nothing at load time but
// `Plugin.define`. The GUI plugin API is experimental (opencode 2.3).

import { Plugin } from "@opencode/plugin/gui"
import en from "./i18n/en.ts"
import { setup } from "./window.tsx"

export default Plugin.define({ i18n: { en }, setup })
