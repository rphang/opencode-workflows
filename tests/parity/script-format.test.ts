// Parity: script format (P10–P16), through the plugin's `workflow` tool.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { extractMetaLoose } from "../../src/meta.ts"
import { sleep } from "../helpers/fake-runner.ts"
import { createHarness, script, type Harness, type Plugged } from "../helpers/plugin-harness.ts"

let h: Harness
beforeEach(async () => {
  h = await createHarness()
})
afterEach(async () => {
  await h.dispose()
})

/** Launches `src`; expects a static error matching `re` and asserts nothing ran. */
async function rejected(p: Plugged, src: string, re: RegExp) {
  const out = await p.call({ script: src })
  expect(out.status).toBe("async_launched")
  expect(out.error).toMatch(re)
  await sleep(20)
  expect(p.runner.calls.length).toBe(0)
  expect(p.notifications().length).toBe(0)
  return out
}

describe("P10 meta", () => {
  test("P10 a pure-literal meta with name, description, phases and whenToUse is accepted", async () => {
    const p = await h.setup()
    const out = await p.call({
      script: script(
        `phase("Scan"); return 1`,
        `{ name: "full", description: "all fields", whenToUse: "when testing", phases: [{ title: "Scan", detail: "scan it", model: "openai/gpt-5" }] }`,
      ),
    })
    expect(out.error).toBeUndefined()
    expect(out.warning).toBeUndefined()
    expect(out.workflowName).toBe("full")
    expect(p.resultOf(await p.notification(0))).toBe(1)
  })

  test("P10 meta must be the FIRST statement", async () => {
    const p = await h.setup()
    await rejected(p, `const x = 1\nexport const meta = { name: "a", description: "b" }\nreturn x`, /first statement/)
  })

  test("P10 meta with a variable is rejected", async () => {
    const p = await h.setup()
    await rejected(p, `export const meta = { name: someName, description: "b" }\nreturn 1`, /pure literal: Identifier 'someName'/)
  })

  test("P10 meta with a function call is rejected", async () => {
    const p = await h.setup()
    await rejected(p, `export const meta = { name: String("a"), description: "b" }\nreturn 1`, /pure literal: CallExpression/)
  })

  test("P10 meta with a spread is rejected", async () => {
    const p = await h.setup()
    await rejected(p, `export const meta = { ...{ name: "a" }, description: "b" }\nreturn 1`, /pure literal: SpreadElement/)
  })

  test("P10 meta with template interpolation is rejected (plain templates are fine)", async () => {
    const p = await h.setup()
    await rejected(p, "export const meta = { name: `a${1}`, description: \"b\" }\nreturn 1", /template literal interpolation/)
    const ok = await p.call({ script: "export const meta = { name: `plain`, description: `d` }\nreturn 1" })
    expect(ok.error).toBeUndefined()
  })

  test("P10 name and description are required", async () => {
    const p = await h.setup()
    await rejected(p, `export const meta = { description: "b" }\nreturn 1`, /meta\.name is required/)
    await rejected(p, `export const meta = { name: "a" }\nreturn 1`, /meta\.description is required/)
  })

  test("P10 phases must be [{title, detail?, model?}]", async () => {
    const p = await h.setup()
    await rejected(p, `export const meta = { name: "a", description: "b", phases: [{ detail: "x" }] }\nreturn 1`, /title is required/)
  })
})

describe("P11 non-literal meta", () => {
  test("P11 inline script with a non-literal meta fails with an error", async () => {
    const p = await h.setup()
    await rejected(p, `export const meta = { name: "x" + "y", description: "d" }\nreturn 1`, /pure literal: BinaryExpression/)
  })

  test("P11 a saved workflow with a non-literal meta gets no /<name> command", async () => {
    const dir = join(h.projectDir, ".opencode", "workflows")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "bad.js"), `const n = "bad"\nexport const meta = { name: n, description: "d" }\nreturn 1\n`)
    writeFileSync(join(dir, "bad2.js"), `export const meta = { name: "bad2", description: "d" + "" }\nreturn 1\n`)
    writeFileSync(join(dir, "good.js"), script(`return 1`, `{ name: "good", description: "fine" }`))
    const p = await h.setup()
    const cmds = p.commands()
    expect(cmds.has("bad")).toBe(false)
    expect(cmds.has("bad2")).toBe(false)
    expect(cmds.has("good")).toBe(true)
  })

  test("P11 a saved workflow whose BODY is broken keeps its command; the error comes at run time", async () => {
    const dir = join(h.projectDir, ".opencode", "workflows")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "broken.js"), script(`return (`, `{ name: "broken", description: "body error" }`))
    const p = await h.setup()
    expect(p.commands().has("broken")).toBe(true)
    const out = await p.call({ name: "broken" })
    expect(out.error).toMatch(/SyntaxError/)
  })

  test("P11 extractMetaLoose returns null for non-literal metas", () => {
    expect(extractMetaLoose(`export const meta = { name: n, description: "d" }`)).toBeNull()
    expect(extractMetaLoose(`export const meta = { name: "n", description: "d" }\nreturn (`)?.name).toBe("n")
  })
})

