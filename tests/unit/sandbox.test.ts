import { describe, expect, test } from "bun:test"
import { BODY_LINE_OFFSET, buildProgram, executeProgram, type ExecuteResult } from "../../src/sandbox.ts"
import { PRELUDE } from "../../src/prelude.ts"

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Host globals with sensible defaults; override per test. */
function hostGlobals(over: Record<string, Function> = {}): Record<string, Function> {
  return {
    __agent: async (prompt: string) => `echo:${prompt}`,
    __phase: () => undefined,
    __log: () => undefined,
    __workflow: async () => null,
    __budget_total: () => null,
    __budget_spent: () => 0,
    ...over,
  }
}

async function run(body: string, args?: unknown, globals: Record<string, Function> = {}, opts = {}) {
  return executeProgram(buildProgram(body, args), hostGlobals(globals), opts)
}

function ok(r: ExecuteResult): unknown {
  if (!r.ok) throw new Error(`expected ok, got ${r.kind}: ${r.error}`)
  return r.value
}

function err(r: ExecuteResult): { error: string; kind: string } {
  if (r.ok) throw new Error(`expected failure, got value ${JSON.stringify(r.value)}`)
  return r
}

describe("buildProgram / top-level semantics (P12)", () => {
  test("top-level return value is the result", async () => {
    expect(ok(await run("return 1 + 2"))).toBe(3)
  })
  test("top-level await works", async () => {
    expect(ok(await run("const x = await Promise.resolve(41)\nreturn x + 1"))).toBe(42)
  })
  test("no return → null", async () => {
    expect(ok(await run("const x = 1"))).toBeNull()
  })
  test("prelude is exported and part of the program", () => {
    expect(buildProgram("return 1", undefined).startsWith(PRELUDE)).toBe(true)
  })
  test("program places the body at BODY_LINE_OFFSET + 1", () => {
    const lines = buildProgram("return 'MARK'", undefined).split("\n")
    expect(lines[BODY_LINE_OFFSET]).toBe("return 'MARK'")
  })
})

describe("args injection (P05)", () => {
  test("undefined when omitted", async () => {
    expect(ok(await run("return typeof args"))).toBe("undefined")
  })
  test("arrays are real arrays", async () => {
    expect(ok(await run("return [Array.isArray(args), args.length, args[1]]", [1, "b", 3]))).toEqual([true, 3, "b"])
  })
  test("objects are real objects", async () => {
    expect(ok(await run("return args.a.b[0]", { a: { b: [7] } }))).toBe(7)
  })
  test("strings with quotes, backslashes, newlines, script-closing sequences", async () => {
    const s = `he said "hi" and 'bye' \\ \n next line ${String.fromCharCode(0x2028, 0x2029)} </script> \${x} \``
    expect(ok(await run("return args", s))).toBe(s)
  })
  test("null, numbers, booleans", async () => {
    expect(ok(await run("return args", null))).toBeNull()
    expect(ok(await run("return args", 3.5))).toBe(3.5)
    expect(ok(await run("return args", false))).toBe(false)
  })
  test("multi-line args do not shift body lines", async () => {
    const r = err(await run("null.x", { a: "l1\nl2\nl3" }))
    expect(r.error).toContain("line 1")
  })
})

