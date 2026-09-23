import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  BUNDLED_WORKFLOWS_DIR,
  findRepoRoot,
  listWorkflows,
  personalWorkflowsDir,
  projectWorkflowDirs,
  resolveWorkflow,
  saveWorkflow,
} from "../../src/registry.ts"
import { parseScript } from "../../src/meta.ts"
import * as acorn from "acorn"
import { buildProgram, executeProgram } from "../../src/sandbox.ts"
import { AUTHORING_REFERENCE, TOOL_DESCRIPTION } from "../../src/authoring.ts"

let tmp: string
let repo: string
let configHome: string
let emptyBundled: string

const wf = (name: string, extra = "") => `export const meta = { name: '${name}', description: 'desc of ${name}'${extra} }\nreturn '${name}'\n`

function write(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

/** Isolated options: no real ~/.config, no real bundled dir unless asked. */
const iso = () => ({ configHome, bundledDir: emptyBundled })

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wf-registry-")))
  repo = path.join(tmp, "repo")
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true })
  configHome = path.join(tmp, "config")
  emptyBundled = path.join(tmp, "bundled")
  fs.mkdirSync(emptyBundled, { recursive: true })
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe("paths", () => {
  test("findRepoRoot walks up to the dir holding .git", () => {
    const deep = path.join(repo, "a", "b")
    fs.mkdirSync(deep, { recursive: true })
    expect(findRepoRoot(deep)).toBe(repo)
  })
  test("findRepoRoot accepts a .git FILE (worktrees/submodules)", () => {
    const wt = path.join(tmp, "wt")
    write(path.join(wt, ".git"), "gitdir: elsewhere")
    expect(findRepoRoot(path.join(wt))).toBe(wt)
  })
  test("findRepoRoot returns undefined outside a repo", () => {
    const outside = path.join(tmp, "nogit")
    fs.mkdirSync(outside)
    // tmp itself is not inside a repo in the test environment
    const r = findRepoRoot(outside)
    expect(r === undefined || !r.startsWith(tmp)).toBe(true)
  })
  test("projectWorkflowDirs lists cwd → repo root, closest first", () => {
    const deep = path.join(repo, "pkg", "sub")
    fs.mkdirSync(deep, { recursive: true })
    expect(projectWorkflowDirs(deep)).toEqual([
      path.join(deep, ".opencode", "workflows"),
      path.join(repo, "pkg", ".opencode", "workflows"),
      path.join(repo, ".opencode", "workflows"),
    ])
  })
  test("projectWorkflowDirs is just cwd when not in a repo", () => {
    const outside = path.join(tmp, "nogit")
    fs.mkdirSync(outside)
    if (findRepoRoot(outside) === undefined) expect(projectWorkflowDirs(outside)).toEqual([path.join(outside, ".opencode", "workflows")])
  })
  test("personalWorkflowsDir honors XDG_CONFIG_HOME, else ~/.config", () => {
    expect(personalWorkflowsDir({ XDG_CONFIG_HOME: "/x/cfg" }, "/home/u")).toBe(path.join("/x/cfg", "opencode", "workflows"))
    expect(personalWorkflowsDir({}, "/home/u")).toBe(path.join("/home/u", ".config", "opencode", "workflows"))
  })
  test("BUNDLED_WORKFLOWS_DIR is the repo's workflows/ directory", () => {
    expect(fs.existsSync(path.join(BUNDLED_WORKFLOWS_DIR, "deep-research.js"))).toBe(true)
  })
})

