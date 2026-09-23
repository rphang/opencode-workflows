// Guard: every ID in docs/PARITY.md (P = Claude Code parity, X = extension beyond Claude Code) has at
// least one test in tests/parity/ whose name starts with it.

import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dir, "..", "..")

/** A PARITY.md table row: `| P41 | …` or `| X01 | …`. */
const ROW = /^\|\s*((?:P|X)\d{2})\s*\|/gm
/** The IDs a test name starts with ("P41 P44 …", "X06 P41 …"). */
function leadingIds(name: string): string[] {
  return name.match(/^(?:(?:P|X)\d{2}\s+)+/)?.[0].match(/(?:P|X)\d{2}/g) ?? []
}

function testNames(): string[] {
  const names: string[] = []
  for (const f of readdirSync(import.meta.dir)) {
    if (!f.endsWith(".test.ts")) continue
    const src = readFileSync(join(import.meta.dir, f), "utf8")
    for (const m of src.matchAll(/\btest\(\s*[`"]([^`"]+)[`"]/g)) names.push(m[1]!)
  }
  return names
}

test("every PARITY.md ID has a tests/parity test whose name starts with the ID", () => {
  const spec = readFileSync(join(root, "docs", "PARITY.md"), "utf8")
  const ids = [...new Set([...spec.matchAll(ROW)].map((m) => m[1]!))]
  expect(ids.length).toBeGreaterThanOrEqual(40)
  // A test name may list several IDs up front ("P41 P44 ...").
  const covered = new Set<string>()
  for (const n of testNames()) for (const id of leadingIds(n)) covered.add(id)
  // Template-literal names (e.g. `P57 ...${v}...`) are matched by their prefix.
  const missing = ids.filter((id) => !covered.has(id))
  expect(missing).toEqual([])
})

test("every ID a tests/parity test name starts with has a row in PARITY.md", () => {
  const spec = readFileSync(join(root, "docs", "PARITY.md"), "utf8")
  const rows = new Set([...spec.matchAll(ROW)].map((m) => m[1]!))
  const used = new Set<string>()
  for (const n of testNames()) for (const id of leadingIds(n)) used.add(id)
  expect([...used].filter((id) => !rows.has(id)).sort()).toEqual([])
})

test("PARITY.md tables have no blank line splitting a table (every row renders)", () => {
  const lines = readFileSync(join(root, "docs", "PARITY.md"), "utf8").split("\n")
  const orphans: string[] = []
  for (let i = 1; i < lines.length; i++) {
    if (!/^\|\s*(?:P|X)\d{2}\s*\|/.test(lines[i]!)) continue
    const prev = lines[i - 1]!
    if (!prev.startsWith("|")) orphans.push(lines[i]!.slice(0, 8))
  }
  expect(orphans).toEqual([])
})

test("extension rows (X IDs) are marked EXT", () => {
  const spec = readFileSync(join(root, "docs", "PARITY.md"), "utf8")
  const bad = spec
    .split("\n")
    .filter((l) => /^\|\s*X\d{2}\s*\|/.test(l))
    .filter((l) => !/\|\s*EXT\b/.test(l))
    .map((l) => l.slice(0, 8))
  expect(bad).toEqual([])
})
