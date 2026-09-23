// Structured-output support for `agent(prompt, { schema })` (PARITY P21/P22).
// Host-agnostic: preflight checks, validation, retry budget, prompt instructions, and a fallback
// JSON extractor for agents that answer in prose instead of calling the submit tool.

import Ajv, { type ErrorObject, type ValidateFunction } from "ajv"

type Schema = Record<string, unknown>

const ajv = new Ajv({ strict: false, allErrors: true })
const compiled = new WeakMap<object, ValidateFunction>()

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function compile(schema: Schema): ValidateFunction {
  let fn = compiled.get(schema)
  if (!fn) {
    fn = ajv.compile(schema)
    compiled.set(schema, fn)
  }
  return fn
}

function formatPath(path: string): string {
  return path === "" ? "(root)" : path
}

// ---------------------------------------------------------------------------------------------
// P22 — preflight

function typeIncludes(type: unknown, name: string): boolean {
  if (typeof type === "string") return type === name
  if (Array.isArray(type)) return type.includes(name)
  return false
}

function keyAllowedByPatterns(key: string, patternProperties: unknown): boolean {
  if (!isPlainObject(patternProperties)) return false
  for (const [pattern, sub] of Object.entries(patternProperties)) {
    if (sub === false) continue
    try {
      if (new RegExp(pattern, "u").test(key)) return true
    } catch {
      // Invalid regex: ajv compile will report it.
    }
  }
  return false
}

const RANGE_PAIRS: [string, string][] = [
  ["minimum", "maximum"],
  ["minItems", "maxItems"],
  ["minLength", "maxLength"],
  ["minProperties", "maxProperties"],
  ["minContains", "maxContains"],
]

/** Walk a (sub)schema and return the first provable contradiction, or null. */
function checkNode(node: unknown, path: string): string | null {
  if (!isPlainObject(node)) return null // booleans / garbage: ajv compile handles them
  const at = formatPath(path)

  if (Array.isArray(node.enum) && node.enum.length === 0) {
    return `schema at ${at}: enum is empty, so no value can match`
  }
  for (const [lo, hi] of RANGE_PAIRS) {
    const a = node[lo]
    const b = node[hi]
    if (typeof a === "number" && typeof b === "number" && a > b) {
      return `schema at ${at}: ${lo} (${a}) is greater than ${hi} (${b}), so no value can match`
    }
  }
  if (
    typeof node.exclusiveMinimum === "number" &&
    typeof node.exclusiveMaximum === "number" &&
    node.exclusiveMinimum >= node.exclusiveMaximum
  ) {
    return `schema at ${at}: exclusiveMinimum (${node.exclusiveMinimum}) is not below exclusiveMaximum (${node.exclusiveMaximum}), so no value can match`
  }

  const props = isPlainObject(node.properties) ? node.properties : {}
  if (Array.isArray(node.required)) {
    for (const key of node.required) {
      if (typeof key !== "string") continue
      if (Object.prototype.hasOwnProperty.call(props, key)) {
        if (props[key] === false) {
          return `schema at ${at}: required key "${key}" is ruled out by its property schema (false)`
        }
        continue
      }
      if (node.additionalProperties === false && !keyAllowedByPatterns(key, node.patternProperties)) {
        return `schema at ${at}: required key "${key}" is ruled out by additionalProperties:false (it is not listed in properties)`
      }
    }
    if (typeof node.maxProperties === "number") {
      const uniq = new Set(node.required.filter((k) => typeof k === "string"))
      if (uniq.size > node.maxProperties) {
        return `schema at ${at}: ${uniq.size} required keys exceed maxProperties (${node.maxProperties})`
      }
    }
  }

  // Recurse into every subschema location.
  const join = (seg: string) => `${path}/${seg}`
  for (const [k, sub] of Object.entries(props)) {
    const r = checkNode(sub, join(`properties/${k}`))
    if (r) return r
  }
  for (const kw of ["patternProperties", "$defs", "definitions", "dependentSchemas"]) {
    const map = node[kw]
    if (!isPlainObject(map)) continue
    for (const [k, sub] of Object.entries(map)) {
      const r = checkNode(sub, join(`${kw}/${k}`))
      if (r) return r
    }
  }
  for (const kw of [
    "items",
    "additionalItems",
    "contains",
    "additionalProperties",
    "propertyNames",
    "not",
    "if",
    "then",
    "else",
    "unevaluatedItems",
    "unevaluatedProperties",
  ]) {
    const sub = node[kw]
    if (Array.isArray(sub)) {
      for (let i = 0; i < sub.length; i++) {
        const r = checkNode(sub[i], join(`${kw}/${i}`))
        if (r) return r
      }
    } else {
      const r = checkNode(sub, join(kw))
      if (r) return r
    }
  }
  for (const kw of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
    const list = node[kw]
    if (!Array.isArray(list)) continue
    for (let i = 0; i < list.length; i++) {
      const r = checkNode(list[i], join(`${kw}/${i}`))
      if (r) return r
    }
  }
  return null
}

/**
 * P22: return an error message naming the contradiction when `schema` provably cannot be
 * satisfied by an object output, or null when it is usable.
 */
