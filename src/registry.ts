// Saved-workflow discovery and saving (PARITY P11, P52, P53).
//
// Discovery order (first hit wins on a name clash):
//   1. project  — every `.opencode/workflows/` from cwd up to the repo root, closest first
//   2. personal — `<XDG_CONFIG_HOME or ~/.config>/opencode/workflows/`
//   3. bundled  — this package's `workflows/` directory
// Each `*.js` file is keyed by its `meta.name`. A file whose meta is not a pure literal (or is
// missing) is skipped entirely (P11) — it does not shadow a valid workflow further away.
// Within one directory, files are read in sorted file-name order, so duplicates resolve
// deterministically to the first file.
//
// Saving (P52) mirrors Claude Code's symlink rules: for the project location, refuse when
// `.opencode`, `.opencode/workflows` or the target file is a symlink; for the personal location,
// refuse only when the target file is a symlink (a dotfiles-managed config dir keeps working).

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { extractMetaLoose } from "./meta.ts"
import type { WorkflowMeta } from "./types.ts"

export type WorkflowOrigin = "project" | "personal" | "bundled"

export interface ResolvedWorkflow {
  meta: WorkflowMeta
  source: string
  path: string
  origin: WorkflowOrigin
}

export interface RegistryOptions {
  /** Environment used to resolve XDG_CONFIG_HOME (default: process.env). */
  env?: Record<string, string | undefined>
  /** Explicit config home (overrides env/home); personal dir = <configHome>/opencode/workflows. */
  configHome?: string
  /** Home directory used when XDG_CONFIG_HOME is unset (default: os.homedir()). */
  home?: string
  /** Bundled workflows directory (default: BUNDLED_WORKFLOWS_DIR). */
  bundledDir?: string
}

export interface SaveOptions {
  source: string
  /** File base name (without .js); defaults to meta.name. */
  name?: string
  location: "project" | "personal"
  cwd: string
  env?: Record<string, string | undefined>
  configHome?: string
  home?: string
}

const DIR_PARTS = [".opencode", "workflows"] as const

/** This package's bundled workflows directory. */
export const BUNDLED_WORKFLOWS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "workflows")

/** Closest ancestor of `cwd` (inclusive) containing a `.git` entry (dir or file), or undefined. */
export function findRepoRoot(cwd: string): string | undefined {
  let dir = path.resolve(cwd)
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/** Directories from cwd up to the repo root (inclusive), closest first; just [cwd] outside a repo. */
function ancestorsToRoot(cwd: string): string[] {
  const start = path.resolve(cwd)
  const root = findRepoRoot(start)
  if (!root) return [start]
  const out: string[] = []
  let dir = start
  for (;;) {
    out.push(dir)
    if (dir === root) break
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return out
}

/** Every candidate project `.opencode/workflows` directory, closest to cwd first. */
export function projectWorkflowDirs(cwd: string): string[] {
  return ancestorsToRoot(cwd).map((d) => path.join(d, ...DIR_PARTS))
}

/** `<XDG_CONFIG_HOME or ~/.config>/opencode/workflows`. */
export function personalWorkflowsDir(env: Record<string, string | undefined> = process.env, home: string = os.homedir()): string {
  const xdg = env.XDG_CONFIG_HOME
  const base = xdg && xdg.trim() !== "" ? xdg : path.join(home, ".config")
  return path.join(base, "opencode", "workflows")
}

function personalDir(opts: { env?: Record<string, string | undefined>; configHome?: string; home?: string }): string {
  if (opts.configHome) return path.join(opts.configHome, "opencode", "workflows")
  return personalWorkflowsDir(opts.env ?? process.env, opts.home ?? os.homedir())
}

function readDir(dir: string, origin: WorkflowOrigin): ResolvedWorkflow[] {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const out: ResolvedWorkflow[] = []
  for (const file of names.filter((n) => n.endsWith(".js")).sort()) {
    const p = path.join(dir, file)
    let source: string
    try {
      if (!fs.statSync(p).isFile()) continue
      source = fs.readFileSync(p, "utf8")
    } catch {
      continue
    }
    const meta = extractMetaLoose(source)
    if (!meta) continue
    out.push({ meta, source, path: p, origin })
  }
  return out
}

function sources(cwd: string, opts: RegistryOptions): [string, WorkflowOrigin][] {
  return [
    ...projectWorkflowDirs(cwd).map((d): [string, WorkflowOrigin] => [d, "project"]),
    [personalDir(opts), "personal"],
    [opts.bundledDir ?? BUNDLED_WORKFLOWS_DIR, "bundled"],
  ]
}

/** All visible workflows (shadowed duplicates removed), sorted by name. */
export function listWorkflows(cwd: string, opts: RegistryOptions = {}): ResolvedWorkflow[] {
  const byName = new Map<string, ResolvedWorkflow>()
  for (const [dir, origin] of sources(cwd, opts)) {
    for (const w of readDir(dir, origin)) if (!byName.has(w.meta.name)) byName.set(w.meta.name, w)
  }
  return [...byName.values()].sort((a, b) => (a.meta.name < b.meta.name ? -1 : a.meta.name > b.meta.name ? 1 : 0))
}

/** The workflow that `/<name>` runs from `cwd`, or undefined. */
export function resolveWorkflow(name: string, cwd: string, opts: RegistryOptions = {}): ResolvedWorkflow | undefined {
  for (const [dir, origin] of sources(cwd, opts)) {
    const hit = readDir(dir, origin).find((w) => w.meta.name === name)
    if (hit) return hit
  }
  return undefined
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function isSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

function refuseSymlink(p: string) {
  if (isSymlink(p)) throw new Error(`Refusing to save workflow: ${p} is a symlink`)
}

/** Save a workflow script as `<dir>/<name>.js`; returns the written path. Throws on refusal. */
export function saveWorkflow(opts: SaveOptions): string {
  const meta = extractMetaLoose(opts.source)
  if (!meta) throw new Error("Cannot save workflow: script must start with `export const meta = {...}` as a pure literal with name and description")
  const name = opts.name ?? meta.name
  if (!SAFE_NAME.test(name) || name.includes("..")) {
    throw new Error(`Cannot save workflow: invalid name '${name}' (letters, digits, '.', '_', '-' only; must not start with '.')`)
  }

  let dir: string
  if (opts.location === "project") {
    const bases = ancestorsToRoot(opts.cwd)
    const existing = bases.find((b) => fs.existsSync(path.join(b, ...DIR_PARTS)))
    const base = existing ?? bases[bases.length - 1]!
    const dotDir = path.join(base, DIR_PARTS[0])
    dir = path.join(dotDir, DIR_PARTS[1])
    refuseSymlink(dotDir)
    refuseSymlink(dir)
  } else {
    dir = personalDir(opts)
  }
  const target = path.join(dir, `${name}.js`)
  refuseSymlink(target)
  fs.mkdirSync(dir, { recursive: true })
  // Re-check after mkdir in case a link appeared concurrently.
  if (opts.location === "project") {
    refuseSymlink(path.dirname(dir))
    refuseSymlink(dir)
  }
  refuseSymlink(target)
  fs.writeFileSync(target, opts.source)
  return target
}