describe("discovery (P53)", () => {
  test("lists project, personal and bundled workflows with origin", () => {
    write(path.join(repo, ".opencode", "workflows", "a.js"), wf("proj-a"))
    write(path.join(configHome, "opencode", "workflows", "b.js"), wf("pers-b"))
    write(path.join(emptyBundled, "c.js"), wf("bundled-c"))
    const list = listWorkflows(repo, iso())
    const byName = Object.fromEntries(list.map((w) => [w.meta.name, w]))
    expect(Object.keys(byName).sort()).toEqual(["bundled-c", "pers-b", "proj-a"])
    expect(byName["proj-a"]!.origin).toBe("project")
    expect(byName["pers-b"]!.origin).toBe("personal")
    expect(byName["bundled-c"]!.origin).toBe("bundled")
    expect(byName["proj-a"]!.path).toBe(path.join(repo, ".opencode", "workflows", "a.js"))
    expect(byName["proj-a"]!.source).toBe(wf("proj-a"))
    expect(byName["proj-a"]!.meta.description).toBe("desc of proj-a")
  })

  test("name comes from meta.name, not the file name", () => {
    write(path.join(repo, ".opencode", "workflows", "file-name.js"), wf("meta-name"))
    expect(resolveWorkflow("meta-name", repo, iso())?.meta.name).toBe("meta-name")
    expect(resolveWorkflow("file-name", repo, iso())).toBeUndefined()
  })

  test("only *.js files are considered", () => {
    write(path.join(repo, ".opencode", "workflows", "x.ts"), wf("ts-one"))
    write(path.join(repo, ".opencode", "workflows", "x.md"), wf("md-one"))
    write(path.join(repo, ".opencode", "workflows", "ok.js"), wf("js-one"))
    expect(listWorkflows(repo, iso()).map((w) => w.meta.name)).toEqual(["js-one"])
  })

  test("closest project dir wins on name clash", () => {
    const pkg = path.join(repo, "pkg")
    write(path.join(repo, ".opencode", "workflows", "same.js"), wf("same", ", whenToUse: 'root'"))
    write(path.join(pkg, ".opencode", "workflows", "same.js"), wf("same", ", whenToUse: 'pkg'"))
    const r = resolveWorkflow("same", pkg, iso())
    expect(r?.meta.whenToUse).toBe("pkg")
    expect(r?.origin).toBe("project")
    expect(listWorkflows(pkg, iso()).filter((w) => w.meta.name === "same")).toHaveLength(1)
    // from the root, the pkg dir is not on the path
    expect(resolveWorkflow("same", repo, iso())?.meta.whenToUse).toBe("root")
  })

  test("project beats personal, personal beats bundled", () => {
    write(path.join(repo, ".opencode", "workflows", "p.js"), wf("dup", ", whenToUse: 'project'"))
    write(path.join(configHome, "opencode", "workflows", "p.js"), wf("dup", ", whenToUse: 'personal'"))
    write(path.join(configHome, "opencode", "workflows", "q.js"), wf("dup2", ", whenToUse: 'personal'"))
    write(path.join(emptyBundled, "q.js"), wf("dup2", ", whenToUse: 'bundled'"))
    expect(resolveWorkflow("dup", repo, iso())?.origin).toBe("project")
    expect(resolveWorkflow("dup2", repo, iso())?.origin).toBe("personal")
    expect(resolveWorkflow("dup2", repo, iso())?.meta.whenToUse).toBe("personal")
  })

  test("dirs above the repo root are not scanned", () => {
    write(path.join(tmp, ".opencode", "workflows", "above.js"), wf("above"))
    expect(resolveWorkflow("above", repo, iso())).toBeUndefined()
  })

  test("non-literal meta ⇒ skipped (P11)", () => {
    write(path.join(repo, ".opencode", "workflows", "bad.js"), "const n = 'x'\nexport const meta = { name: n, description: 'd' }\n")
    write(path.join(repo, ".opencode", "workflows", "bad2.js"), "export const meta = { name: 'bad2', description: `a${1}` }\n")
    write(path.join(repo, ".opencode", "workflows", "good.js"), wf("good"))
    expect(listWorkflows(repo, iso()).map((w) => w.meta.name)).toEqual(["good"])
    expect(resolveWorkflow("bad2", repo, iso())).toBeUndefined()
  })

  test("valid meta with a broken body is still listed (error surfaces at run time)", () => {
    write(path.join(repo, ".opencode", "workflows", "b.js"), "export const meta = { name: 'broken', description: 'd' }\nconst x: string = 1\n")
    expect(resolveWorkflow("broken", repo, iso())?.meta.name).toBe("broken")
  })

  test("a non-literal-meta file does not shadow a valid one further away", () => {
    const pkg = path.join(repo, "pkg")
    write(path.join(pkg, ".opencode", "workflows", "x.js"), "export const meta = { name: 'x', description: String(1) }\n")
    write(path.join(repo, ".opencode", "workflows", "x.js"), wf("x"))
    expect(resolveWorkflow("x", pkg, iso())?.path).toBe(path.join(repo, ".opencode", "workflows", "x.js"))
  })

  test("same name twice in one dir: first file in sorted order wins, deterministic", () => {
    write(path.join(repo, ".opencode", "workflows", "b.js"), wf("twin", ", whenToUse: 'b'"))
    write(path.join(repo, ".opencode", "workflows", "a.js"), wf("twin", ", whenToUse: 'a'"))
    expect(resolveWorkflow("twin", repo, iso())?.meta.whenToUse).toBe("a")
  })

  test("missing directories are fine", () => {
    expect(listWorkflows(repo, iso())).toEqual([])
  })

  test("list is sorted by name", () => {
    write(path.join(repo, ".opencode", "workflows", "1.js"), wf("zeta"))
    write(path.join(repo, ".opencode", "workflows", "2.js"), wf("alpha"))
    write(path.join(emptyBundled, "3.js"), wf("mid"))
    expect(listWorkflows(repo, iso()).map((w) => w.meta.name)).toEqual(["alpha", "mid", "zeta"])
  })

  test("personal dir defaults to XDG_CONFIG_HOME from env option", () => {
    write(path.join(configHome, "opencode", "workflows", "p.js"), wf("via-env"))
    const r = resolveWorkflow("via-env", repo, { env: { XDG_CONFIG_HOME: configHome }, bundledDir: emptyBundled })
    expect(r?.origin).toBe("personal")
  })

  test("bundled dir defaults to the real one and includes deep-research", () => {
    const r = resolveWorkflow("deep-research", repo, { configHome })
    expect(r?.origin).toBe("bundled")
    expect(r?.path).toBe(path.join(BUNDLED_WORKFLOWS_DIR, "deep-research.js"))
  })
})

