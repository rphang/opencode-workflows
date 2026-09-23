// Runs workflow script bodies inside the @opencode/codemode interpreter.
//
// Program layout produced by buildProgram (line numbers matter — see BODY_LINE_OFFSET):
//
//   <PRELUDE>                       parallel / pipeline / agent / phase / log / workflow / budget
//   const args = <JSON literal>;    single line (JSON.stringify never emits raw newlines)
//   <guard helpers>                 captured natives + guarded Math/Date objects (GUARDS)
//   return await (async () => { const Math = …; const Date = …; <hide natives> … (OPEN, one line)
//   <body>                          user body, Date constructions rewritten in place (same lines)
//   })(); })(); })();               (CLOSE)
//
// Determinism guards (P15). codemode forbids `new` on any non-builtin function (user functions and
// host extension functions alike), so a shadowing `Date` function cannot be constructed. Instead,
// the body is parsed with acorn (same options codemode uses) and every `new Date(...)` whose `Date`
// is the global is rewritten to `__wf_newDate(...)`, and `x instanceof Date` to
// `__wf_isDate(x)`. The rewrite only changes columns, never lines. `Date` itself is shadowed
// by a plain function: `Date()` and `Date.now()` throw; `Date.UTC`/`Date.parse` delegate. `Math` is
// a copy of the native members with `random` throwing. The captured natives are hidden from the body.
// Known gaps: `new Date` via an alias (`const D = Date; new D(0)`) throws codemode's
// "cannot be constructed" error instead of working; `Date.prototype` is not exposed; the guards are
// hygiene, not a security boundary — deliberate evasion such as `new Date(0).constructor.now()`
// still reaches the native clock.
// If the body declares its own binding named `Date`, no rewrite happens (its semantics are kept).
//
// Abort: executeProgram races the codemode Effect (run with Effect.runPromise's `signal`, which
// interrupts the interpreter fiber — busy loops included) against the signal, and wraps every host
// global so that (a) calls made after abort throw immediately without reaching the host and
// (b) pending async host calls reject as soon as the signal fires. The host functions themselves
// are expected to observe the same signal to cancel the underlying work (child sessions).

import { parse, type Node } from "acorn"
import { CodeMode, Extension } from "@opencode/codemode"
import { Effect } from "effect"
import { PRELUDE } from "./prelude.ts"

export type ExecuteResult =
  | { ok: true; value: unknown; logs?: string[] }
  | { ok: false; error: string; kind: string; logs?: string[] }

export interface ExecuteOptions {
  timeoutMs?: number
  signal?: AbortSignal
  /**
   * Lines preceding the user body in `program`, used to remap diagnostics to body-relative
   * numbers. Defaults to BODY_LINE_OFFSET for programs produced by buildProgram, else 0.
   */
  lineOffset?: number
}

const MATH_MEMBERS = [
  "abs", "acos", "acosh", "asin", "asinh", "atan", "atan2", "atanh", "cbrt", "ceil", "clz32", "cos",
  "cosh", "exp", "expm1", "floor", "fround", "hypot", "imul", "log", "log10", "log1p", "log2", "max",
  "min", "pow", "round", "sign", "sin", "sinh", "sqrt", "tan", "tanh", "trunc",
  "E", "LN10", "LN2", "LOG10E", "LOG2E", "PI", "SQRT1_2", "SQRT2",
]

const RANDOM_MSG = "Math.random() is not available in workflow scripts (breaks resume); vary prompts by index instead"
const NOW_MSG = "Date.now() is not available in workflow scripts (breaks resume); pass a timestamp in through args instead"
const NEW_DATE_MSG = "new Date() without arguments is not available in workflow scripts (breaks resume); pass a timestamp in through args instead"
const DATE_CALL_MSG = "Date() is not available in workflow scripts (breaks resume); pass a timestamp in through args instead"

const GUARDS = [
  "const __wf_Math = Math; const __wf_Date = Date;",
  `const __wf_gMath = ({ ${MATH_MEMBERS.map((m) => `${m}: __wf_Math.${m}`).join(", ")}, random: () => { throw new Error(${JSON.stringify(RANDOM_MSG)}) } });`,
  `const __wf_gDate = (() => { const D = (...a) => { throw new Error(${JSON.stringify(DATE_CALL_MSG)}) }; D.now = () => { throw new Error(${JSON.stringify(NOW_MSG)}) }; D.UTC = (...a) => __wf_Date.UTC(...a); D.parse = (s) => __wf_Date.parse(s); return D; })();`,
  `const __wf_newDate = (...a) => { if (a.length === 0) throw new Error(${JSON.stringify(NEW_DATE_MSG)}); return new __wf_Date(...a); };`,
  "const __wf_isDate = (x) => x instanceof __wf_Date;",
].join("\n")

// Three nested scopes (all on one line): the first installs the guarded Math/Date, the second hides
// the captured natives (separate scope to avoid TDZ on the names the first one reads), the third
// holds the body, so a body may declare its own `Date`/`Math` without a redeclaration error.
const OPEN =
  "return await (async () => { const Math = __wf_gMath; const Date = __wf_gDate; " +
  "return await (async () => { const __wf_Math = undefined; const __wf_Date = undefined; const __wf_gMath = undefined; const __wf_gDate = undefined; " +
  "return await (async () => {"
