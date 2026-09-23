// Workflow-authoring reference for the model (PARITY P58). AUTHORING_REFERENCE is served by the
// `/workflow-authoring` command/skill; TOOL_DESCRIPTION is the `workflow` tool's description.
// Modeled on Claude Code's workflow-authoring reference, adapted to this plugin's runtime
// (opencode child sessions, the @opencode/codemode interpreter, OPENCODE_* env vars).
// Keep every ```js example that starts with `export const meta` a valid script: a unit test parses them.

export const AUTHORING_REFERENCE = `# Workflow authoring reference

A workflow is a JavaScript script that orchestrates many subagents. The \`workflow\` tool runs it in
the background; intermediate results live in script variables, and only the script's return value
comes back to you as a task notification. Use a workflow to be comprehensive (decompose and cover in
parallel), to be confident (independent perspectives and adversarial checks before committing), or to
take on scale one context can't hold (migrations, audits, broad sweeps).

Only launch a workflow when the user opted in: they typed the keyword \`ultracode\`, asked in their own
words ("use a workflow", "run a workflow"), or invoked a saved/bundled workflow such as \`/deep-research\`.

The right move is often **hybrid**: scout inline first (list the files, scope the diff) to discover
the work-list, then call the workflow tool to pipeline over it. Common single-phase shapes you can chain
across turns: **Understand** (parallel readers → structured map), **Design** (judge panel of N
approaches → scored synthesis), **Review** (dimensions → find → adversarially verify), **Research**
(multi-modal sweep → deep-read → synthesize), **Migrate** (discover sites → transform each in a
worktree → verify). For larger work run several workflows in sequence and read each result before
deciding the next.

## Calling the tool

- \`script\`: the full script inline. Do not write it to a file first — every invocation persists the
  script and returns its path as \`scriptPath\`.
- \`scriptPath\`: re-run a persisted (possibly edited) script. Takes precedence over \`script\` and \`name\`.
  To iterate, edit that file and re-invoke with \`{scriptPath}\` instead of resending the whole script.
  Only local files are read: inside the project, the run's own copy, the personal workflows dir, or a
  directory opencode's \`external_directory\` permission allows; UNC paths are refused.
- \`name\`: run a saved or bundled workflow by its \`meta.name\`.
- \`args\`: any JSON value, exposed verbatim as the global \`args\` (\`undefined\` when omitted). Pass arrays
  and objects as real JSON values — \`args: ["a.ts", "b.ts"]\`, NOT \`args: "[\\"a.ts\\"]"\` (a stringified
  list reaches the script as one string and \`args.map\` throws).
- \`resumeFromRunId\`: relaunch a previous run, reusing its cached agent results (see Resume).

The tool returns immediately with \`{status: "async_launched", runId, taskId, scriptPath, transcriptDir}\`.
If the script fails its syntax/meta check the result carries \`error\` and nothing runs — fix and relaunch.

**After launching, END YOUR TURN**: tell the user the run started and stop. The result reaches you only as
a task notification, which wakes this session when the run finishes. Never call workflow_control status,
sleep, or run shell commands to wait for completion: status shows progress, never the result. Use \`workflow_control\` status/list only when the user asks about progress.

## The meta block

Every script must begin with \`export const meta = {...}\` as its FIRST statement:

\`\`\`js
export const meta = {
  name: 'find-flaky-tests',
  description: 'Find flaky tests and propose fixes',
  whenToUse: 'When CI shows intermittent failures',
  phases: [
    { title: 'Scan', detail: 'grep test logs for retries' },
    { title: 'Fix', detail: 'one agent per flaky test' },
  ],
}

phase('Scan')
const flaky = await agent('List tests that were retried in the last CI logs.', {
  schema: { type: 'object', required: ['tests'], properties: { tests: { type: 'array', items: { type: 'string' } } } },
})
phase('Fix')
const fixes = await pipeline(flaky.tests, (t) => agent('Propose a fix for the flaky test ' + t, { label: t }))
return fixes.filter(Boolean)
\`\`\`

- \`meta\` must be a **pure literal**: no variables, function calls, spreads, computed keys or template
  interpolation. Anything else is an error for an inline script, and a saved workflow with a
  non-literal meta is not registered as a \`/<name>\` command.
- Required: \`name\`, \`description\` (one line, shown to the user). Optional: \`whenToUse\` (shown in the
  \`/<name>\` command description and the \`workflow\` tool's saved-workflow list; say what \`args\` it
  expects, e.g. "args: an array of issue numbers", so \`/<name>\` passes it as structured JSON) and
  \`phases: [{title, detail?, model?}]\`.
- **meta.phases only LABELS the progress groups**; it never assigns agents to them. Call phase(title)
  before each stage's agents (or pass \`agent({phase})\` inside \`pipeline()\`/\`parallel()\` stages), or
  every agent lands under \`(no phase)\` and the declared phases stay at 0 agents. Use the SAME titles in
  \`meta.phases\` as in \`phase()\` calls; they are matched exactly. A \`phase()\` title with no entry gets a
  progress group of its own. Add \`model\` to a phase entry when that phase uses a model override.

## Script API

The body is plain JavaScript with top-level \`await\` and top-level \`return\` (the return value is the
workflow result).

- \`agent(prompt, opts?)\` → Promise — spawns one subagent (an opencode child session). Without a
  schema it resolves to the agent's final text (string). It resolves to **\`null\`** when the agent is
  stopped mid-run or dies on a terminal API error — always \`.filter(Boolean)\` collections of results.
  Options:
  - \`schema\`: a JSON Schema with \`{type: 'object', properties: {...}}\` at the root and
    \`required\` ⊆ \`properties\`. The agent must submit a JSON value matching it and \`agent()\` resolves
    to the validated object — no parsing needed. Validation happens at the tool-call layer and the
    agent retries on mismatch; after \`MAX_STRUCTURED_OUTPUT_RETRIES\` (default 5) failed attempts the
    call THROWS with the last validation error. A provably self-contradictory schema (e.g. a
    \`required\` key ruled out by \`additionalProperties: false\`) throws before the agent starts.
  - \`label\`: display label in the progress view.
  - \`phase\`: assign this agent to a progress group explicitly. Use it inside \`pipeline()\`/\`parallel()\`
    stages instead of relying on the global \`phase()\` state, which races between concurrent stages.
  - \`model\`: \`'provider/model'\` override. Default: omit it — the agent inherits the parent session's
    model, which is almost always right. Set it only when confident a different tier fits.
  - \`effort\`: \`'low' | 'medium' | 'high' | 'xhigh' | 'max'\` — mapped to a model variant when the model
    has one, otherwise ignored with a warning. Use \`'low'\` for cheap mechanical stages.
  - \`isolation: 'worktree'\`: run in a fresh git worktree, auto-removed if unchanged. EXPENSIVE — use
    only when agents edit files in parallel and would otherwise conflict.
  - \`agentType\`: run as a specific opencode subagent (agent id) instead of the parent's own agent;
    composes with \`schema\`. Primary agents (e.g. \`build\`, \`plan\`), unknown ids and agents the
    session's \`subagent\` permission denies make that \`agent()\` call fail (null). The child keeps the
    parent agent's deny/ask rules, so e.g. Plan mode's edit ban still applies.
- \`pipeline(items, stage1, stage2, ...)\` → Promise<any[]> — each item flows through all stages
  independently, with NO barrier between stages. Each stage receives \`(prevResult, originalItem,
  index)\`. A stage that throws drops that item to \`null\` and skips its remaining stages. Results
  keep item order. **This is the default for multi-stage work.**
- \`parallel(thunks)\` → Promise<any[]> — runs \`() => Promise\` thunks concurrently and waits for all of
  them (a BARRIER). It never rejects: a thunk that throws resolves to \`null\`.
- \`phase(title)\` — start a progress group; later \`agent()\` calls are grouped under it.
- \`log(message)\` — a narrator line in the progress view. Use it to report what was dropped or capped.
- \`args\` — the tool's \`args\` input, verbatim.
- \`budget\` — \`{total, spent(), remaining()}\`: \`total\` is the token target or \`null\` when none was set;
  \`remaining()\` is \`max(0, total - spent())\` or \`Infinity\` with no target. The target is a HARD
  ceiling: once \`spent() >= total\`, further \`agent()\` calls throw. Guard loops with \`budget.total &&\`
  — with no target \`remaining()\` is \`Infinity\` and a loop would run to the agent cap. Here the
  target is the \`workflow\` tool's \`budget\` input: set it only when the user explicitly states a token
  budget and never invent one, since a made-up number kills later agents mid-run. \`spent()\` counts the output + reasoning tokens
  of THIS run's agents (nested \`workflow()\` included; agents replayed from a resumed run count 0). The
  parent session's own tokens and other runs are not counted.
- \`workflow(nameOrRef, args?)\` → Promise — run another workflow inline (a saved name, or
  \`{scriptPath}\`) and get its return value. It shares this run's concurrency cap, agent counter,
  budget and abort signal. Nesting is one level only: \`workflow()\` inside a child throws. It throws
  on an unknown name, an unreadable path or a child syntax error — catch it to handle gracefully.

Every subagent prompt is prefixed with a short framing block: the agent runs non-interactively inside a
workflow script, nobody answers its questions, and its final message is returned verbatim to the script as
data. So subagents return raw data, not a message for a human; still say exactly what the reply must contain. Workflow agents cannot launch workflows themselves. They cannot ask the user anything
either: the \`question\` tool is unavailable and any action that would need approval (e.g. reading
outside the project) is denied, so put everything they need in the prompt.

## Limits

- Concurrent agents are capped at \`min(16, CPUs - 2)\` (at least 1); \`OPENCODE_WORKFLOW_MAX_CONCURRENT_AGENTS\`
  (1..256) overrides. Excess calls queue — passing 100 items to \`pipeline()\` is fine.
- At most 4096 items per \`parallel()\`/\`pipeline()\` call; a longer list is an explicit error. Split it.
- 1000 agents total per run; the 1001st \`agent()\` throws (a runaway-loop backstop).
- A run scheduling more than 25 agents gets a large-workflow warning (advisory only).
- No per-agent timeout by default (as in Claude Code). \`OPENCODE_WORKFLOW_AGENT_TIMEOUT_MS\` sets one; an
  agent that exceeds it fails and its \`agent()\` returns \`null\`.

## Language rules (the script runs in a restricted interpreter)

- Plain JavaScript, NOT TypeScript: type annotations (\`: string[]\`), interfaces and generics fail to parse.
- No \`import\`, \`import()\` or \`require\`; no filesystem, shell, network or Node API. Agents do that
  work; the script only coordinates them.
- Not supported by the interpreter: \`class\` declarations, \`this\`, getter/setter accessors,
  \`globalThis\`, \`Object.freeze\`. Use plain objects, closures and arrow functions.
- Available: async/await, closures, destructuring, spread, Promise, Map, Set, JSON, Math, RegExp,
  Array methods, \`new Date(x)\` with an argument.
- **Determinism**: \`Date.now()\`, \`Math.random()\` and a no-argument \`new Date()\` throw — they would
  break resume. Pass timestamps in through \`args\`, stamp results after the workflow returns, and
  vary prompts or labels by index instead of randomness.

## Resume

Each run has a \`runId\` and a transcript directory holding \`script.js\` and \`journal.jsonl\` (one line
per completed agent with its actual return value). To continue after a stop, a failure or a script
edit, relaunch with \`{scriptPath, resumeFromRunId}\`. The run is replayed in agent START order: the
longest unchanged prefix of completed \`agent()\` calls (same prompt and options) returns cached
results instantly; the first changed, failed or unfinished call and EVERY call after it runs live.
Same script + same args → 100% cache hit. Resuming an unknown run fails with \`nothing to resume\`.
Before diagnosing an empty or unexpected result, read \`<transcriptDir>/journal.jsonl\` — do not assume
cached results are non-empty.

## Pipeline by default

Reach for a barrier (\`parallel()\` between stages) ONLY when stage N needs cross-item context from all
of stage N-1: dedup/merge across the full result set before expensive work, an early exit when the
total is zero, or a prompt that compares against "the other findings". "I need to flatten/map/filter
first" is not a reason — do it inside a pipeline stage. Smell test:

    const a = await parallel(...)
    const b = transform(a)        // no cross-item dependency
    const c = await parallel(b.map(...))

Rewrite it as \`pipeline(items, stageA, (r) => transform([r]).flat(), stageB)\`. When in doubt: pipeline.

## Quality patterns

- **Adversarial verify**: spawn N independent skeptics per finding, each prompted to REFUTE it; kill
  the finding if a majority refutes. Treat verifiers that errored (\`null\`) as "unverified", never as
  a refutation.
- **Perspective-diverse verify**: give each verifier a distinct lens (correctness, security,
  reproduction) instead of N identical refuters.
- **Judge panel**: N independent attempts from different angles, scored by parallel judges; synthesize
  from the winner, grafting the best ideas of the runners-up.
- **Loop-until-dry**: for unknown-size discovery, keep spawning finders until K consecutive rounds find
  nothing new. Dedup against everything SEEN, not only against what was confirmed, or rejected
  findings reappear every round and the loop never converges.
- **Multi-modal sweep**: parallel agents each searching a different way (by file, by content, by
  entity, by time).
- **Completeness critic**: a final agent asking what is missing; its answer becomes the next round.
- **No silent caps**: if you bound coverage (top-N, sampling, no retry), \`log()\` what was dropped.

Scale to the request: "find any bugs" → a few finders and single-vote verify; "thoroughly audit" →
a larger finder pool, 3–5 vote adversarial verification and a synthesis stage.

## Example: review with adversarial verification

\`\`\`js
export const meta = {
  name: 'review-changes',
  description: 'Find correctness bugs in the listed files and keep only findings that survive verification',
  phases: [
    { title: 'Find', detail: 'one reviewer per file' },
    { title: 'Verify', detail: '3 skeptics per finding, majority vote' },
  ],
}

const FINDINGS = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['file', 'line', 'issue'],
        properties: { file: { type: 'string' }, line: { type: 'number' }, issue: { type: 'string' } },
      },
    },
  },
}
const VERDICT = {
  type: 'object',
  required: ['refuted', 'reason'],
  properties: { refuted: { type: 'boolean' }, reason: { type: 'string' } },
}

const files = Array.isArray(args) ? args : []
if (files.length === 0) return 'No files given: pass a list of paths as args.'

const perFile = await pipeline(
  files,
  (file) => agent('Review ' + file + ' for correctness bugs only. Report each with its line.', { label: file, phase: 'Find', schema: FINDINGS }),
  async (found, file) => {
    if (!found) return null
    const kept = []
    for (const f of found.findings) {
      const votes = await parallel([0, 1, 2].map((k) => () =>
        agent('Try to REFUTE this finding in ' + file + ' line ' + f.line + ': ' + f.issue + '. Default to refuted=true if uncertain.', { label: file + ' #' + k, phase: 'Verify', schema: VERDICT })))
      const cast = votes.filter(Boolean)
      if (cast.filter((v) => !v.refuted).length >= 2) kept.push(f)
      else if (cast.length < 2) kept.push({ ...f, unverified: true })
    }
    return kept
  },
)
return perFile.filter(Boolean).flat()
\`\`\`

## Example: loop until dry

\`\`\`js
export const meta = {
  name: 'find-edge-cases',
  description: 'Discover edge cases until two rounds in a row find nothing new',
}

const LIST = { type: 'object', required: ['cases'], properties: { cases: { type: 'array', items: { type: 'string' } } } }
const seen = new Set()
const found = []
let dry = 0
let round = 0
while (dry < 2) {
  round++
  const known = found.join('\\n')
  const r = await agent('Find untested edge cases in ' + args + '. Already known:\\n' + known, { label: 'round ' + round, schema: LIST })
  const fresh = (r ? r.cases : []).filter((c) => !seen.has(c.toLowerCase()))
  if (fresh.length === 0) { dry++; continue }
  dry = 0
  for (const c of fresh) { seen.add(c.toLowerCase()); found.push(c) }
  log(found.length + ' edge cases after round ' + round)
}
return found
\`\`\`

## Saving and reusing

A run's script can be saved as a command: project \`.opencode/workflows/<name>.js\` (shared with the
repo) or personal \`~/.config/opencode/workflows/<name>.js\` (\`$XDG_CONFIG_HOME\` honored). Saved and
bundled workflows run as \`/<name>\`; the rest of the line becomes \`args\` (structured JSON when the
workflow's description or \`whenToUse\` asks for it, otherwise the line as a string); the closest project directory
wins a name clash, and project beats personal. Parameterize saved workflows through \`args\` rather than
editing them per run.
`