describe("save (P52)", () => {
  const src = wf("saved")

  test("project: writes to repo root .opencode/workflows when none exists", () => {
    const deep = path.join(repo, "a", "b")
    fs.mkdirSync(deep, { recursive: true })
    const p = saveWorkflow({ source: src, name: "saved", location: "project", cwd: deep })
    expect(p).toBe(path.join(repo, ".opencode", "workflows", "saved.js"))
    expect(fs.readFileSync(p, "utf8")).toBe(src)
    expect(resolveWorkflow("saved", deep, iso())?.origin).toBe("project")
  })

  test("project: writes to the closest existing .opencode/workflows between cwd and root", () => {
    const deep = path.join(repo, "pkg", "src")
    fs.mkdirSync(deep, { recursive: true })
    fs.mkdirSync(path.join(repo, "pkg", ".opencode", "workflows"), { recursive: true })
    fs.mkdirSync(path.join(repo, ".opencode", "workflows"), { recursive: true })
    const p = saveWorkflow({ source: src, name: "saved", location: "project", cwd: deep })
    expect(p).toBe(path.join(repo, "pkg", ".opencode", "workflows", "saved.js"))
  })

  test("project outside a repo: writes under cwd", () => {
    const outside = path.join(tmp, "nogit")
    fs.mkdirSync(outside)
    if (findRepoRoot(outside) !== undefined) return
    const p = saveWorkflow({ source: src, name: "saved", location: "project", cwd: outside })
    expect(p).toBe(path.join(outside, ".opencode", "workflows", "saved.js"))
  })

  test("personal: writes to <configHome>/opencode/workflows", () => {
    const p = saveWorkflow({ source: src, name: "saved", location: "personal", cwd: repo, configHome })
    expect(p).toBe(path.join(configHome, "opencode", "workflows", "saved.js"))
    expect(fs.readFileSync(p, "utf8")).toBe(src)
  })

  test("name defaults to meta.name", () => {
    const p = saveWorkflow({ source: wf("from-meta"), location: "project", cwd: repo })
    expect(path.basename(p)).toBe("from-meta.js")
  })

  test("overwrites an existing saved file", () => {
    saveWorkflow({ source: wf("saved"), name: "saved", location: "project", cwd: repo })
    const p = saveWorkflow({ source: wf("saved", ", whenToUse: 'v2'"), name: "saved", location: "project", cwd: repo })
    expect(resolveWorkflow("saved", repo, iso())?.meta.whenToUse).toBe("v2")
    expect(fs.readdirSync(path.dirname(p))).toEqual(["saved.js"])
  })

  test("rejects unsafe names (path traversal, separators, empty)", () => {
    for (const name of ["../evil", "a/b", "a\\b", "", ".hidden", "..", "con sole"]) {
      expect(() => saveWorkflow({ source: src, name, location: "project", cwd: repo })).toThrow()
    }
  })

  test("rejects a script whose meta is not a pure literal", () => {
    expect(() =>
      saveWorkflow({ source: "export const meta = { name: String('x'), description: 'd' }\n", name: "x", location: "project", cwd: repo }),
    ).toThrow(/meta/)
  })

  test("project: refuses when .opencode is a symlink", () => {
    const real = path.join(tmp, "elsewhere")
    fs.mkdirSync(path.join(real, "workflows"), { recursive: true })
    fs.symlinkSync(real, path.join(repo, ".opencode"), "junction")
    expect(() => saveWorkflow({ source: src, name: "saved", location: "project", cwd: repo })).toThrow(/symlink/i)
    expect(fs.existsSync(path.join(real, "workflows", "saved.js"))).toBe(false)
  })

  test("project: refuses when .opencode/workflows is a symlink", () => {
    const real = path.join(tmp, "elsewhere")
    fs.mkdirSync(real, { recursive: true })
    fs.mkdirSync(path.join(repo, ".opencode"))
    fs.symlinkSync(real, path.join(repo, ".opencode", "workflows"), "junction")
    expect(() => saveWorkflow({ source: src, name: "saved", location: "project", cwd: repo })).toThrow(/symlink/i)
    expect(fs.existsSync(path.join(real, "saved.js"))).toBe(false)
  })

  test("project: refuses when the target file is a symlink", () => {
    const dir = path.join(repo, ".opencode", "workflows")
    fs.mkdirSync(dir, { recursive: true })
    const real = path.join(tmp, "elsewhere")
    fs.mkdirSync(real)
    fs.symlinkSync(real, path.join(dir, "saved.js"), "junction")
    expect(() => saveWorkflow({ source: src, name: "saved", location: "project", cwd: repo })).toThrow(/symlink/i)
  })

  test("personal: a symlinked config dir is allowed", () => {
    const real = path.join(tmp, "dotfiles")
    fs.mkdirSync(path.join(real, "workflows"), { recursive: true })
    fs.mkdirSync(configHome, { recursive: true })
    fs.symlinkSync(real, path.join(configHome, "opencode"), "junction")
    const p = saveWorkflow({ source: src, name: "saved", location: "personal", cwd: repo, configHome })
    expect(fs.readFileSync(path.join(real, "workflows", "saved.js"), "utf8")).toBe(src)
    expect(p).toBe(path.join(configHome, "opencode", "workflows", "saved.js"))
  })

  test("personal: refuses when the target file is a symlink", () => {
    const dir = path.join(configHome, "opencode", "workflows")
    fs.mkdirSync(dir, { recursive: true })
    const real = path.join(tmp, "elsewhere")
    fs.mkdirSync(real)
    fs.symlinkSync(real, path.join(dir, "saved.js"), "junction")
    expect(() => saveWorkflow({ source: src, name: "saved", location: "personal", cwd: repo, configHome })).toThrow(/symlink/i)
  })
})

