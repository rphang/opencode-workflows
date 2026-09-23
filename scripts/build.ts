// Builds the publishable package into dist/:
//   dist/index.js   one ESM bundle of src/ (runtime dependencies stay external: they are declared in
//                   package.json and installed next to the plugin, so `effect` is shared with
//                   @opencode/codemode instead of being duplicated)
//   dist/tui.js     the TUI companion (live progress tree), precompiled Solid JSX with every
//                   host-provided module external (scripts/build-tui.ts)
//   dist/*.d.ts     type declarations emitted by tsc from tsconfig.build.json
//
// The bundle targets Node-compatible ESM (node: builtins only, no Bun APIs), so it loads both in
// opencode's Bun runtime and through its Node import path. src/registry.ts locates the bundled
// workflows with `import.meta.url/../workflows`, which still resolves to the package's workflows/
// directory from dist/index.js.
//
// Run with `npm run build` (or `npx bun scripts/build.ts`).

import { readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { buildTui } from "./build-tui.ts"

const root = path.resolve(import.meta.dir, "..")
const dist = path.join(root, "dist")

rmSync(dist, { recursive: true, force: true })

const result = await Bun.build({
  entrypoints: [path.join(root, "src", "index.ts")],
  outdir: dist,
  target: "node",
  format: "esm",
  packages: "external",
  sourcemap: "none",
  minify: false,
})
if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
for (const output of result.outputs) console.log(`built ${path.relative(root, output.path)}`)

try {
  const tui = await buildTui(dist)
  console.log(`built ${path.relative(root, tui)}`)
} catch (e) {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
}

const tsc = spawnSync("npx", ["tsc", "-p", "tsconfig.build.json"], {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32",
})
if (tsc.status !== 0) {
  console.error("type declaration build failed")
  process.exit(tsc.status ?? 1)
}
// The sources import siblings as `./x.ts` (Bun loads them directly). tsc keeps those specifiers in
// declarations, so point them at the emitted `./x.js` for consumers without allowImportingTsExtensions.
let rewritten = 0
for (const file of new Bun.Glob("**/*.d.ts").scanSync({ cwd: dist, absolute: true })) {
  const text = readFileSync(file, "utf8")
  const next = text.replace(/(["'])(\.{1,2}\/[^"']+)\.ts\1/g, "$1$2.js$1")
  if (next !== text) {
    writeFileSync(file, next)
    rewritten++
  }
}
console.log(`built dist/*.d.ts (${rewritten} files with rewritten relative imports)`)