describe("determinism guards (P15)", () => {
  test("Math.random() throws with guidance", async () => {
    const r = err(await run("return Math.random()"))
    expect(r.error).toContain("Math.random() is not available")
  })
  test("other Math members still work", async () => {
    expect(ok(await run("return [Math.max(1, 5), Math.floor(2.7), Math.PI > 3, Math.abs(-2), Math.min(3, 1)]"))).toEqual([5, 2, true, 2, 1])
  })
  test("Date.now() throws", async () => {
    const r = err(await run("return Date.now()"))
    expect(r.error).toContain("Date.now() is not available")
  })
  test("no-arg new Date() throws", async () => {
    const r = err(await run("return new Date().toISOString()"))
    expect(r.error).toContain("new Date() without arguments is not available")
  })
  test("new Date without parentheses throws", async () => {
    const r = err(await run("const d = new Date\nreturn 1"))
    expect(r.error).toContain("new Date() without arguments is not available")
  })
  test("Date() called as a function throws", async () => {
    const r = err(await run("return Date()"))
    expect(r.error).toContain("not available")
  })
  test("new Date(x) with an argument keeps working", async () => {
    expect(ok(await run("return new Date(0).toISOString()"))).toBe("1970-01-01T00:00:00.000Z")
    expect(ok(await run("return new Date('2020-01-02T00:00:00Z').getTime()"))).toBe(1577923200000)
    expect(ok(await run("return new Date(2020, 0, 1).getFullYear()"))).toBe(2020)
  })
  test("new Date(x) nested inside arguments works", async () => {
    expect(ok(await run("return new Date(new Date(5).getTime() + 1).getTime()"))).toBe(6)
  })
  test("Date.UTC / Date.parse still work", async () => {
    expect(ok(await run("return [Date.UTC(2020, 0, 1), Date.parse('1970-01-01T00:00:01Z')]"))).toEqual([1577836800000, 1000])
  })
  test("instanceof Date works on constructed dates", async () => {
    expect(ok(await run("return new Date(0) instanceof Date"))).toBe(true)
  })
  test("new Date() inside a string is not rewritten", async () => {
    expect(ok(await run("return 'new Date()'"))).toBe("new Date()")
  })
  test("guards apply inside nested functions and thunks", async () => {
    const r = await run("const r = await parallel([() => Math.random(), async () => Date.now(), () => 1])\nreturn r")
    expect(ok(r)).toEqual([null, null, 1])
  })
  test("instanceof rewrite nests and handles parentheses", async () => {
    expect(ok(await run("const d = new Date(0)\nreturn [(d) instanceof Date, ({}) instanceof Date, (new Date(1) instanceof Date) === true, 'x' instanceof Date]"))).toEqual([true, false, true, false])
  })
  test("captured natives are hidden from the body", async () => {
    expect(ok(await run("return [typeof __wf_Math, typeof __wf_Date, typeof __wf_gMath, typeof __wf_gDate]"))).toEqual(["undefined", "undefined", "undefined", "undefined"])
  })
  test("body may declare its own Date/Math bindings", async () => {
    expect(ok(await run("const Date = { now: () => 5 }\nconst Math = { random: () => 0.5 }\nreturn [Date.now(), Math.random()]"))).toEqual([5, 0.5])
  })
  test("body cannot close the wrapper early to escape the guards", async () => {
    const r = err(await run("})(); })(); return Math.random(); (async () => { (async () => {"))
    expect(r.kind).toBe("ParseError")
  })
  test("line numbers stay correct after the Date rewrite", async () => {
    const r = err(await run("const d = new Date(0)\nconst e = new Date(1)\nnull.x"))
    expect(r.error).toContain("line 3")
  })
})

describe("sandbox isolation (P16)", () => {
  for (const name of ["require", "process", "globalThis", "fetch", "Bun", "setTimeout", "eval", "import", "window", "Deno"]) {
    if (name === "import") continue
    test(`${name} is not reachable`, async () => {
      expect(ok(await run(`return typeof ${name}`))).toBe("undefined")
    })
  }
  test("Function constructor escape does not reach host", async () => {
    const r = await run("try { return typeof (() => 1).constructor('return process')() } catch (e) { return 'blocked' }")
    expect(r.ok ? r.value : "blocked").not.toBe("object")
  })
})

describe("parallel (P29, P31)", () => {
  test("runs thunks concurrently", async () => {
    const t0 = performance.now()
    const r = ok(await run("return await parallel([1,2,3,4].map(i => () => slow(100, i)))", undefined, {
      slow: async (ms: number, v: number) => { await sleep(ms); return v },
    }))
    const dt = performance.now() - t0
    expect(r).toEqual([1, 2, 3, 4])
    expect(dt).toBeLessThan(300)
  })
  test("is a barrier: waits for every thunk", async () => {
    const done: number[] = []
    ok(await run("await parallel([() => slow(10, 1), () => slow(120, 2)])\nmark()", undefined, {
      slow: async (ms: number, v: number) => { await sleep(ms); done.push(v); return v },
      mark: () => { done.push(99) },
    }))
    expect(done).toEqual([1, 2, 99])
  })
  test("throwing thunks (sync and async) resolve to null and never reject", async () => {
    const body = `return await parallel([
      () => { throw new Error('sync') },
      async () => { throw new Error('async') },
      () => fails(),
      () => 'ok',
    ])`
    expect(ok(await run(body, undefined, { fails: async () => { throw new Error("host") } }))).toEqual([null, null, null, "ok"])
  })
  test("non-function entries are values (promises awaited)", async () => {
    expect(ok(await run("return await parallel([1, 'x', null, Promise.resolve(5), () => 2])"))).toEqual([1, "x", null, 5, 2])
  })
  test("rejected promise entries resolve to null", async () => {
    expect(ok(await run("return await parallel([Promise.reject(new Error('x')), 1])"))).toEqual([null, 1])
  })
  test("empty list → []", async () => {
    expect(ok(await run("return await parallel([])"))).toEqual([])
  })
  test("4096 items is fine, 4097 throws explicitly (P31)", async () => {
    expect(ok(await run("const r = await parallel(Array.from({length: 4096}, (_, i) => i))\nreturn r.length"))).toBe(4096)
    const r = err(await run("return await parallel(Array.from({length: 4097}, (_, i) => () => i))"))
    expect(r.error).toContain("4096")
  })
  test("non-array input throws", async () => {
    const r = err(await run("return await parallel('abc')"))
    expect(r.error).toContain("parallel() expects an array")
  })
  test("error is catchable by the script", async () => {
    expect(ok(await run("try { await parallel(null) } catch (e) { return 'caught' }"))).toBe("caught")
  })
})

