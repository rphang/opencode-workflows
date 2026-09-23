import { describe, expect, test } from "bun:test"
import { extractMetaLoose, isPureLiteralMeta, parseScript } from "../../src/meta.ts"
import * as acorn from "acorn"

const META = `export const meta = { name: 'demo', description: 'A demo workflow' }\n`

function ok(source: string) {
  const r = parseScript(source)
  if (!r.ok) throw new Error("expected ok, got: " + r.error)
  return r
}
function err(source: string): string {
  const r = parseScript(source)
  if (r.ok) throw new Error("expected error, got ok")
  return r.error
}

describe("parseScript: valid scripts", () => {
  test("minimal meta + body", () => {
    const r = ok(META + "return 42\n")
    expect(r.meta).toEqual({ name: "demo", description: "A demo workflow" })
    expect(r.warnings).toEqual([])
  })

  test("full meta with phases and whenToUse", () => {
    const r = ok(`export const meta = {
  name: "full",
  description: \`multi
line\`,
  whenToUse: 'when needed',
  phases: [
    { title: 'Find', detail: 'discover files' },
    { title: 'Audit', model: 'openai/gpt-5.4-mini' },
  ],
}
phase('Find')
await agent('x')
phase('Audit')
return 1
`)
    expect(r.meta).toEqual({
      name: "full",
      description: "multi\nline",
      whenToUse: "when needed",
      phases: [
        { title: "Find", detail: "discover files" },
        { title: "Audit", model: "openai/gpt-5.4-mini" },
      ],
    })
    expect(r.warnings).toEqual([])
  })

  test("comments before meta are allowed", () => {
    ok("// hello\n/* block */\n" + META + "return 1")
  })

  test("quoted keys, numbers, negatives, booleans, null, nested arrays allowed", () => {
    const r = ok(`export const meta = { 'name': 'n', "description": 'd', extra: { a: [1, -2, true, null, 'x', \`t\`] } }\nreturn 1`)
    expect(r.meta.name).toBe("n")
  })

  test("P12 top-level await and top-level return are allowed", () => {
    ok(META + "const x = await agent('hi')\nif (x) return x\nreturn null\n")
  })

  test("body removes meta but preserves line count", () => {
    const src = `export const meta = {\n  name: 'a',\n  description: 'b',\n}\nconst x = 1\nreturn x\n`
    const r = ok(src)
    expect(r.body.split("\n").length).toBe(src.split("\n").length)
    expect(r.body).not.toContain("meta")
    expect(r.body.split("\n")[4]).toBe("const x = 1")
    expect(r.body.split("\n")[5]).toBe("return x")
  })

  test("body preserves CRLF line count", () => {
    const src = "export const meta = {\r\n name: 'a',\r\n description: 'b' }\r\nreturn 1\r\n"
    const r = ok(src)
    expect(r.body.split("\n").length).toBe(src.split("\n").length)
    expect(r.body).toContain("return 1")
  })

  test("body keeps code on same line after meta statement", () => {
    const r = ok(`export const meta = { name: 'a', description: 'b' }; const y = 2\nreturn y`)
    expect(r.body).toContain("const y = 2")
    expect(r.body).not.toContain("meta")
  })

  test("hashbang line is accepted and blanked from body", () => {
    const r = ok("#!/usr/bin/env node\n" + META + "return 1")
    expect(r.body.startsWith("#!")).toBe(false)
    expect(r.body.split("\n").length).toBe(3)
  })

  test("meta identifier used later in body is fine (body just does not see it)", () => {
    ok(META + "log('running')\nreturn 1")
  })
})

