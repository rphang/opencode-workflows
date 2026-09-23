// Guard: every ID in docs/PARITY.md has at least one test in tests/parity/ whose name starts with it.

import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dir, "..", "..")

test("every PARITY.md ID has a tests/parity test whose name starts with the ID", () => {
  const spec = readFileSync(join(root, "docs", "PARITY.md"), "utf8")
  const ids = [...new Set([...spec.matchAll(/^\|\s*(P\d{2})\s*\|/gm)].map((m) => m[1]!))]
  expect(ids.length).toBeGreaterThanOrEqual(40)
  const names: string[] = []
  for (const f of readdirSync(import.meta.dir)) {
    if (!f.endsWith(".test.ts")) continue
    const src = readFileSync(join(import.meta.dir, f), "utf8")
    for (const m of src.matchAll(/\btest\(\s*[`"]([^`"]+)[`"]/g)) names.push(m[1]!)
  }
  // A test name may list several IDs up front ("P41 P44 ...").
  const covered = new Set<string>()
  for (const n of names) for (const m of n.match(/^(?:P\d{2}\s+)+/)?.[0].match(/P\d{2}/g) ?? []) covered.add(m)
  // Template-literal names (e.g. `P57 ...${v}...`) are matched by their prefix.
  const missing = ids.filter((id) => !covered.has(id))
  expect(missing).toEqual([])
})

test("every ID a tests/parity test name starts with has a row in PARITY.md", () => {
  const spec = readFileSync(join(root, "docs", "PARITY.md"), "utf8")
  const rows = new Set([...spec.matchAll(/^\|\s*(P\d{2})\s*\|/gm)].map((m) => m[1]!))
  const used = new Set<string>()
  for (const f of readdirSync(import.meta.dir)) {
    if (!f.endsWith(".test.ts")) continue
    const src = readFileSync(join(import.meta.dir, f), "utf8")
    for (const m of src.matchAll(/\btest\(\s*[`"]([^`"]+)[`"]/g))
      for (const id of m[1]!.match(/^(?:P\d{2}\s+)+/)?.[0].match(/P\d{2}/g) ?? []) used.add(id)
  }
  expect([...used].filter((id) => !rows.has(id)).sort()).toEqual([])
})

test("PARITY.md tables have no blank line splitting a table (every row renders)", () => {
  const lines = readFileSync(join(root, "docs", "PARITY.md"), "utf8").split("\n")
  const orphans: string[] = []
  for (let i = 1; i < lines.length; i++) {
    if (!/^\|\s*P\d{2}\s*\|/.test(lines[i]!)) continue
    const prev = lines[i - 1]!
    if (!prev.startsWith("|")) orphans.push(lines[i]!.slice(0, 8))
  }
  expect(orphans).toEqual([])
})
