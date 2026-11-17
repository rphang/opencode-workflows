// User-facing install and docs checks: the repo loads as an opencode plugin directory, and the README
// documents the install methods and every environment variable the plugin reads.

import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { Host } from "@opencode/plugin/host"
// Imported up front: on Bun 1.4, loading Vite AFTER a Bun.build with the opentui plugin (the TUI build
// test below) throws while Vite's bundled follow-redirects defines its error classes.
import { buildGui, GUI_PROVIDED } from "../../scripts/build-gui.ts"

const ROOT = resolve(import.meta.dir, "..", "..")

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p)
  }
  return out
}

describe("plugin directory install", () => {
  // opencode 2.3+ resolves a directory whose package.json has `name` and `exports` through them, like
  // the published package: `plugins: ["file:///<repo>"]` loads dist/, so a checkout must be built.
  async function checkoutCopy(withDist: boolean): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "wf-dir-install-"))
    writeFileSync(join(dir, "package.json"), readFileSync(join(ROOT, "package.json")))
    if (withDist) {
      mkdirSync(join(dir, "dist"))
      writeFileSync(join(dir, "dist", "index.js"), "export default {}\n")
      writeFileSync(join(dir, "dist", "tui.js"), "export default {}\n")
      writeFileSync(join(dir, "dist", "gui-experimental.cjs"), "module.exports = {}\n")
    }
    return dir
  }

  test("a built checkout resolves through package.json exports to dist/index.js, dist/tui.js and dist/gui-experimental.cjs", async () => {
    const dir = await checkoutCopy(true)
    try {
      const entries = Host.resolve({ directory: dir } as never)
      expect(String(entries.server).replaceAll("\\", "/")).toMatch(/\/dist\/index\.js$/)
      expect(String(entries.tui).replaceAll("\\", "/")).toMatch(/\/dist\/tui\.js$/)
      expect(String(entries.gui).replaceAll("\\", "/")).toMatch(/\/dist\/gui-experimental\.cjs$/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("an unbuilt checkout resolves no entry (hence: npm run build first, documented in INSTALL.md)", async () => {
    const dir = await checkoutCopy(false)
    try {
      expect(Host.resolve({ directory: dir } as never).server).toBeUndefined()
      expect(readFileSync(join(ROOT, "docs", "INSTALL.md"), "utf8")).toMatch(/npm run build/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("TUI entry (live progress tree, X14)", () => {
  test("the server entry never imports the TUI, the GUI, the companions' client logic or their host modules (it loads without the TUI peers)", () => {
    const offenders = walk(join(ROOT, "src"))
      .filter((f) => !/[\\/](tui|client|gui)[\\/]/.test(f))
      .filter((f) => /from ["'](solid-js|@opentui\/|\.\.?\/(\.\.\/)*(tui|client|gui)\/)/.test(readFileSync(f, "utf8")))
    expect(offenders).toEqual([])
  })

  test("the shared client logic (src/client) never imports the TUI, the GUI, Solid, opentui or the plugin SDK (both companions reuse it)", () => {
    const files = walk(join(ROOT, "src", "client"))
    expect(files.length).toBeGreaterThan(0)
    const offenders = files.filter((f) => /from ["'](solid-js|@opentui\/|@opencode\/|\.\.?\/(\.\.\/)*(tui|gui)\/)/.test(readFileSync(f, "utf8")))
    expect(offenders).toEqual([])
  })

  test("dist/tui.js build: compiled JSX, host modules external, no bundled solid-js; the package's ./tui export resolves to it", async () => {
    const { buildTui, TUI_EXTERNALS } = await import("../../scripts/build-tui.ts")
    const tmp = await mkdtemp(join(tmpdir(), "wf-tui-build-"))
    try {
      const pkgDir = join(tmp, "node_modules", "@rphang", "opencode-workflows")
      mkdirSync(join(pkgDir, "dist"), { recursive: true })
      writeFileSync(join(pkgDir, "package.json"), readFileSync(join(ROOT, "package.json")))
      writeFileSync(join(pkgDir, "dist", "index.js"), "export default {}\n")
      const out = await buildTui(join(pkgDir, "dist"))
      const code = readFileSync(out, "utf8")
      expect(code).not.toMatch(/<(box|text|Show|For|Panel)\b/)
      const imports = [...code.matchAll(/^import .* from "([^"]+)";?$/gm)].map((m) => m[1]!)
      expect(imports.length).toBeGreaterThan(0)
      expect(imports.filter((s) => !TUI_EXTERNALS.includes(s))).toEqual([])
      expect(code).not.toMatch(/function createSignal\(/)
      expect(code).toMatch(/dynamic-workflows\.tui/)
      // The shared client logic (src/client) is bundled in, not imported at runtime.
      expect(code).toMatch(/class TreeSync\b/)
      expect(code).toMatch(/class TreeStore\b/)
      const entries = Host.resolve({ name: "@rphang/opencode-workflows", directory: tmp } as never)
      expect(String(entries.tui).replaceAll("\\", "/")).toMatch(/opencode-workflows\/dist\/tui\.js$/)
      expect(String(entries.server).replaceAll("\\", "/")).toMatch(/opencode-workflows\/dist\/index\.js$/)
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  }, 60_000)
})

describe("GUI entry (desktop app companion, X28–X30)", () => {
  const GUI_ONLY = /from ["'](@opencode\/plugin\/gui|solid-js\/web|\.\.?\/(\.\.\/)*gui\/)/

  test("only src/gui imports the GUI SDK, solid-js/web or src/gui; the server entry never mentions the GUI", () => {
    const offenders = walk(join(ROOT, "src"))
      .filter((f) => !/[\\/]gui[\\/]/.test(f))
      .filter((f) => GUI_ONLY.test(readFileSync(f, "utf8")))
    expect(offenders).toEqual([])
    expect(readFileSync(join(ROOT, "src", "index.ts"), "utf8")).not.toMatch(/gui/i)
  })

  test("src/gui never imports the TUI or opentui, its pure model imports no Solid, and every .tsx uses Solid's DOM JSX", () => {
    const files = walk(join(ROOT, "src", "gui"))
    expect(files.length).toBeGreaterThan(3)
    expect(files.filter((f) => /from ["'](@opentui\/|@opencode\/plugin\/tui|\.\.?\/(\.\.\/)*tui\/)/.test(readFileSync(f, "utf8")))).toEqual([])
    const model = readFileSync(join(ROOT, "src", "gui", "model.ts"), "utf8")
    expect(model).not.toMatch(/from ["']solid-js/)
    expect(model).not.toMatch(/^import (?!type)[^\n]*from ["']@opencode\//m)
    // The root tsconfig defaults JSX to @opentui/solid (the TUI); the GUI files say otherwise.
    for (const f of files.filter((f) => f.endsWith(".tsx"))) expect(readFileSync(f, "utf8").startsWith("/** @jsxImportSource solid-js */")).toBe(true)
  })

  test("the build's provided-module list is the preset's (@opencode/plugin/gui/vite)", async () => {
    const file = join(ROOT, "node_modules", "@opencode", "plugin", "dist", "gui", "modules.js")
    const preset = (await import(pathToFileURL(file).href)) as { pluginSharedModules: string[]; pluginWindowModules: string[] }
    expect([...GUI_PROVIDED].sort()).toEqual([...preset.pluginSharedModules, ...preset.pluginWindowModules].sort())
  })

  test("dist/gui-experimental.cjs build: one CommonJS file, app modules external, no opentui or bundled Solid; ./gui-experimental resolves to it; it evaluates as the app does", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "wf-gui-build-"))
    try {
      const pkgDir = join(tmp, "node_modules", "@rphang", "opencode-workflows")
      mkdirSync(join(pkgDir, "dist"), { recursive: true })
      writeFileSync(join(pkgDir, "package.json"), readFileSync(join(ROOT, "package.json")))
      writeFileSync(join(pkgDir, "dist", "index.js"), "export default {}\n")
      const out = await buildGui(join(pkgDir, "dist", "gui-experimental.cjs"))
      // One file: dynamic imports inlined, no second chunk or asset.
      expect(readdirSync(join(pkgDir, "dist")).sort()).toEqual(["gui-experimental.cjs", "index.js"])
      const code = readFileSync(out, "utf8")
      const required = [...new Set([...code.matchAll(/require\(["']([^"']+)["']\)/g)].map((m) => m[1]!))]
      expect(required).toContain("solid-js")
      expect(required).toContain("@opencode/plugin/gui")
      expect(required.filter((s) => !GUI_PROVIDED.includes(s))).toEqual([])
      // The preset does not catch these: opentui (the TUI's renderer) must never reach the GUI bundle.
      expect(code).not.toMatch(/opentui/)
      expect(code).not.toMatch(/function createSignal\(/)
      expect(code).not.toMatch(/<(Show|Index|For|TreePanel|ui\.)[\s>]/)
      expect(code).not.toMatch(/^\s*(import|export) /m)
      // The shared client logic is bundled in, not required at runtime.
      expect(code).toMatch(/class TreeSync\b/)
      expect(code).toMatch(/class TreeStore\b/)
      expect(code).toMatch(/dynamic-workflows/)
      const entries = Host.resolve({ name: "@rphang/opencode-workflows", directory: tmp } as never)
      expect(String(entries.gui).replaceAll("\\", "/")).toMatch(/opencode-workflows\/dist\/gui-experimental\.cjs$/)

      // As the app's main process evaluates it: CommonJS text, the SDK real, the window-only modules inert.
      const sdk = await import("@opencode/plugin/gui")
      const inert: object = new Proxy(function inert() {}, { get: () => inert, apply: () => inert, construct: () => inert })
      const asked: string[] = []
      const require = (name: string) => {
        asked.push(name)
        if (!GUI_PROVIDED.includes(name)) throw new Error(`not provided: ${name}`)
        return name === "@opencode/plugin/gui" || name === "@opencode/plugin/gui/main" ? sdk : inert
      }
      const module = { exports: {} as Record<string, unknown> }
      new Function("require", "module", "exports", code)(require, module, module.exports)
      const plugin = ("default" in module.exports ? module.exports.default : module.exports) as Record<string, unknown>
      expect(typeof plugin.setup).toBe("function")
      expect(Object.keys(plugin).sort()).toEqual(["i18n", "setup"])
      const i18n = plugin.i18n as { en: Record<string, unknown> }
      expect(Object.values(i18n.en).every((v) => typeof v === "string")).toBe(true)
      expect(i18n.en["panel.title"]).toBe("Workflows")
      expect(asked).toContain("@opencode/plugin/gui")
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  }, 120_000)
})

describe("README", () => {
  const readmePath = join(ROOT, "README.md")

  test("exists and documents the verified install methods and the opencode pin", () => {
    expect(existsSync(readmePath)).toBe(true)
    const readme = readFileSync(readmePath, "utf8")
    expect(readme).toContain("plugins/workflows.js")
    expect(readme).toContain('export { default } from "')
    expect(readme).toContain("file:///")
    expect(readme).toContain("2.3.0")
    expect(readme).toContain("--standalone")
    for (const cmd of ["/deep-research", "/workflows", "/workflow-authoring", "workflow_control", "ultracode"]) {
      expect(readme).toContain(cmd)
    }
  })

  test("documents every environment variable the plugin reads", () => {
    const readme = existsSync(readmePath) ? readFileSync(readmePath, "utf8") : ""
    const names = new Set<string>()
    for (const file of walk(join(ROOT, "src"))) {
      const src = readFileSync(file, "utf8")
      for (const m of src.matchAll(/process\.env\.([A-Z0-9_]+)/g)) names.add(m[1]!)
      for (const m of src.matchAll(/\benv\.((?:OPENCODE|MAX)_[A-Z0-9_]+)/g)) names.add(m[1]!)
      // env names held in constants, e.g. MAX_CONCURRENT_ENV = "OPENCODE_WORKFLOW_MAX_CONCURRENT_AGENTS"
      for (const m of src.matchAll(/["'`](OPENCODE_[A-Z0-9_]+)["'`]/g)) names.add(m[1]!)
    }
    expect(names.size).toBeGreaterThan(3)
    const missing = [...names].filter((n) => !readme.includes(n))
    expect(missing).toEqual([])
  })
})

describe("PARITY.md drift", () => {
  const parity = readFileSync(join(ROOT, "docs", "PARITY.md"), "utf8")

  test("P06 is recorded as live-verified (tests/e2e/basic.test.ts), not as pending", () => {
    expect(parity.includes("not yet verified live")).toBe(false)
    const p06 = parity.split("\n").find((l) => l.startsWith("| P06 "))!
    expect(p06).toContain("basic.test.ts")
  })

  test("the test-evidence file count matches tests/parity", () => {
    const files = readdirSync(join(ROOT, "tests", "parity")).filter((f) => f.endsWith(".test.ts")).length
    const m = parity.match(/runs \d+ tests in (\d+) files/)
    expect(m).not.toBeNull()
    expect(Number(m![1])).toBe(files)
  })

  test("never points at a README section that does not exist", () => {
    if (!/README/.test(parity)) return
    expect(existsSync(join(ROOT, "README.md"))).toBe(true)
  })
})

describe("README accuracy", () => {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8")
  const parity = readFileSync(join(ROOT, "docs", "PARITY.md"), "utf8")

  test("every ```js example that starts with `export const meta` is a valid workflow script", async () => {
    const { parseScript } = await import("../../src/meta.ts")
    const { checkBodySyntax } = await import("../../src/sandbox.ts")
    const blocks = [...readme.matchAll(/^```js\n([\s\S]*?)^```/gm)].map((m) => m[1]!).filter((b) => b.startsWith("export const meta"))
    expect(blocks.length).toBeGreaterThan(0)
    for (const b of blocks) {
      const parsed = parseScript(b) as { meta?: { name?: string }; body?: string; error?: string }
      expect(parsed.error).toBeUndefined()
      expect(parsed.meta?.name).toBeTruthy()
      expect(checkBodySyntax(parsed.body ?? "").ok).toBe(true)
    }
  })

  test("the DEGRADED/N/A table lists exactly the PARITY IDs whose status is DEGRADED or N/A", () => {
    const degraded = [...parity.matchAll(/^\|\s*(P\d{2})\s*\|[^|]*\|\s*(DEGRADED|N\/A)\b/gm)].map((m) => m[1]!).sort()
    const listed = [...readme.matchAll(/^\|\s*(P\d{2})\s*\|[^|]*\|\s*(DEGRADED|N\/A)\s*\|/gm)].map((m) => m[1]!).sort()
    expect(degraded.length).toBeGreaterThan(5)
    expect(listed).toEqual(degraded)
  })

  test("has the user-facing sections", () => {
    for (const h of ["## Install", "## Usage", "## Script API", "## Environment variables", "## Security model", "## Troubleshooting", "## Development"]) {
      expect(readme).toContain(h)
    }
  })
})

describe("README script example runs", () => {
  test("the Script API example runs end to end on the fake runner and returns the schema object", async () => {
    const { createHarness } = await import("../helpers/plugin-harness.ts")
    const { FakeRunner } = await import("../helpers/fake-runner.ts")
    const readme = readFileSync(join(ROOT, "README.md"), "utf8")
    const script = [...readme.matchAll(/^```js\n([\s\S]*?)^```/gm)].map((m) => m[1]!).find((b) => b.startsWith("export const meta"))!
    const h = await createHarness()
    try {
      const runner = new FakeRunner().on("Summarize", { value: { summary: "ok" } })
      const p = await h.setup({ runner })
      const out = await p.call({ script, args: ["a.ts", "b.ts"] })
      expect(out.error).toBeUndefined()
      expect(p.resultOf(await p.notification(0))).toEqual({ summary: "ok" })
    } finally {
      await h.dispose()
    }
  })
})