describe("P12 body", () => {
  test("P12 top-level await and top-level return (the return value is the result)", async () => {
    const p = await h.setup()
    await p.call({ script: script(`const a = await agent("one")\nif (a) return { got: a }\nreturn "never"`) })
    expect(p.resultOf(await p.notification(0))).toEqual({ got: "done: one" })
  })

  test("P12 the body is plain JS: functions, closures, destructuring, Map/Set, JSON", async () => {
    const p = await h.setup()
    await p.call({
      script: script(`
const count = (xs) => { const m = new Map(); for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1); return m }
const { a, ...rest } = { a: 1, b: 2, c: 3 }
const m = count(["x", "y", "x"])
return JSON.parse(JSON.stringify({ a, rest, x: m.get("x"), set: [...new Set([1, 1, 2])] }))`),
    })
    expect(p.resultOf(await p.notification(0))).toEqual({ a: 1, rest: { b: 2, c: 3 }, x: 2, set: [1, 2] })
  })

  test("P12 a script without return completes with a null result", async () => {
    const p = await h.setup()
    await p.call({ script: script(`await agent("a")`) })
    const n = await p.notification(0)
    expect(n.text).toContain("<status>completed</status>")
  })
})

describe("P13 module loading", () => {
  test("P13 static import fails before the run starts", async () => {
    const p = await h.setup()
    await rejected(p, script(`import fs from "node:fs"\nreturn 1`), /import declarations are not allowed/)
  })

  test("P13 dynamic import() fails before the run starts", async () => {
    const p = await h.setup()
    await rejected(p, script(`await agent("a")\nconst m = await import("node:fs")\nreturn 1`), /dynamic import\(\) is not allowed/)
  })

  test("P13 require() fails before the run starts", async () => {
    const p = await h.setup()
    await rejected(p, script(`const fs = require("fs")\nreturn 1`), /require\(\) is not allowed/)
  })

  test("P13 import.meta fails before the run starts", async () => {
    const p = await h.setup()
    await rejected(p, script(`return import.meta.url`), /import\.meta is not allowed/)
  })
})

describe("P14 TypeScript syntax", () => {
  test("P14 type annotations are a syntax error and the run does not start", async () => {
    const p = await h.setup()
    const out = await rejected(p, script(`const x: number = 1\nreturn x`), /SyntaxError/)
    expect(out.error).toMatch(/\d+:\d+|line \d+/)
  })

  test("P14 interfaces are a syntax error", async () => {
    const p = await h.setup()
    await rejected(p, script(`interface Foo { a: string }\nreturn 1`), /SyntaxError/)
  })

  test("P14 generic declarations are a syntax error", async () => {
    const p = await h.setup()
    await rejected(p, script(`function id<T>(x: T): T { return x }\nreturn id(1)`), /SyntaxError/)
  })

  test("P14 `as` casts are a syntax error", async () => {
    const p = await h.setup()
    await rejected(p, script(`const y = (1 as number)\nreturn y`), /SyntaxError/)
  })
})

describe("P15 determinism guards", () => {
  async function probe(p: Plugged, expr: string): Promise<string> {
    const i = p.notifications().length
    await p.call({ script: script(`try { const v = ${expr}; return "ok:" + String(v) } catch (e) { return "threw:" + e.message }`) })
    return String(p.resultOf(await p.notification(i)))
  }

  test("P15 Date.now() throws", async () => {
    const p = await h.setup()
    expect(await probe(p, "Date.now()")).toMatch(/^threw:.*Date\.now\(\).*not available/)
  })

  test("P15 Math.random() throws", async () => {
    const p = await h.setup()
    expect(await probe(p, "Math.random()")).toMatch(/^threw:.*Math\.random\(\).*not available/)
  })

  test("P15 no-argument new Date() throws", async () => {
    const p = await h.setup()
    expect(await probe(p, "new Date()")).toMatch(/^threw:.*not available/)
    expect(await probe(p, "new Date")).toMatch(/^threw:.*not available/)
  })

  test("P15 new Date(x) with an argument keeps working (and so do Date.UTC/parse and Math.*)", async () => {
    const p = await h.setup()
    expect(await probe(p, `new Date(0).toISOString()`)).toBe("ok:1970-01-01T00:00:00.000Z")
    expect(await probe(p, `new Date("2024-05-01T00:00:00Z").getTime()`)).toBe("ok:1714521600000")
    expect(await probe(p, `Date.UTC(2020, 0, 1)`)).toBe("ok:1577836800000")
    expect(await probe(p, `Math.max(1, 5, 3) + Math.floor(2.7)`)).toBe("ok:7")
    expect(await probe(p, `new Date(0) instanceof Date`)).toBe("ok:true")
  })

  test("P15 an uncaught Date.now() fails the run with a resume-oriented message", async () => {
    const p = await h.setup()
    await p.call({ script: script(`return Date.now()`) })
    const text = String((await p.notification(0)).text)
    expect(text).toContain("<status>failed</status>")
    expect(text).toMatch(/pass a timestamp in through args/)
  })
})

describe("P16 no host access", () => {
  test("P16 require, process, fetch, globalThis, Bun, setTimeout, eval are unavailable", async () => {
    const p = await h.setup()
    await p.call({
      script: script(
        `return [typeof process, typeof fetch, typeof globalThis, typeof Bun, typeof setTimeout, typeof eval, typeof Deno, typeof window, typeof XMLHttpRequest]`,
      ),
    })
    const res = p.resultOf(await p.notification(0)) as string[]
    expect(res.every((t) => t === "undefined")).toBe(true)
  })

  test("P16 the Function-constructor escape does not reach the host", async () => {
    const p = await h.setup()
    await p.call({
      script: script(`try { const f = (() => {}).constructor("return typeof process"); return "ran:" + f() } catch (e) { return "blocked" }`),
    })
    const r = String(p.resultOf(await p.notification(0)))
    expect(r === "blocked" || r === "ran:undefined").toBe(true)
  })

  test("P16 referencing a Node API fails the run", async () => {
    const p = await h.setup()
    await p.call({ script: script(`return process.env.HOME`) })
    const text = String((await p.notification(0)).text)
    expect(text).toContain("<status>failed</status>")
  })
})