export function preflightSchema(schema: Schema): string | null {
  if (!isPlainObject(schema)) {
    return "invalid schema: expected a JSON Schema object with root {type:'object'}"
  }
  const hasType = "type" in schema
  if (hasType) {
    if (!typeIncludes(schema.type, "object")) {
      return `invalid schema: root must be {type:'object'} (got type ${JSON.stringify(schema.type)})`
    }
  } else if (!("properties" in schema) && !("required" in schema)) {
    return "invalid schema: root must be {type:'object'} (no type, properties or required given)"
  }

  try {
    compile(schema)
  } catch (e) {
    return `invalid schema: ${e instanceof Error ? e.message : String(e)}`
  }

  return checkNode(schema, "")
}

// ---------------------------------------------------------------------------------------------
// P21 — validation

function formatError(e: ErrorObject): string {
  const where = formatPath(e.instancePath)
  const params = e.params as Record<string, unknown>
  if (e.keyword === "additionalProperties" && typeof params.additionalProperty === "string") {
    return `${where}: unexpected property "${params.additionalProperty}"`
  }
  if (e.keyword === "required" && typeof params.missingProperty === "string") {
    return `${where}: missing required property "${params.missingProperty}"`
  }
  if (e.keyword === "enum" && Array.isArray(params.allowedValues)) {
    return `${where}: must be one of ${JSON.stringify(params.allowedValues)}`
  }
  return `${where}: ${e.message ?? e.keyword}`
}

export type ValidationResult = { ok: true; value: unknown } | { ok: false; error: string }

/** Validate `value` against `schema`; the error is a compact newline-joined list (max 8 lines). */
export function validateOutput(schema: Schema, value: unknown): ValidationResult {
  let fn: ValidateFunction
  try {
    fn = compile(schema)
  } catch (e) {
    return { ok: false, error: `invalid schema: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (fn(value)) return { ok: true, value }
  const lines = [...new Set((fn.errors ?? []).map(formatError))]
  const MAX = 8
  const shown = lines.slice(0, MAX)
  if (lines.length > MAX) shown.push(`...and ${lines.length - MAX} more`)
  return { ok: false, error: shown.length ? shown.join("\n") : "output does not match schema" }
}

// ---------------------------------------------------------------------------------------------
// Retry budget

/** Max structured-output attempts: MAX_STRUCTURED_OUTPUT_RETRIES (or prefixed variant), default 5, min 1. */
export function maxStructuredRetries(): number {
  const raw =
    process.env.MAX_STRUCTURED_OUTPUT_RETRIES ?? process.env.OPENCODE_WORKFLOW_MAX_STRUCTURED_OUTPUT_RETRIES
  if (raw === undefined || raw.trim() === "") return 5
  const n = Number.parseInt(raw.trim(), 10)
  if (!Number.isFinite(n)) return 5
  return Math.max(1, n)
}

// ---------------------------------------------------------------------------------------------
// Prompt instructions

export const SUBMIT_TOOL_NAME = "workflow_submit"

/** Text appended to a child prompt when `opts.schema` is set. */
export function structuredOutputInstructions(schema: Schema): string {
  return [
    "## Required output format",
    "",
    `When your work is done you MUST finish by calling the \`${SUBMIT_TOOL_NAME}\` tool exactly once, ` +
      "with a single argument `output` whose value is a JSON value matching this JSON Schema:",
    "",
    "```json",
    JSON.stringify(schema, null, 2),
    "```",
    "",
    `If \`${SUBMIT_TOOL_NAME}\` reports a validation error, fix the output and call it again. ` +
      `After a successful \`${SUBMIT_TOOL_NAME}\` call, do nothing else: no further tool calls and no further text.`,
  ].join("\n")
}

// ---------------------------------------------------------------------------------------------
// Fallback extraction

function tryParse(s: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(s) }
  } catch {
    return { ok: false }
  }
}

/** Balanced top-level {...} spans in text order, respecting JSON string literals. */
function topLevelObjects(text: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (depth > 0 && inString) {
      if (escaped) escaped = false
      else if (c === "\\") escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"' && depth > 0) inString = true
    else if (c === "{") {
      if (depth === 0) start = i
      depth++
    } else if (c === "}" && depth > 0) {
      depth--
      if (depth === 0) out.push(text.slice(start, i + 1))
    }
  }
  return out
}

/**
 * Best-effort JSON recovery from prose: whole text, then the last parseable fenced block,
 * then the last parseable balanced top-level {...}. Returns undefined when nothing parses.
 */
export function extractJsonFromText(text: string): unknown | undefined {
  if (typeof text !== "string" || text.trim() === "") return undefined
  const whole = tryParse(text.trim())
  if (whole.ok && typeof whole.value === "object" && whole.value !== null) return whole.value

  const fences = [...text.matchAll(/```[ \t]*([A-Za-z0-9_-]*)[^\n]*\n([\s\S]*?)```/g)]
  for (let i = fences.length - 1; i >= 0; i--) {
    const lang = fences[i][1].toLowerCase()
    if (lang && lang !== "json" && lang !== "jsonc" && lang !== "json5") continue
    const r = tryParse(fences[i][2].trim())
    if (r.ok) return r.value
  }

  const objs = topLevelObjects(text)
  for (let i = objs.length - 1; i >= 0; i--) {
    const r = tryParse(objs[i])
    if (r.ok) return r.value
  }
  return undefined
}