describe("pipeline (P30, P31)", () => {
  test("stage receives (prev, item, index); results in item order", async () => {
    const body = `return await pipeline(['a','b','c'],
      (prev, item, i) => prev + ':' + item + ':' + i,
      (prev, item, i) => prev + '|' + i)`
    expect(ok(await run(body))).toEqual(["a:a:0|0", "b:b:1|1", "c:c:2|2"])
  })
  test("no barrier between stages: fast item reaches stage 2 before slow item finishes stage 1", async () => {
    const events: string[] = []
    const body = `return await pipeline(['A', 'B'],
      (item) => step('s1', item, item === 'A' ? 10 : 200),
      (prev, item) => step('s2', item, 10))`
    const r = ok(await run(body, undefined, {
      step: async (stage: string, item: string, ms: number) => {
        events.push(`${stage}:${item}:start`)
        await sleep(ms)
        events.push(`${stage}:${item}:end`)
        return `${stage}${item}`
      },
    }))
    expect(r).toEqual(["s2A", "s2B"])
    expect(events.indexOf("s2:A:end")).toBeLessThan(events.indexOf("s1:B:end"))
  })
  test("items run concurrently", async () => {
    const t0 = performance.now()
    ok(await run("return await pipeline([1,2,3,4], i => slow(100, i))", undefined, {
      slow: async (ms: number, v: number) => { await sleep(ms); return v },
    }))
    expect(performance.now() - t0).toBeLessThan(300)
  })
  test("throwing stage drops the item to null and skips remaining stages", async () => {
    const calls: string[] = []
    const body = `return await pipeline([1, 2, 3],
      (x) => { if (x === 2) throw new Error('bad'); return x * 10 },
      (x, item) => { rec('s2:' + item); return x + 1 })`
    const r = ok(await run(body, undefined, { rec: (s: string) => { calls.push(s) } }))
    expect(r).toEqual([11, null, 31])
    expect(calls.sort()).toEqual(["s2:1", "s2:3"])
  })
  test("async host failure in a stage → null", async () => {
    expect(ok(await run("return await pipeline([1], x => fails())", undefined, { fails: async () => { throw new Error("x") } }))).toEqual([null])
  })
  test("no stages → items returned as-is", async () => {
    expect(ok(await run("return await pipeline([1, 2])"))).toEqual([1, 2])
  })
  test("4097 items throws explicitly (P31)", async () => {
    const r = err(await run("return await pipeline(Array.from({length: 4097}, (_, i) => i), x => x)"))
    expect(r.error).toContain("4096")
  })
  test("non-array input and non-function stages throw", async () => {
    expect(err(await run("return await pipeline({}, x => x)")).error).toContain("pipeline() expects an array")
    expect(err(await run("return await pipeline([1], 5)")).error).toContain("stage")
  })
})

