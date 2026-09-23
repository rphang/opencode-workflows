import { afterEach, describe, expect, test } from "bun:test"
import {
  extractJsonFromText,
  maxStructuredRetries,
  preflightSchema,
  structuredOutputInstructions,
  validateOutput,
} from "../../src/schema.ts"

describe("preflightSchema (P22)", () => {
  test("accepts a plain object schema", () => {
    expect(
      preflightSchema({
        type: "object",
        required: ["files"],
        properties: { files: { type: "array", items: { type: "string" } } },
      }),
    ).toBeNull()
  })

  test("accepts untyped root with properties/required", () => {
    expect(preflightSchema({ properties: { a: { type: "string" } }, required: ["a"] })).toBeNull()
  })

  test("accepts required key not in properties when additionalProperties allowed", () => {
    expect(preflightSchema({ type: "object", required: ["x"], properties: {} })).toBeNull()
  })

  test("rejects non-object input", () => {
    expect(preflightSchema(null as any)).toMatch(/schema/i)
    expect(preflightSchema([] as any)).toMatch(/schema/i)
    expect(preflightSchema("x" as any)).toMatch(/schema/i)
  })

  test("rejects root that is not an object type", () => {
    expect(preflightSchema({ type: "string" })).toMatch(/root.*object/i)
    expect(preflightSchema({ type: "array", items: {} })).toMatch(/root.*object/i)
  })

  test("rejects root with no type and no properties/required", () => {
    expect(preflightSchema({})).toMatch(/root.*object/i)
  })

  test("rejects required key ruled out by additionalProperties:false", () => {
    const err = preflightSchema({
      type: "object",
      additionalProperties: false,
      required: ["x"],
      properties: { y: { type: "string" } },
    })
    expect(err).toContain('required key "x" is ruled out by additionalProperties:false')
  })

  test("required key allowed by patternProperties is not contradictory", () => {
    expect(
      preflightSchema({ type: "object", additionalProperties: false, required: ["x1"], patternProperties: { "^x": {} } }),
    ).toBeNull()
  })

  test("rejects required key whose property schema is false", () => {
    expect(preflightSchema({ type: "object", required: ["a"], properties: { a: false } })).toContain('"a"')
  })

  test("rejects ajv compile failure", () => {
    const err = preflightSchema({ type: "object", properties: { a: { type: "notatype" } } })
    expect(err).toMatch(/invalid schema/i)
  })

  test("rejects empty enum", () => {
    expect(preflightSchema({ type: "object", properties: { a: { enum: [] } } })).toMatch(/enum/i)
  })

  test("rejects minimum > maximum", () => {
    expect(
      preflightSchema({ type: "object", properties: { n: { type: "number", minimum: 5, maximum: 1 } } }),
    ).toMatch(/minimum.*maximum/i)
  })

  test("rejects minItems > maxItems", () => {
    expect(
      preflightSchema({ type: "object", properties: { l: { type: "array", minItems: 3, maxItems: 1 } } }),
    ).toMatch(/minItems.*maxItems/i)
  })

  test("rejects minLength > maxLength and minProperties > maxProperties", () => {
    expect(
      preflightSchema({ type: "object", properties: { s: { type: "string", minLength: 3, maxLength: 1 } } }),
    ).toMatch(/minLength/)
    expect(preflightSchema({ type: "object", minProperties: 3, maxProperties: 1 })).toMatch(/minProperties/)
  })

  test("recurses into nested objects and array items, naming the path", () => {
    const err = preflightSchema({
      type: "object",
      properties: {
        outer: {
          type: "object",
          additionalProperties: false,
          required: ["missing"],
          properties: { other: { type: "string" } },
        },
      },
    })
    expect(err).toContain('required key "missing" is ruled out by additionalProperties:false')
    expect(err).toContain("outer")

    const err2 = preflightSchema({
      type: "object",
      properties: {
        list: {
          type: "array",
          items: { type: "object", additionalProperties: false, required: ["z"], properties: {} },
        },
      },
    })
    expect(err2).toContain('required key "z"')
  })

  test("recurses into anyOf branches and $defs", () => {
    expect(
      preflightSchema({ type: "object", properties: { a: { anyOf: [{ type: "number", minimum: 2, maximum: 1 }] } } }),
    ).toMatch(/minimum/)
    expect(
      preflightSchema({ type: "object", $defs: { d: { type: "array", minItems: 2, maxItems: 0 } } }),
    ).toMatch(/minItems/)
  })
})

