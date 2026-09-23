// Static checks for workflow scripts (PARITY P10–P14):
//  - `export const meta = <pure object literal>` must be the first statement (P10/P11)
//  - body is plain JS with top-level await/return (P12)
//  - no import / import() / import.meta / require() / other exports (P13)
//  - TypeScript or other syntax errors are reported with line:col (P14)
// Columns in messages are 0-based, matching acorn's own error messages.

import * as acorn from "acorn"
import type { Json, MetaPhase, ParsedScript, WorkflowMeta } from "./types.ts"

const PARSE_OPTIONS: acorn.Options = {
  ecmaVersion: "latest",
  sourceType: "module",
  allowAwaitOutsideFunction: true,
  allowReturnOutsideFunction: true,
  allowHashBang: true,
  locations: true,
}

const KNOWN_META_KEYS = new Set(["name", "description", "whenToUse", "phases"])
const KNOWN_PHASE_KEYS = new Set(["title", "detail", "model"])

type AnyNode = acorn.Node & Record<string, any>

type Eval = { ok: true; value: Json } | { ok: false; error: string }
type MetaResult = { ok: true; meta: WorkflowMeta; warnings: string[] } | { ok: false; error: string }

function at(node: acorn.Node): string {
  const loc = node.loc
  return loc ? ` (${loc.start.line}:${loc.start.column})` : ""
}

function notAllowed(what: string, node: acorn.Node): { ok: false; error: string } {
  return { ok: false, error: `meta must be a pure literal: ${what} is not allowed${at(node)}` }
}

function staticString(node: AnyNode | null | undefined): string | undefined {
  if (!node) return undefined
  if (node.type === "Literal" && typeof node.value === "string") return node.value
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0]?.value.cooked ?? undefined
  return undefined
}

function setProp(obj: Record<string, Json>, key: string, value: Json) {
  // defineProperty so a literal "__proto__" key can't rewrite the prototype.
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true })
}

/** Statically evaluate a pure-literal expression; anything else is an error naming the construct. */
function evaluate(node: AnyNode): Eval {
  switch (node.type) {
    case "Literal": {
      if (node.regex) return notAllowed("a regex literal", node)
      if (node.bigint !== undefined) return notAllowed("a BigInt literal", node)
      return { ok: true, value: node.value as Json }
    }
    case "TemplateLiteral": {
      if (node.expressions.length > 0) return notAllowed("template literal interpolation (${...})", node.expressions[0])
      return { ok: true, value: node.quasis[0]?.value.cooked ?? "" }
    }
    case "UnaryExpression": {
      if (node.operator === "-" && node.argument.type === "Literal" && typeof node.argument.value === "number") {
        return { ok: true, value: -node.argument.value }
      }
      return notAllowed(`UnaryExpression '${node.operator}'`, node)
    }
    case "ArrayExpression": {
      const out: Json[] = []
      for (const el of node.elements as (AnyNode | null)[]) {
        if (el === null) return notAllowed("an array hole", node)
        if (el.type === "SpreadElement") return notAllowed("SpreadElement (...)", el)
        const r = evaluate(el)
        if (!r.ok) return r
        out.push(r.value)
      }
      return { ok: true, value: out }
    }
    case "ObjectExpression": {
      const out: Record<string, Json> = {}
      for (const p of node.properties as AnyNode[]) {
        if (p.type === "SpreadElement") return notAllowed("SpreadElement (...)", p)
        if (p.computed) return notAllowed("a computed key ([...])", p.key)
        if (p.kind !== "init") return notAllowed(`a ${p.kind === "get" ? "getter" : "setter"} accessor`, p)
        if (p.method) return notAllowed("a method (FunctionExpression)", p)
        if (p.shorthand) return notAllowed(`shorthand property '${p.key.name}' (Identifier)`, p)
        let key: string
        if (p.key.type === "Identifier") key = p.key.name
        else if (p.key.type === "Literal" && (typeof p.key.value === "string" || typeof p.key.value === "number")) key = String(p.key.value)
        else return notAllowed(`key ${p.key.type}`, p.key)
        const r = evaluate(p.value)
        if (!r.ok) return r
        setProp(out, key, r.value)
      }
      return { ok: true, value: out }
    }
    case "Identifier":
      return notAllowed(`Identifier '${node.name}'`, node)
    default:
      return notAllowed(node.type, node)
  }
}

/** True when `node` is made only of literals, object/array literals, plain templates and negative numbers. */
export function isPureLiteralMeta(node: acorn.Node): boolean {
  return evaluate(node as AnyNode).ok
}