describe("parseScript: P10/P11 meta must be first and pure literal", () => {
  test("missing meta", () => {
    expect(err("return 1")).toMatch(/export const meta/)
  })

  test("empty script", () => {
    expect(err("")).toMatch(/export const meta/)
  })

  test("meta not first statement", () => {
    expect(err(`const a = 1\n` + META)).toMatch(/first statement/)
  })

  test("let instead of const", () => {
    expect(err(`export let meta = { name: 'a', description: 'b' }`)).toMatch(/export const meta/)
  })

  test("wrong exported name", () => {
    expect(err(`export const info = { name: 'a', description: 'b' }`)).toMatch(/export const meta/)
  })

  test("multiple declarators", () => {
    expect(err(`export const meta = { name: 'a', description: 'b' }, other = 1`)).toMatch(/single/)
  })

  test("meta not an object literal", () => {
    expect(err(`export const meta = 'x'`)).toMatch(/object literal/)
  })

  test("identifier value rejected", () => {
    const e = err(`export const meta = { name: NAME, description: 'b' }`)
    expect(e).toMatch(/Identifier/)
    expect(e).toMatch(/NAME/)
  })

  test("call rejected", () => {
    expect(err(`export const meta = { name: foo(), description: 'b' }`)).toMatch(/CallExpression/)
  })

  test("spread rejected", () => {
    expect(err(`export const meta = { ...base, name: 'a', description: 'b' }`)).toMatch(/SpreadElement/)
  })

  test("array spread rejected", () => {
    expect(err(`export const meta = { name: 'a', description: 'b', phases: [...p] }`)).toMatch(/SpreadElement/)
  })

  test("template interpolation rejected", () => {
    expect(err("export const meta = { name: `a${x}`, description: 'b' }")).toMatch(/interpolation/)
  })

  test("computed key rejected", () => {
    expect(err(`export const meta = { ['name']: 'a', description: 'b' }`)).toMatch(/computed/i)
  })

  test("method / getter rejected", () => {
    expect(err(`export const meta = { name: 'a', description: 'b', f() {} }`)).toMatch(/method|FunctionExpression/)
    expect(err(`export const meta = { name: 'a', description: 'b', get g() { return 1 } }`)).toMatch(/getter|accessor|get/)
  })

  test("shorthand property rejected", () => {
    expect(err(`export const meta = { name, description: 'b' }`)).toMatch(/shorthand|Identifier/)
  })

  test("arithmetic rejected", () => {
    expect(err(`export const meta = { name: 'a' + 'b', description: 'b' }`)).toMatch(/BinaryExpression/)
  })

  test("unary other than negative number rejected", () => {
    expect(err(`export const meta = { name: 'a', description: 'b', n: -'x' }`)).toMatch(/UnaryExpression/)
    expect(err(`export const meta = { name: 'a', description: 'b', n: !0 }`)).toMatch(/UnaryExpression/)
  })

  test("regex and bigint literals rejected", () => {
    expect(err(`export const meta = { name: 'a', description: 'b', r: /x/ }`)).toMatch(/regex/i)
    expect(err(`export const meta = { name: 'a', description: 'b', r: 10n }`)).toMatch(/bigint/i)
  })

  test("error names line:col of the offending construct", () => {
    expect(err(`export const meta = {\n  name: NAME,\n  description: 'b' }`)).toMatch(/\(2:8\)/)
  })

  test("name required, must be non-empty string", () => {
    expect(err(`export const meta = { description: 'b' }`)).toMatch(/name/)
    expect(err(`export const meta = { name: '', description: 'b' }`)).toMatch(/name/)
    expect(err(`export const meta = { name: 5, description: 'b' }`)).toMatch(/name/)
  })

  test("description required string", () => {
    expect(err(`export const meta = { name: 'a' }`)).toMatch(/description/)
    expect(err(`export const meta = { name: 'a', description: ['x'] }`)).toMatch(/description/)
  })

  test("whenToUse must be string if present", () => {
    expect(err(`export const meta = { name: 'a', description: 'b', whenToUse: 3 }`)).toMatch(/whenToUse/)
  })

  test("phases shape validated", () => {
    expect(err(`export const meta = { name: 'a', description: 'b', phases: {} }`)).toMatch(/phases/)
    expect(err(`export const meta = { name: 'a', description: 'b', phases: ['x'] }`)).toMatch(/phases\[0\]/)
    expect(err(`export const meta = { name: 'a', description: 'b', phases: [{ detail: 'x' }] }`)).toMatch(/title/)
    expect(err(`export const meta = { name: 'a', description: 'b', phases: [{ title: 'x', detail: 1 }] }`)).toMatch(/detail/)
    expect(err(`export const meta = { name: 'a', description: 'b', phases: [{ title: 'x', model: 1 }] }`)).toMatch(/model/)
  })

  test("duplicate phase titles rejected", () => {
    expect(err(`export const meta = { name: 'a', description: 'b', phases: [{ title: 'x' }, { title: 'x' }] }`)).toMatch(/duplicate/i)
  })
})

describe("parseScript: P13 imports/require rejected", () => {
  test("import declaration after meta", () => {
    expect(err(META + `import fs from 'fs'\nreturn 1`)).toMatch(/import/)
  })

  test("import declaration before meta", () => {
    expect(err(`import fs from 'fs'\n` + META)).toMatch(/import/)
  })

  test("dynamic import()", () => {
    expect(err(META + `const m = await import('fs')\nreturn 1`)).toMatch(/import\(\)/)
  })

  test("dynamic import nested in function", () => {
    expect(err(META + `async function f() { return (await import('x')).default }\nreturn 1`)).toMatch(/import\(\)/)
  })

  test("import.meta", () => {
    expect(err(META + `return import.meta.url`)).toMatch(/import\.meta/)
  })

  test("require call", () => {
    expect(err(META + `const fs = require('fs')\nreturn 1`)).toMatch(/require/)
  })

  test("require nested deep", () => {
    expect(err(META + `const f = () => [1].map(x => require('child_process'))\nreturn 1`)).toMatch(/require/)
  })

  test("error includes location", () => {
    expect(err(META + `const fs = require('fs')`)).toMatch(/\(2:11\)/)
  })

  test("other exports rejected", () => {
    expect(err(META + `export const x = 1`)).toMatch(/export/)
    expect(err(META + `export default 1`)).toMatch(/export/)
    expect(err(META + `const y = 1\nexport { y }`)).toMatch(/export/)
    expect(err(META + `export * from 'x'`)).toMatch(/export/)
  })

  test("a string mentioning require is fine", () => {
    ok(META + `log('require("fs") is not allowed')\nreturn 1`)
  })

  test("a property named require is fine (not a bare call)", () => {
    ok(META + `const o = { require: 1 }\nreturn o.require`)
  })
})