const CLOSE = "\n})(); })(); })();"

const HEADER_BEFORE_ARGS = PRELUDE.endsWith("\n") ? PRELUDE : PRELUDE + "\n"

function countLines(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++
  return n
}

/** Number of program lines before the first body line (body line 1 = program line OFFSET+1). */
export const BODY_LINE_OFFSET = countLines(HEADER_BEFORE_ARGS) + 1 /* args */ + countLines(GUARDS) + 1 + 1 /* open */

const PARSE_ERROR_SENTINEL = "//@wf-parse-error "

const LS = String.fromCharCode(0x2028)
const PS = String.fromCharCode(0x2029)

function argsLiteral(args: unknown): string {
  if (args === undefined) return "undefined"
  const json = JSON.stringify(args)
  if (json === undefined) return "undefined"
  // JSON.stringify never emits raw \n; escape U+2028/2029 for older parsers and keep one line.
  return json.split(LS).join("\\u2028").split(PS).join("\\u2029")
}

export type SyntaxCheck = { ok: true } | { ok: false; error: string; line?: number; column?: number }

type AnyNode = Node & Record<string, any>

function parseBody(body: string): AnyNode {
  return parse(body, {
    ecmaVersion: "latest",
    sourceType: "script",
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    locations: true,
  }) as AnyNode
}

/** Parses a body standalone with the exact options codemode uses. Line numbers are body-relative. */
export function checkBodySyntax(body: string): SyntaxCheck {
  try {
    parseBody(body)
    return { ok: true }
  } catch (e: any) {
    const loc = e?.loc as { line: number; column: number } | undefined
    const msg = String(e?.message ?? e).replace(/\s*\(\d+:\d+\)$/, "")
    return loc
      ? { ok: false, error: `SyntaxError: ${msg} (line ${loc.line}, col ${loc.column + 1})`, line: loc.line, column: loc.column + 1 }
      : { ok: false, error: `SyntaxError: ${msg}` }
  }
}

function walk(node: unknown, visit: (n: AnyNode, parent: AnyNode | undefined) => void, parent?: AnyNode) {
  if (!node || typeof node !== "object") return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit, parent)
    return
  }
  const n = node as AnyNode
  if (typeof n.type !== "string") return
  visit(n, parent)
  for (const key of Object.keys(n)) {
    if (key === "loc" || key === "start" || key === "end" || key === "type") continue
    walk(n[key], visit, n)
  }
}

function patternNames(p: AnyNode | null | undefined, out: Set<string>) {
  if (!p) return
  switch (p.type) {
    case "Identifier": out.add(p.name); break
    case "ObjectPattern": for (const prop of p.properties) patternNames(prop.type === "RestElement" ? prop : prop.value, out); break
    case "ArrayPattern": for (const el of p.elements) patternNames(el, out); break
    case "RestElement": patternNames(p.argument, out); break
    case "AssignmentPattern": patternNames(p.left, out); break
  }
}

function declaresDate(ast: AnyNode): boolean {
  const names = new Set<string>()
  walk(ast, (n) => {
    if (n.type === "VariableDeclarator") patternNames(n.id, names)
    else if (n.type === "FunctionDeclaration" || n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression") {
      if (n.id) patternNames(n.id, names)
      for (const p of n.params) patternNames(p, names)
    } else if (n.type === "CatchClause") patternNames(n.param, names)
    else if (n.type === "ClassDeclaration" && n.id) patternNames(n.id, names)
  })
  return names.has("Date")
}

/** Rewrites `new Date(...)` → `__wf_newDate(...)` and `instanceof Date` → `instanceof __wf_Date`, keeping lines. */
function rewriteDates(body: string, ast: AnyNode): string {
  if (declaresDate(ast)) return body
  const edits: { start: number; end: number; text: string }[] = []
  walk(ast, (n) => {
    if (n.type === "NewExpression" && n.callee.type === "Identifier" && n.callee.name === "Date") {
      const hasParens = body.slice(n.callee.end, n.end).includes("(")
      const original = body.slice(n.start, n.callee.end)
      const newlines = "\n".repeat(countLines(original))
      edits.push({ start: n.start, end: n.callee.end, text: "__wf_newDate" + (hasParens ? "" : "()") + newlines })
    } else if (n.type === "BinaryExpression" && n.operator === "instanceof" && n.right.type === "Identifier" && n.right.name === "Date") {
      edits.push({ start: n.start, end: n.left.start, text: "__wf_isDate(" })
      edits.push({ start: n.left.end, end: n.end, text: ")" + "\n".repeat(countLines(body.slice(n.left.end, n.end))) })
    }
  })
  // Apply right-to-left. At equal starts, apply replacements before pure insertions, and later
  // (inner) insertions before earlier (outer) ones, so prepended text nests correctly.
  const order = edits.map((e, i) => ({ ...e, i }))
  order.sort((a, b) => b.start - a.start || (b.end - b.start > 0 ? 1 : 0) - (a.end - a.start > 0 ? 1 : 0) || b.i - a.i)
  edits.splice(0, edits.length, ...order)
  let out = body
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end)
  return out
}