function isPlainObject(v: Json): v is { [key: string]: Json } {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/** Validate an evaluated meta value into a WorkflowMeta. */
function validateMeta(value: Json): MetaResult {
  const warnings: string[] = []
  if (!isPlainObject(value)) return { ok: false, error: "meta must be an object literal" }
  const { name, description, whenToUse, phases } = value
  if (typeof name !== "string" || name.trim() === "") return { ok: false, error: "meta.name is required and must be a non-empty string" }
  if (typeof description !== "string") return { ok: false, error: "meta.description is required and must be a string" }
  if (whenToUse !== undefined && typeof whenToUse !== "string") return { ok: false, error: "meta.whenToUse must be a string" }
  for (const k of Object.keys(value)) if (!KNOWN_META_KEYS.has(k)) warnings.push(`meta: unknown key '${k}' is ignored`)

  const meta: WorkflowMeta = { name, description }
  if (whenToUse !== undefined) meta.whenToUse = whenToUse
  if (phases !== undefined) {
    if (!Array.isArray(phases)) return { ok: false, error: "meta.phases must be an array of { title, detail?, model? }" }
    const out: MetaPhase[] = []
    const seen = new Set<string>()
    for (let i = 0; i < phases.length; i++) {
      const p = phases[i]!
      const where = `meta.phases[${i}]`
      if (!isPlainObject(p)) return { ok: false, error: `${where} must be an object { title, detail?, model? }` }
      if (typeof p.title !== "string" || p.title === "") return { ok: false, error: `${where}.title is required and must be a non-empty string` }
      if (p.detail !== undefined && typeof p.detail !== "string") return { ok: false, error: `${where}.detail must be a string` }
      if (p.model !== undefined && typeof p.model !== "string") return { ok: false, error: `${where}.model must be a string` }
      if (seen.has(p.title)) return { ok: false, error: `${where}: duplicate phase title '${p.title}'` }
      seen.add(p.title)
      for (const k of Object.keys(p)) if (!KNOWN_PHASE_KEYS.has(k)) warnings.push(`${where}: unknown key '${k}' is ignored`)
      const phase: MetaPhase = { title: p.title }
      if (p.detail !== undefined) phase.detail = p.detail
      if (p.model !== undefined) phase.model = p.model
      out.push(phase)
    }
    meta.phases = out
  }
  return { ok: true, meta, warnings }
}

function metaFromExpression(node: AnyNode): MetaResult {
  if (node.type !== "ObjectExpression") {
    return { ok: false, error: `meta must be an object literal, got ${node.type}${at(node)}` }
  }
  const r = evaluate(node)
  if (!r.ok) return r
  return validateMeta(r.value)
}

const MISSING_META = "script must start with `export const meta = { name, description, ... }` as its first statement"

/** Check the first statement is `export const meta = <expr>` and return that expr node. */
function metaInit(first: AnyNode | undefined): { ok: true; init: AnyNode } | { ok: false; error: string } {
  if (!first) return { ok: false, error: MISSING_META }
  const decl = first.type === "ExportNamedDeclaration" ? first.declaration : null
  const isMetaDecl = (d: AnyNode | null) =>
    d && d.type === "VariableDeclaration" && d.declarations.some((x: AnyNode) => x.id.type === "Identifier" && x.id.name === "meta")
  if (!decl || decl.type !== "VariableDeclaration" || decl.kind !== "const" || !isMetaDecl(decl)) {
    if (isMetaDecl(decl)) return { ok: false, error: `${MISSING_META} (meta must be declared with const)${at(first)}` }
    return { ok: false, error: `${MISSING_META}${at(first)}` }
  }
  if (decl.declarations.length !== 1) return { ok: false, error: `export const meta must be a single declaration${at(first)}` }
  const d = decl.declarations[0]
  if (d.id.type !== "Identifier" || d.id.name !== "meta" || !d.init) return { ok: false, error: `${MISSING_META}${at(first)}` }
  return { ok: true, init: d.init }
}

function walk(node: unknown, visit: (n: AnyNode) => void) {
  if (Array.isArray(node)) {
    for (const x of node) walk(x, visit)
    return
  }
  if (!node || typeof node !== "object" || typeof (node as AnyNode).type !== "string") return
  visit(node as AnyNode)
  for (const key of Object.keys(node)) {
    if (key === "loc") continue
    const v = (node as Record<string, unknown>)[key]
    if (v && typeof v === "object") walk(v, visit)
  }
}

function forbidden(program: AnyNode, metaStatement: AnyNode | undefined): string | undefined {
  let error: string | undefined
  walk(program, (n) => {
    if (error) return
    switch (n.type) {
      case "ImportDeclaration":
        error = `import declarations are not allowed in workflow scripts${at(n)}`
        break
      case "ImportExpression":
        error = `dynamic import() is not allowed in workflow scripts${at(n)}`
        break
      case "MetaProperty":
        if (n.meta?.name === "import") error = `import.meta is not allowed in workflow scripts${at(n)}`
        break
      case "CallExpression":
      case "NewExpression":
        if (n.callee.type === "Identifier" && n.callee.name === "require") {
          error = `require() is not allowed in workflow scripts${at(n.callee)}`
        }
        break
      case "ExportNamedDeclaration":
      case "ExportDefaultDeclaration":
      case "ExportAllDeclaration":
        if (n !== metaStatement) error = `export statements other than \`export const meta\` are not allowed${at(n)}`
        break
    }
  })
  return error
}

function phaseWarnings(program: AnyNode, meta: WorkflowMeta): string[] {
  if (!meta.phases) return []
  const declared = new Set(meta.phases.map((p) => p.title))
  const used = new Set<string>()
  const undeclared: string[] = []
  let dynamic = false
  const use = (arg: AnyNode | undefined) => {
    const s = staticString(arg)
    if (s === undefined) {
      dynamic = true
      return
    }
    used.add(s)
    if (!declared.has(s) && !undeclared.includes(s)) undeclared.push(s)
  }
  walk(program, (n) => {
    if (n.type !== "CallExpression" || n.callee.type !== "Identifier") return
    if (n.callee.name === "phase") use(n.arguments[0])
    else if (n.callee.name === "agent") {
      const opts = n.arguments[1]
      if (!opts) return
      if (opts.type !== "ObjectExpression") {
        dynamic = true
        return
      }
      for (const p of opts.properties as AnyNode[]) {
        if (p.type === "SpreadElement") dynamic = true
        else if (p.computed) dynamic = true
        else if ((p.key.type === "Identifier" && p.key.name === "phase") || (p.key.type === "Literal" && p.key.value === "phase")) use(p.value)
      }
    }
  })
  const warnings = undeclared.map((t) => `phase('${t}') is not listed in meta.phases; it gets a progress group of its own`)
  if (!dynamic) {
    for (const t of declared) {
      if (used.has(t)) continue
      warnings.push(
        `meta.phases entry '${t}' is never used by phase() or agent({ phase }); meta.phases only labels groups, so call ` +
          `phase('${t}') before that stage's agents or they are shown under (no phase)`,
      )
    }
  }
  return warnings
}

/** Replace [start, end) with spaces, keeping line breaks so line/column numbers stay meaningful. */
function blank(source: string, start: number, end: number): string {
  return source.slice(0, start) + source.slice(start, end).replace(/[^\r\n]/g, " ") + source.slice(end)
}

/** Parse and statically check a workflow script. Never throws. */
export function parseScript(source: string): ParsedScript {
  let program: AnyNode
  try {
    program = acorn.parse(source, PARSE_OPTIONS) as AnyNode
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: `SyntaxError: ${msg}` }
  }

  const statements = program.body as AnyNode[]
  const first: AnyNode | undefined = statements[0]
  // A misplaced `export const meta` is reported as such, not as a stray export.
  const later = statements.slice(1).find((s) => metaInit(s).ok)
  const bad = forbidden(program, first?.type === "ExportNamedDeclaration" ? first : later)
  if (bad) return { ok: false, error: bad }

  const m = metaInit(first)
  if (!m.ok) {
    if (later) return { ok: false, error: `export const meta must be the first statement${at(later)}` }
    return m
  }
  const r = metaFromExpression(m.init)
  if (!r.ok) return r

  let body = blank(source, first!.start, first!.end)
  if (body.startsWith("#!")) {
    const nl = body.search(/[\r\n]/)
    body = blank(body, 0, nl === -1 ? body.length : nl)
  }
  return { ok: true, meta: r.meta, body, warnings: [...r.warnings, ...phaseWarnings(program, r.meta)] }
}

/**
 * Lenient meta extraction for saved-workflow discovery: returns the meta when the first statement
 * is a valid pure-literal `export const meta`, even if the rest of the body has a syntax error
 * (that is reported when the workflow runs). Returns null otherwise. Never throws.
 */
export function extractMetaLoose(source: string): WorkflowMeta | null {
  try {
    const full = parseScript(source)
    if (full.ok) return full.meta

    const tokens = acorn.tokenizer(source, PARSE_OPTIONS)
    const next = () => tokens.getToken()
    const t1 = next()
    const t2 = next()
    const t3 = next()
    const t4 = next()
    if (t1.type.label !== "export" || t2.type.label !== "const" || t3.type.label !== "name" || (t3 as { value?: unknown }).value !== "meta" || t4.type.label !== "=") return null
    const expr = acorn.parseExpressionAt(source, t4.end, { ...PARSE_OPTIONS }) as AnyNode
    // The declaration must end there (a `,` would mean multiple declarators).
    const after = acorn.tokenizer(source.slice(expr.end), { ecmaVersion: "latest" }).getToken()
    if (after.type.label === ",") return null
    const r = metaFromExpression(expr)
    return r.ok ? r.meta : null
  } catch {
    return null
  }
}
