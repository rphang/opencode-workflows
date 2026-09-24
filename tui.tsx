// Directory-install TUI entry point. opencode resolves a plugin directory's TUI entry as `<dir>/tui`
// (Host.resolve), and the TUI host compiles local .tsx itself, so this re-export needs no build.
// Package installs use the prebuilt dist/tui.js (package.json exports["./tui"]).
export { default } from "./src/tui/index.tsx"