/**
 * Produces the full interpreter source for a workflow body: prelude + `const args = …` + the body
 * wrapped so top-level await/return work and determinism guards apply. Body line N is program line
 * BODY_LINE_OFFSET + N. A body that does not parse standalone yields a sentinel program that
 * executeProgram reports as a ParseError without running anything (this also prevents a body from
 * closing the wrapper early to escape the guards).
 */
export function buildProgram(body: string, args: unknown): string {
  let ast: AnyNode
  try {
    ast = parseBody(body)
  } catch {
    const check = checkBodySyntax(body)
    return PARSE_ERROR_SENTINEL + JSON.stringify(check.ok ? { error: "SyntaxError" } : check)
  }
  const rewritten = rewriteDates(body, ast)
  return `${HEADER_BEFORE_ARGS}const args = ${argsLiteral(args)};\n${GUARDS}\n${OPEN}\n${rewritten}${CLOSE}`
}

function remapMessage(message: string, offset: number): string {
  if (offset === 0) return message
  // Locations inside the prelude/guards are reported as runtime locations, never as body lines.
  const fmt = (line: number, col: number) =>
    line > offset ? `(line ${line - offset}, col ${col})` : `(workflow runtime line ${line}, col ${col})`
  return message
    .replace(/\(line (\d+), col (\d+)\)/g, (_m, l, c) => fmt(Number(l), Number(c)))
    .replace(/\((\d+):(\d+)\)/g, (_m, l, c) => fmt(Number(l), Number(c) + 1))
}

class AbortedError extends Error {
  constructor() {
    super("Workflow aborted")
    this.name = "AbortError"
  }
}

function wrapGlobals(globals: Record<string, Function>, signal: AbortSignal | undefined): Record<string, Function> {
  if (!signal) return globals
  const aborted = new Promise<never>((_, reject) => {
    if (signal.aborted) reject(new AbortedError())
    else signal.addEventListener("abort", () => reject(new AbortedError()), { once: true })
  })
  aborted.catch(() => {})
  const out: Record<string, Function> = {}
  for (const [name, fn] of Object.entries(globals)) {
    out[name] = (...a: unknown[]) => {
      if (signal.aborted) throw new AbortedError()
      const r = fn(...a)
      if (r && typeof (r as PromiseLike<unknown>).then === "function") return Promise.race([r, aborted])
      return r
    }
  }
  return out
}

/**
 * Executes a program (normally from buildProgram) in codemode with `globals` exposed as host
 * functions. Never throws: failures come back as `{ok:false, kind, error}` where kind is a codemode
 * DiagnosticKind or "Aborted". Diagnostics carry body-relative line numbers.
 */
export async function executeProgram(
  program: string,
  globals: Record<string, Function>,
  opts: ExecuteOptions = {},
): Promise<ExecuteResult> {
  if (program.startsWith(PARSE_ERROR_SENTINEL)) {
    const info = JSON.parse(program.slice(PARSE_ERROR_SENTINEL.length)) as { error: string }
    return { ok: false, kind: "ParseError", error: info.error }
  }
  const { signal, timeoutMs } = opts
  if (signal?.aborted) return { ok: false, kind: "Aborted", error: "Workflow aborted" }
  const offset = opts.lineOffset ?? (program.startsWith(HEADER_BEFORE_ARGS) ? BODY_LINE_OFFSET : 0)

  const runtime = CodeMode.make({
    extensions: [Extension.make({ name: "workflow", globals: wrapGlobals(globals, signal) })],
    limits: timeoutMs !== undefined ? { timeoutMs } : {},
  })

  let onAbort: (() => void) | undefined
  const abortRace = new Promise<ExecuteResult>((resolve) => {
    if (!signal) return
    onAbort = () => resolve({ ok: false, kind: "Aborted", error: "Workflow aborted" })
    signal.addEventListener("abort", onAbort, { once: true })
  })

  const run = (async (): Promise<ExecuteResult> => {
    try {
      const r = await Effect.runPromise(runtime.execute(program), signal ? { signal } : undefined)
      if (r.ok) return r.logs?.length ? { ok: true, value: r.value, logs: [...r.logs] } : { ok: true, value: r.value }
      if (signal?.aborted) return { ok: false, kind: "Aborted", error: "Workflow aborted" }
      const failure: ExecuteResult = { ok: false, kind: r.error.kind, error: remapMessage(r.error.message, offset) }
      if (r.logs?.length) failure.logs = [...r.logs]
      return failure
    } catch (e) {
      if (signal?.aborted) return { ok: false, kind: "Aborted", error: "Workflow aborted" }
      return { ok: false, kind: "ExecutionFailure", error: String((e as Error)?.message ?? e) }
    }
  })()

  try {
    return await Promise.race([run, abortRace])
  } finally {
    if (signal && onAbort) signal.removeEventListener("abort", onAbort)
  }
}