describe("validateOutput (P21)", () => {
  const schema = {
    type: "object",
    required: ["name", "count"],
    properties: { name: { type: "string" }, count: { type: "integer", minimum: 0 } },
    additionalProperties: false,
  }

  test("accepts valid value", () => {
    const r = validateOutput(schema, { name: "a", count: 2 })
    expect(r).toEqual({ ok: true, value: { name: "a", count: 2 } })
  })

  test("returns compact error listing every failure", () => {
    const r = validateOutput(schema, { count: -1, extra: true })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain("name")
    expect(r.error).toContain("/count")
    expect(r.error).toContain("extra")
    expect(r.error.split("\n").length).toBeLessThan(10)
  })

  test("root type error", () => {
    const r = validateOutput(schema, "hello")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/object/)
  })

  test("invalid schema yields error rather than throwing", () => {
    const r = validateOutput({ type: "nope" } as any, {})
    expect(r.ok).toBe(false)
  })

  test("reuses compiled validators for the same schema object", () => {
    for (let i = 0; i < 50; i++) expect(validateOutput(schema, { name: "n", count: i }).ok).toBe(true)
  })
})

describe("maxStructuredRetries", () => {
  const saved = {
    a: process.env.MAX_STRUCTURED_OUTPUT_RETRIES,
    b: process.env.OPENCODE_WORKFLOW_MAX_STRUCTURED_OUTPUT_RETRIES,
  }
  afterEach(() => {
    const pairs: [string, string | undefined][] = [
      ["MAX_STRUCTURED_OUTPUT_RETRIES", saved.a],
      ["OPENCODE_WORKFLOW_MAX_STRUCTURED_OUTPUT_RETRIES", saved.b],
    ]
    for (const [k, v] of pairs) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  test("defaults to 5", () => {
    delete process.env.MAX_STRUCTURED_OUTPUT_RETRIES
    delete process.env.OPENCODE_WORKFLOW_MAX_STRUCTURED_OUTPUT_RETRIES
    expect(maxStructuredRetries()).toBe(5)
  })

  test("reads MAX_STRUCTURED_OUTPUT_RETRIES", () => {
    delete process.env.OPENCODE_WORKFLOW_MAX_STRUCTURED_OUTPUT_RETRIES
    process.env.MAX_STRUCTURED_OUTPUT_RETRIES = "2"
    expect(maxStructuredRetries()).toBe(2)
  })

  test("reads prefixed variant", () => {
    delete process.env.MAX_STRUCTURED_OUTPUT_RETRIES
    process.env.OPENCODE_WORKFLOW_MAX_STRUCTURED_OUTPUT_RETRIES = "7"
    expect(maxStructuredRetries()).toBe(7)
  })

  test("minimum 1 and ignores garbage", () => {
    delete process.env.OPENCODE_WORKFLOW_MAX_STRUCTURED_OUTPUT_RETRIES
    process.env.MAX_STRUCTURED_OUTPUT_RETRIES = "0"
    expect(maxStructuredRetries()).toBe(1)
    process.env.MAX_STRUCTURED_OUTPUT_RETRIES = "-3"
    expect(maxStructuredRetries()).toBe(1)
    process.env.MAX_STRUCTURED_OUTPUT_RETRIES = "abc"
    expect(maxStructuredRetries()).toBe(5)
  })
})

describe("structuredOutputInstructions", () => {
  test("names workflow_submit, output argument, and embeds schema", () => {
    const schema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] }
    const text = structuredOutputInstructions(schema)
    expect(text).toContain("workflow_submit")
    expect(text).toContain("`output`")
    expect(text).toMatch(/MUST/)
    expect(text).toContain(JSON.stringify(schema, null, 2))
    expect(text).toMatch(/nothing else/i)
  })
})

describe("extractJsonFromText", () => {
  test("parses fenced json block", () => {
    expect(extractJsonFromText('here:\n```json\n{"a":1}\n```\nbye')).toEqual({ a: 1 })
  })

  test("prefers last valid fenced block", () => {
    expect(extractJsonFromText('```json\n{"a":1}\n```\nthen\n```json\n{"a":2}\n```')).toEqual({ a: 2 })
  })

  test("accepts unlabeled fence with JSON", () => {
    expect(extractJsonFromText('```\n{"b":true}\n```')).toEqual({ b: true })
  })

  test("falls back to last balanced top-level object", () => {
    expect(extractJsonFromText('first {"x":1} and finally {"y":{"z":"}"}} done')).toEqual({ y: { z: "}" } })
  })

  test("skips unparseable braces and takes previous valid object", () => {
    expect(extractJsonFromText('{"ok":1} then {not json}')).toEqual({ ok: 1 })
  })

  test("whole text as JSON", () => {
    expect(extractJsonFromText('  {"a":[1,2]}  ')).toEqual({ a: [1, 2] })
  })

  test("returns undefined when nothing found", () => {
    expect(extractJsonFromText("no json here")).toBeUndefined()
    expect(extractJsonFromText("")).toBeUndefined()
  })
})