// ---------------------------------------------------------------------------------------------
// Bundled /deep-research (P54)
// ---------------------------------------------------------------------------------------------

const DR_PATH = path.join(BUNDLED_WORKFLOWS_DIR, "deep-research.js")
const drSource = () => fs.readFileSync(DR_PATH, "utf8")

type Call = { prompt: string; opts: Record<string, any> }

/** Fake agent host that answers each deep-research stage by recognising its schema. */
function fakeHost(opts: { verdict?: (claim: string, n: number) => unknown; failSearch?: boolean } = {}) {
  const calls: Call[] = []
  const phases: string[] = []
  const logs: string[] = []
  const verifyCount = new Map<string, number>()
  const __agent = async (prompt: string, o: Record<string, any>) => {
    calls.push({ prompt, opts: o })
    const props = Object.keys(o?.schema?.properties ?? {})
    if (props.includes("angles")) {
      return { angles: [{ title: "History", query: "q1", rationale: "r" }, { title: "Current state", query: "q2", rationale: "r" }] }
    }
    if (props.includes("claims")) {
      const idx = prompt.includes("History") ? 1 : 2
      return {
        claims: [
          { claim: `Claim A${idx}`, sources: [{ url: `https://a${idx}.example`, title: "A" }], confidence: "high" },
          { claim: `Claim B${idx}`, sources: [{ url: `https://b${idx}.example`, title: "B" }], confidence: "medium" },
        ],
      }
    }
    if (props.includes("refuted")) {
      const m = /Claim [AB]\d/.exec(prompt)
      const c = m ? m[0] : "?"
      const n = (verifyCount.get(c) ?? 0) + 1
      verifyCount.set(c, n)
      if (opts.verdict) {
        const v = opts.verdict(c, n)
        if (v instanceof Error) throw v
        return v
      }
      return { refuted: false, reasoning: "holds" }
    }
    if (o?.schema) throw new Error("unexpected schema: " + JSON.stringify(props))
    // unstructured: research notes or final report
    if (/report/i.test(o?.label ?? "") || /synthes/i.test(prompt.slice(0, 400))) return "# Report\n\nBody with [1] citation."
    if (opts.failSearch) throw new Error("rate limited")
    return `Notes for ${prompt.slice(0, 40)} https://src.example`
  }
  const globals: Record<string, Function> = {
    __agent,
    __phase: (t: string) => void phases.push(t),
    __log: (m: string) => void logs.push(m),
    __workflow: async () => null,
    __budget_total: () => null,
    __budget_spent: () => 0,
  }
  return { globals, calls, phases, logs }
}