describe("parseScript: P14 TypeScript / syntax errors", () => {
  test("type annotation", () => {
    const e = err(META + `const x: number = 1\nreturn x`)
    expect(e).toMatch(/^SyntaxError: /)
    expect(e).toMatch(/\(2:7\)/)
  })

  test("interface", () => {
    expect(err(META + `interface A { x: number }\nreturn 1`)).toMatch(/^SyntaxError: /)
  })

  test("generic function declaration", () => {
    // note: `agent<string>('x')` alone is valid JS (two comparisons), so it cannot be flagged statically
    expect(err(META + `function id<T>(x: T): T { return x }\nreturn 1`)).toMatch(/^SyntaxError: /)
  })

  test("plain syntax error", () => {
    expect(err(META + `const = 1`)).toMatch(/^SyntaxError: .*\(2:6\)/)
  })

  test("syntax error inside meta", () => {
    expect(err(`export const meta = { name: 'a' description: 'b' }`)).toMatch(/^SyntaxError: /)
  })
})

describe("parseScript: warnings", () => {
  const withPhases = `export const meta = { name: 'a', description: 'b', phases: [{ title: 'One' }, { title: 'Two' }] }\n`

  test("phase() title not listed in meta.phases", () => {
    const r = ok(withPhases + `phase('One')\nphase('Two')\nphase('Three')\nreturn 1`)
    expect(r.warnings.length).toBe(1)
    expect(r.warnings[0]).toContain("Three")
  })

  test("meta.phases title never used", () => {
    const r = ok(withPhases + `phase('One')\nreturn 1`)
    expect(r.warnings.length).toBe(1)
    expect(r.warnings[0]).toContain("Two")
  })

  test("agent opts.phase literal counts as usage", () => {
    const r = ok(withPhases + `phase('One')\nawait agent('x', { phase: 'Two' })\nreturn 1`)
    expect(r.warnings).toEqual([])
  })

  test("template literal phase titles without interpolation count", () => {
    const r = ok(withPhases + "phase(`One`)\nphase(`Two`)\nreturn 1")
    expect(r.warnings).toEqual([])
  })

  test("dynamic phase titles: no 'never used' warnings (cannot be proven)", () => {
    const r = ok(withPhases + "for (const p of ['One','Two']) phase(p)\nreturn 1")
    expect(r.warnings).toEqual([])
  })

  test("no meta.phases: phase() titles do not warn", () => {
    const r = ok(META + `phase('Anything')\nreturn 1`)
    expect(r.warnings).toEqual([])
  })

  test("unknown meta keys produce a warning", () => {
    const r = ok(`export const meta = { name: 'a', description: 'b', color: 'red' }\nreturn 1`)
    expect(r.warnings.some((w) => w.includes("color"))).toBe(true)
  })
})

describe("extractMetaLoose", () => {
  test("returns meta for valid script", () => {
    expect(extractMetaLoose(META + "return 1")).toEqual({ name: "demo", description: "A demo workflow" })
  })

  test("returns meta even when body has a syntax error (reported at run time)", () => {
    expect(extractMetaLoose(META + "const x: number = 1")).toEqual({ name: "demo", description: "A demo workflow" })
  })

  test("returns meta despite leading comments", () => {
    expect(extractMetaLoose("// c\n/* d */\n" + META)).toEqual({ name: "demo", description: "A demo workflow" })
  })

  test("returns null for non-literal meta", () => {
    expect(extractMetaLoose(`export const meta = { name: NAME, description: 'b' }`)).toBeNull()
    expect(extractMetaLoose(`export const meta = { ...x, name: 'a', description: 'b' }`)).toBeNull()
  })

  test("returns null for missing name/description", () => {
    expect(extractMetaLoose(`export const meta = { name: 'a' }`)).toBeNull()
  })

  test("returns null when meta is not first", () => {
    expect(extractMetaLoose(`const a = 1\n` + META)).toBeNull()
  })

  test("returns null for garbage without throwing", () => {
    expect(extractMetaLoose("{{{{")).toBeNull()
    expect(extractMetaLoose("")).toBeNull()
    expect(extractMetaLoose(`export const meta = { name: 'a', description: 'b'`)).toBeNull()
  })
})

describe("isPureLiteralMeta", () => {
  function expr(src: string) {
    return acorn.parseExpressionAt(src, 0, { ecmaVersion: "latest" }) as unknown as acorn.Expression
  }
  test("true for pure literals", () => {
    expect(isPureLiteralMeta(expr(`{ a: 1, b: [-1, 'x', \`y\`, null, { c: true }] }`))).toBe(true)
  })
  test("false for non-literals", () => {
    expect(isPureLiteralMeta(expr(`{ a: b }`))).toBe(false)
    expect(isPureLiteralMeta(expr("{ a: `${b}` }"))).toBe(false)
    expect(isPureLiteralMeta(expr(`{ ...b }`))).toBe(false)
  })
})