describe("host bridges: agent, phase, log, workflow, budget", () => {
  test("agent(prompt, opts) forwards to __agent with opts defaulting to {}", async () => {
    const seen: unknown[] = []
    const r = ok(await run("const a = await agent('p1')\nconst b = await agent('p2', {label: 'L', schema: {type: 'object'}})\nreturn [a, b]", undefined, {
      __agent: async (p: string, o: unknown) => { seen.push([p, o]); return p.toUpperCase() },
    }))
    expect(r).toEqual(["P1", "P2"])
    expect(seen).toEqual([["p1", {}], ["p2", { label: "L", schema: { type: "object" } }]])
  })
  test("agent() host errors are catchable", async () => {
    const r = ok(await run("try { await agent('x') } catch (e) { return String(e.message) }", undefined, {
      __agent: async () => { throw new Error("schema failed after 5 attempts") },
    }))
    expect(r).toContain("schema failed")
  })
  test("phase() and log() forward; non-string log args are JSON-stringified", async () => {
    const out: string[] = []
    ok(await run("phase('Scan')\nlog('hello')\nlog({a: 1})\nlog(3)\nlog('a', [1])", undefined, {
      __phase: (t: string) => { out.push(`phase:${t}`) },
      __log: (m: string) => { out.push(`log:${m}`) },
    }))
    expect(out).toEqual(["phase:Scan", "log:hello", 'log:{"a":1}', "log:3", "log:a [1]"])
  })
  test("workflow(nameOrRef, args) forwards to __workflow", async () => {
    const seen: unknown[] = []
    const r = ok(await run("return await workflow('child', {q: 1})", undefined, {
      __workflow: async (n: unknown, a: unknown) => { seen.push([n, a]); return "child-result" },
    }))
    expect(r).toBe("child-result")
    expect(seen).toEqual([["child", { q: 1 }]])
  })
  test("budget without a target: total null, remaining Infinity (P34)", async () => {
    expect(ok(await run("return [budget.total, budget.spent(), budget.remaining() === Infinity]"))).toEqual([null, 0, true])
  })
  test("budget with a target tracks host spend (P34)", async () => {
    let spent = 100
    const g = { __budget_total: () => 1000, __budget_spent: () => spent }
    expect(ok(await run("const a = budget.remaining()\nawait bump()\nreturn [budget.total, budget.spent(), a, budget.remaining()]", undefined, {
      ...g, bump: async () => { spent = 1500 },
    }))).toEqual([1000, 1500, 900, 0])
  })
})

describe("errors and diagnostics", () => {
  test("syntax errors are reported with body-relative line numbers", async () => {
    const r = err(await run("const a = 1\nconst b = ;\n"))
    expect(r.kind).toBe("ParseError")
    expect(r.error).toMatch(/line 2\b|\(2:\d+\)/)
  })
  test("runtime errors are reported with body-relative line numbers", async () => {
    const r = err(await run("\nconst x = 1\nnull.y"))
    expect(r.kind).toBe("ExecutionFailure")
    expect(r.error).toContain("line 3")
  })
  test("uncaught script error surfaces message", async () => {
    const r = err(await run("throw new Error('boom')"))
    expect(r.error).toContain("boom")
  })
  test("console.log output is returned as logs", async () => {
    const r = await run("console.log('dbg')\nreturn 1")
    expect(r.ok && r.logs).toEqual(["dbg"])
  })
})

describe("timeout and abort", () => {
  test("timeoutMs stops a busy loop", async () => {
    const r = err(await run("while (true) {}", undefined, {}, { timeoutMs: 150 }))
    expect(r.kind).toBe("TimeoutExceeded")
  })
  test("abort signal stops execution promptly while a host call is pending", async () => {
    const ac = new AbortController()
    const t0 = performance.now()
    setTimeout(() => ac.abort(), 100)
    const r = err(await run("await agent('x')\nreturn 1", undefined, {
      __agent: () => new Promise(() => {}),
    }, { signal: ac.signal }))
    expect(r.kind).toBe("Aborted")
    expect(performance.now() - t0).toBeLessThan(500)
  })
  test("abort stops a busy loop", async () => {
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 100)
    const r = err(await run("while (true) {}", undefined, {}, { signal: ac.signal }))
    expect(r.kind).toBe("Aborted")
  })
  test("already-aborted signal never runs host calls", async () => {
    const ac = new AbortController()
    ac.abort()
    let called = false
    const r = err(await run("await agent('x')", undefined, { __agent: async () => { called = true } }, { signal: ac.signal }))
    expect(r.kind).toBe("Aborted")
    expect(called).toBe(false)
  })
  test("host calls issued after abort reject (script cannot keep spawning)", async () => {
    const ac = new AbortController()
    let calls = 0
    const r = err(await run("await parallel([() => agent('a'), () => agent('b')])\nreturn 1", undefined, {
      __agent: () => { calls++; ac.abort(); return new Promise(() => {}) },
    }, { signal: ac.signal }))
    expect(r.kind).toBe("Aborted")
    expect(calls).toBeLessThanOrEqual(2)
  })
})