async function runDeepResearch(args: unknown, host = fakeHost()) {
  const parsed = parseScript(drSource())
  if (!parsed.ok) throw new Error(parsed.error)
  const r = await executeProgram(buildProgram(parsed.body, args), host.globals)
  return { r, host }
}

describe("bundled deep-research workflow (P54)", () => {
  test("passes parseScript with name deep-research and declared phases, no warnings", () => {
    const parsed = parseScript(drSource())
    if (!parsed.ok) throw new Error(parsed.error)
    expect(parsed.meta.name).toBe("deep-research")
    expect(parsed.meta.description.length).toBeGreaterThan(10)
    expect(parsed.meta.whenToUse).toBeDefined()
    expect(parsed.meta.phases?.map((p) => p.title)).toEqual(["Plan", "Research", "Extract", "Verify", "Synthesize"])
    expect(parsed.warnings).toEqual([])
  })

  test("does not use Date or Math.random", () => {
    const src = drSource()
    expect(src).not.toMatch(/\bDate\b/)
    expect(src).not.toMatch(/Math\.random/)
  })

  test("uses no codemode-unsupported constructs (class, this, getters, globalThis)", () => {
    const ast = acorn.parse(drSource(), { ecmaVersion: "latest", sourceType: "module", allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true })
    const found: string[] = []
    const visit = (n: any) => {
      if (!n || typeof n !== "object") return
      if (Array.isArray(n)) return n.forEach(visit)
      if (typeof n.type === "string") {
        if (n.type === "ClassDeclaration" || n.type === "ClassExpression" || n.type === "ThisExpression") found.push(n.type)
        if (n.type === "Property" && (n.kind === "get" || n.kind === "set")) found.push("accessor")
        if (n.type === "Identifier" && n.name === "globalThis") found.push("globalThis")
      }
      for (const k of Object.keys(n)) if (k !== "loc") visit(n[k])
    }
    visit(ast)
    expect(found).toEqual([])
  })

  test("runs end-to-end on a fake host and returns a cited Markdown report string", async () => {
    const { r, host } = await runDeepResearch("What changed in Node's permission model?")
    if (!r.ok) throw new Error(r.error)
    expect(typeof r.value).toBe("string")
    expect(r.value as string).toContain("# Report")
    expect(host.phases).toEqual(["Plan", "Research", "Verify", "Synthesize"])
    // agents inside pipeline()/parallel() pin their group explicitly via opts.phase
    const groups = [...new Set(host.calls.map((c) => c.opts.phase ?? "Plan"))]
    expect(groups).toEqual(["Plan", "Research", "Extract", "Verify", "Synthesize"])
    // 1 plan + 2 research + 2 extract + 4 claims*3 skeptics + 1 synth
    expect(host.calls).toHaveLength(1 + 2 + 2 + 12 + 1)
    const plan = host.calls[0]!
    expect(plan.prompt).toContain("What changed in Node's permission model?")
    const research = host.calls.filter((c) => !c.opts.schema && c !== host.calls.at(-1))
    for (const c of research) expect(c.prompt).toMatch(/websearch/i)
    const synth = host.calls.at(-1)!
    expect(synth.prompt).toContain("Claim A1")
    expect(synth.prompt).toContain("https://a1.example")
  })

  test("the question is required", async () => {
    const { r } = await runDeepResearch(undefined)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/question/i)
  })

  test("accepts {question} object args too", async () => {
    const { r, host } = await runDeepResearch({ question: "Why is the sky blue?" })
    if (!r.ok) throw new Error(r.error)
    expect(host.calls[0]!.prompt).toContain("Why is the sky blue?")
  })

  test("majority-refuted claims are dropped; errored verifiers ⇒ UNVERIFIED, not refuted", async () => {
    const host = fakeHost({
      verdict: (c, n) => {
        if (c === "Claim A1") return { refuted: true, reasoning: "wrong" } // 3/3 refute → dropped
        if (c === "Claim B1") return n === 1 ? { refuted: true, reasoning: "x" } : { refuted: false, reasoning: "ok" } // 1/3 → kept
        if (c === "Claim A2") return new Error("API error") // all errored → unverified
        return { refuted: false, reasoning: "ok" }
      },
    })
    const { r } = await runDeepResearch("q", host)
    if (!r.ok) throw new Error(r.error)
    const synth = host.calls.at(-1)!.prompt
    const verifiedSection = synth.slice(synth.indexOf("VERIFIED"), synth.indexOf("UNVERIFIED"))
    expect(synth).not.toContain("Claim A1")
    expect(verifiedSection).toContain("Claim B1")
    expect(verifiedSection).toContain("Claim B2")
    expect(synth).toContain("UNVERIFIED")
    expect(synth.slice(synth.indexOf("UNVERIFIED"))).toContain("Claim A2")
  })

  test("a claim with only one surviving vote (2 verifiers errored) is UNVERIFIED, not verified", async () => {
    const host = fakeHost({
      verdict: (c, n) => (c === "Claim A1" && n > 1 ? new Error("rate limit") : { refuted: false, reasoning: "ok" }),
    })
    const { r } = await runDeepResearch("q", host)
    if (!r.ok) throw new Error(r.error)
    const synth = host.calls.at(-1)!.prompt
    expect(synth.slice(synth.indexOf("UNVERIFIED"))).toContain("Claim A1")
  })

  test("when every research agent fails, returns an explanatory string instead of throwing", async () => {
    const host = fakeHost({ failSearch: true })
    const { r } = await runDeepResearch("q", host)
    if (!r.ok) throw new Error(r.error)
    expect(typeof r.value).toBe("string")
    expect(r.value as string).toMatch(/no (research|sources)/i)
  })

  test("verify stage does not wait for all extraction (pipeline, no barrier)", async () => {
    // Structural check: the script uses pipeline() over angles.
    expect(drSource()).toMatch(/pipeline\(/)
  })
})