export const TOOL_DESCRIPTION = `Run a dynamic workflow: a JavaScript script that orchestrates many subagents (fan-out, pipelines, adversarial verification) in the background. Only the script's return value comes back to you, as a task notification when the run finishes; the tool itself returns immediately with a runId and scriptPath.

AFTER LAUNCHING, END YOUR TURN: tell the user the run started and stop; the task notification wakes you with the result. Never call workflow_control status, sleep, or run shell commands to wait for completion; status is only for when the user asks about progress.

WHEN TO USE: only with explicit user opt-in — the user typed the keyword "ultracode", asked in their own words ("use a workflow", "run a workflow"), or invoked a saved/bundled workflow command (e.g. /deep-research). Never start one on your own initiative otherwise. Good fits: codebase-wide audits or bug sweeps, large migrations, research that needs sources cross-checked, plans drafted from several independent angles. Workflow subagents cannot launch workflows.

INPUT (at least one of script / name / scriptPath):
- script: full script text, inline. Every call persists it and returns scriptPath.
- scriptPath: re-run a persisted (possibly edited) script; takes precedence over script and name.
- name: run a saved or bundled workflow by meta.name.
- args: any JSON value, exposed verbatim as the global \`args\` (pass arrays/objects as real JSON, not strings).
- resumeFromRunId: relaunch a previous run; the unchanged prefix of completed agent() calls returns cached results, the first changed/failed call and everything after it runs live.

SCRIPT FORMAT: must start with \`export const meta = { name, description, whenToUse?, phases?: [{title, detail?}] }\` as a pure literal (no variables, calls, spreads or interpolation). Body: plain JavaScript (not TypeScript) with top-level await and return.

PHASES: meta.phases only LABELS the progress groups; it does not assign agents. Call phase(title) before each stage's agents (or pass agent({phase}) inside pipeline/parallel stages), with the same titles, or every agent lands under (no phase). Shape:
  phase('Scan'); const found = await agent('List the modules as {modules: string[]}', { schema })
  phase('Review'); const reviews = await pipeline(found.modules, (m) => agent('Review ' + m, { label: m }))

API:
- agent(prompt, {label?, phase?, schema?, model?, effort?, isolation?: 'worktree', agentType?}) → final text, or the validated object when schema (JSON Schema, object root) is given; null if the agent was stopped or died on an API error.
- pipeline(items, ...stages) → per-item stages, no barrier; stages get (prev, item, index); a throwing stage yields null. The default for multi-stage work.
- parallel(thunks) → barrier; never rejects, failed thunks yield null.
- phase(title), log(message), budget {total, spent(), remaining()}, workflow(nameOrRef, args?) (one nesting level).
Always .filter(Boolean) results. Limits: 4096 items per parallel/pipeline call, 1000 agents per run, concurrency min(16, CPUs-2). No import/require, filesystem or network in the script; no class, this, getters or globalThis. Date.now(), Math.random() and new Date() without arguments throw (they break resume) — pass timestamps via args.

Load the full reference with /workflow-authoring before writing a non-trivial script.`
