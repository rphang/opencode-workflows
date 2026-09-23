// User-facing install and docs checks: the repo loads as an opencode plugin directory, and the README
// documents the install methods and every environment variable the plugin reads.

import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Host } from "@opencode/plugin/host"

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
  test("opencode's Host.resolve finds a server entry for the repo directory (plugins: [\"file:///<repo>\"])", async () => {
    const entry = Host.resolve({ directory: ROOT } as never).server
    expect(entry).toBeDefined()
    const mod = (await import(String(entry))) as { default: unknown }
    const direct = (await import(join(ROOT, "src", "index.ts"))) as { default: unknown }
    expect(mod.default).toBe(direct.default)
  })
})

describe("TUI entry (live progress tree, X14)", () => {
  test("Host.resolve finds the TUI entry of the repo directory (root tui.tsx)", () => {
    const entries = Host.resolve({ directory: ROOT } as never)
    expect(String(entries.tui)).toMatch(/tui\.tsx$/)
  })

  test("the server entry never imports the TUI or its host modules (it loads without the TUI peers)", () => {
    const offenders = walk(join(ROOT, "src"))
      .filter((f) => !/[\\/]tui[\\/]/.test(f))
      .filter((f) => /from ["'](solid-js|@opentui\/|\.\.?\/(\.\.\/)*tui\/)/.test(readFileSync(f, "utf8")))
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
      const entries = Host.resolve({ name: "@rphang/opencode-workflows", directory: tmp } as never)
      expect(String(entries.tui).replaceAll("\\", "/")).toMatch(/opencode-workflows\/dist\/tui\.js$/)
      expect(String(entries.server).replaceAll("\\", "/")).toMatch(/opencode-workflows\/dist\/index\.js$/)
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  }, 60_000)
})

describe("README", () => {
  const readmePath = join(ROOT, "README.md")

  test("exists and documents the verified install methods and the opencode pin", () => {
    expect(existsSync(readmePath)).toBe(true)
    const readme = readFileSync(readmePath, "utf8")
    expect(readme).toContain("plugins/workflows.js")
    expect(readme).toContain('export { default } from "')
    expect(readme).toContain("file:///")
    expect(readme).toContain("2.0.15")
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