// ---------------------------------------------------------------------------------------------
// Authoring reference (P58)
// ---------------------------------------------------------------------------------------------

describe("authoring reference (P58)", () => {
  test("AUTHORING_REFERENCE covers the whole script API and rules", () => {
    const must = [
      "export const meta",
      "pure literal",
      "agent(",
      "parallel(",
      "pipeline(",
      "phase(",
      "log(",
      "args",
      "budget",
      "workflow(",
      "null",
      "schema",
      "4096",
      "1000",
      "Date.now()",
      "Math.random()",
      "resumeFromRunId",
      "scriptPath",
      "journal.jsonl",
      "Adversarial verify",
      "Loop-until-dry",
      "isolation",
      "agentType",
      "effort",
      "class",
      "this",
      "getter",
      "globalThis",
      "TypeScript",
      "whenToUse",
      "MAX_STRUCTURED_OUTPUT_RETRIES",
      "OPENCODE_WORKFLOW_MAX_CONCURRENT_AGENTS",
    ]
    for (const m of must) expect(AUTHORING_REFERENCE).toContain(m)
  })

  test("AUTHORING_REFERENCE examples are valid workflow scripts", () => {
    const blocks = [...AUTHORING_REFERENCE.matchAll(/```js\n([\s\S]*?)```/g)].map((m) => m[1]!)
    const full = blocks.filter((b) => b.startsWith("export const meta"))
    expect(full.length).toBeGreaterThanOrEqual(2)
    for (const b of full) {
      const r = parseScript(b)
      if (!r.ok) throw new Error(`example failed to parse: ${r.error}\n${b}`)
    }
  })

  test("AUTHORING_REFERENCE examples actually run in the sandbox against a fake host", async () => {
    const blocks = [...AUTHORING_REFERENCE.matchAll(/```js\n([\s\S]*?)```/g)].map((m) => m[1]!).filter((b) => b.startsWith("export const meta"))
    const answers = (o: any, n: number) => {
      const p = Object.keys(o?.schema?.properties ?? {})
      if (p.includes("tests")) return { tests: ["t1", "t2"] }
      if (p.includes("findings")) return { findings: [{ file: "a.ts", line: 1, issue: "bug" }] }
      if (p.includes("refuted")) return { refuted: false, reason: "ok" }
      if (p.includes("cases")) return { cases: n < 3 ? ["case" + n] : [] }
      return "fix"
    }
    for (const b of blocks) {
      const parsed = parseScript(b)
      if (!parsed.ok) throw new Error(parsed.error)
      let n = 0
      const globals: Record<string, Function> = {
        __agent: async (_p: string, o: any) => answers(o, ++n),
        __phase: () => undefined,
        __log: () => undefined,
        __workflow: async () => null,
        __budget_total: () => null,
        __budget_spent: () => 0,
      }
      const r = await executeProgram(buildProgram(parsed.body, parsed.meta.name === "review-changes" ? ["a.ts"] : "src/"), globals)
      if (!r.ok) throw new Error(`${parsed.meta.name}: ${r.error}`)
      expect(Array.isArray(r.value)).toBe(true)
      expect((r.value as unknown[]).length).toBeGreaterThan(0)
    }
  })

  test("TOOL_DESCRIPTION: concise, names the tool inputs, opt-in rule and ultracode keyword", () => {
    expect(TOOL_DESCRIPTION.length).toBeLessThan(AUTHORING_REFERENCE.length)
    expect(TOOL_DESCRIPTION.length).toBeLessThan(6000)
    for (const m of ["ultracode", "use a workflow", "opt-in", "script", "scriptPath", "resumeFromRunId", "args", "export const meta", "agent(", "pipeline(", "parallel(", "background", "/workflow-authoring"]) {
      expect(TOOL_DESCRIPTION).toContain(m)
    }
  })
})
