# Workflow script API

This is the full reference for workflow scripts. You rarely write them by hand, because the model
does. It is useful for reviewing what the model wrote, editing a persisted script, or writing a saved
workflow. The model gets the same information from `/workflow-authoring`.

- [The `workflow` tool](#the-workflow-tool)
- [Script format](#script-format)
- [Globals](#globals)
- [Limits](#limits)
- [Language rules](#language-rules)
- [Resume](#resume)
- [Saved workflows](#saved-workflows)
- [Patterns](#patterns)

## The `workflow` tool

| Input | Meaning |
|---|---|
| `script` | The full script, inline. |
| `scriptPath` | Run a script file, usually the persisted copy of an earlier run after editing it. Takes precedence over `script` and `name`. Only files the session may read are accepted (see [Security model](../README.md#security-model)). |
| `name` | Run a saved or bundled workflow by its `meta.name`. |
| `args` | Any JSON value. It is exposed verbatim as the global `args` (`undefined` when omitted). Pass arrays and objects as real JSON, not as a string. |
| `resumeFromRunId` | Relaunch a previous run and reuse its cached agent results. |
| `budget` | A token ceiling. The model sets it only when you state a budget. It is not part of Claude Code's tool input (see [PARITY](PARITY.md) P34). |

At least one of `script`, `name` or `scriptPath` is required. The tool returns immediately:

```json
{ "status": "async_launched", "taskId": "…", "taskType": "local_workflow", "workflowName": "…",
  "runId": "wf_…", "summary": "…", "transcriptDir": "…", "scriptPath": "…" }
```

If the script fails its syntax or meta check, the result also has `error` set and nothing runs.
Every launch persists the script and returns its path as `scriptPath`, so an edited copy can be
relaunched with `{ scriptPath }`.

When the run finishes, stops or fails, its return value arrives in the parent session as a
`<task-notification>`, with the status and usage (agent count, tokens, duration). That is the only
way the result reaches the model. `workflow_control status` shows progress, never the result.

## Script format

```js
export const meta = {
  name: 'find-flaky-tests',
  description: 'Find flaky tests and propose fixes',
  whenToUse: 'When CI shows intermittent failures. args: a CI log path',
  phases: [
    { title: 'Scan', detail: 'look for retried tests' },
    { title: 'Fix', detail: 'one agent per flaky test' },
  ],
}

phase('Scan')
const flaky = await agent(`List tests that were retried in ${args}.`, {
  schema: { type: 'object', required: ['tests'], properties: { tests: { type: 'array', items: { type: 'string' } } } },
})
phase('Fix')
const fixes = await pipeline(flaky.tests, (t) => agent(`Propose a fix for the flaky test ${t}`, { label: t }))
return fixes.filter(Boolean)
```

**`meta`** must be the **first statement** and a **pure literal**: no variables, function calls,
spreads, computed keys or template interpolation. For an inline script, anything else is an error.
A saved workflow with a non-literal `meta` is not registered as a command.

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | The workflow's name, and its `/<name>` command when saved. |
| `description` | yes | One line, shown to the user. |
| `whenToUse` | no | Shown in the `/<name>` command description and the `workflow` tool description. Say what `args` it expects, so `/<name>` passes structured JSON. |
| `phases` | no | `[{ title, detail?, model? }]`. **Labels only**: they don't assign agents to groups. Call `phase(title)` with the same title before that stage's agents, or pass `agent(…, { phase })`. |

**The body** is plain JavaScript with top-level `await` and top-level `return`. The returned value is
the workflow's result.

## Globals

### `agent(prompt, opts?)`

Runs one subagent: an opencode child session titled `[wf:<runId>] <label>`.

- Without `schema`, it resolves to the agent's final text.
- With `schema`, it resolves to the validated object.
- It resolves to **`null`** if the agent is stopped, dies on a terminal API error or ends with no
  text. Always `.filter(Boolean)` a list of results.

| Option | Meaning |
|---|---|
| `schema` | A JSON Schema with `{ type: 'object', properties: {…} }` at the root. The agent submits its answer through the `workflow_submit` tool, which validates it and asks for a retry on mismatch. After `MAX_STRUCTURED_OUTPUT_RETRIES` failed attempts (default 5), `agent()` throws with the last validation error. A schema that contradicts itself (for example a `required` key ruled out by `additionalProperties: false`) throws before the agent starts. |
| `label` | Display label in the progress view and the child session title. |
| `phase` | Put this agent in a progress group explicitly. Prefer it inside `pipeline()`/`parallel()` stages, where the global `phase()` state races between concurrent stages. |
| `model` | `'provider/model'`. Default: the parent session's model. |
| `effort` | `'low'`, `'medium'`, `'high'`, `'xhigh'` or `'max'`. Mapped to a model variant when the model has one, otherwise ignored with a warning. |
| `isolation` | `'worktree'` runs the agent in a fresh git worktree, removed afterwards if unchanged. Expensive: use it only when agents edit files in parallel. Needs git and a git repo. |
| `agentType` | Run as a specific opencode subagent (agent id) instead of the parent's agent. Works with `schema`. An unknown id, a primary agent (such as `build` or `plan`) or one your `subagent` permission denies makes the call resolve to `null`. The parent agent's deny and ask rules still apply. |

Every agent prompt starts with a short framing block. It tells the agent that it runs
non-interactively inside a workflow, that nobody will answer its questions, and that its final
message goes back to the script verbatim as data. Write prompts that say exactly what the reply must
contain. The framing is not part of the resume key.

### `parallel(thunks)`

Runs an array of `() => Promise` thunks concurrently and waits for all of them (a **barrier**). It
never rejects: a thunk that throws resolves to `null`. Results keep input order.

### `pipeline(items, stage1, stage2, …)`

Each item goes through every stage on its own, with **no barrier** between stages: item 1 can be in
stage 3 while item 5 is still in stage 1. Each stage receives `(prevResult, originalItem, index)`. A
stage that throws turns that item into `null` and skips its remaining stages. Results keep item
order. This is the right default for multi-stage work.

### `phase(title)` and `log(message)`

`phase()` starts a progress group, and later `agent()` calls are grouped under it. `log()` writes a
narrator line to the progress view. Use it to say what was skipped or capped.

### `args`

The tool's `args` input, verbatim. `undefined` when omitted.

### `budget`

`{ total, spent(), remaining() }`.

- `total` is the tool's `budget` input, or `null` when none was given.
- `spent()` is the output and reasoning tokens used by this run's agents, including nested
  `workflow()` runs. Agents replayed from a resumed run count 0. The parent session's own tokens are
  not counted.
- `remaining()` is `max(0, total - spent())`, or `Infinity` with no budget.
- It is a hard ceiling: once `spent() >= total`, further `agent()` calls throw.

Guard loops with `budget.total && …`. With no budget, `remaining()` is `Infinity`, and a loop would
only stop at the 1000-agent cap.

### `workflow(nameOrRef, args?)`

Runs another workflow inline (a saved name, or `{ scriptPath }`) and resolves to its return value. It
shares the run's concurrency cap, agent counter, budget and stop signal. Only one level of nesting is
allowed: calling `workflow()` inside a child throws. It also throws on an unknown name, an unreadable
path or a syntax error in the child.

## Limits

| Limit | Value |
|---|---|
| Concurrent agents per run | `min(16, CPUs - 2)`, at least 1. `OPENCODE_WORKFLOW_MAX_CONCURRENT_AGENTS` (1 to 256) overrides it. Extra calls queue. |
| Agents per run | 1000. The 1001st `agent()` throws. |
| Items per `parallel()`/`pipeline()` call | 4096. A longer list is an explicit error, so split it. |
| Large-workflow warning | More than 25 agents, or the `sizeGuideline` count if you set one. Advisory only. |
| Per-agent timeout | None by default. Set one with `OPENCODE_WORKFLOW_AGENT_TIMEOUT_MS`. |

## Language rules

Scripts run in opencode's codemode interpreter, a restricted JavaScript interpreter.

- **Plain JavaScript, not TypeScript.** Type annotations, interfaces and generics fail to parse.
- **No `import`, `import()` or `require`.** No filesystem, shell, network or Node API. Agents do that
  work, and the script only coordinates them.
- **Not supported:** `class`, `this`, getters and setters, `globalThis`, `Object.freeze`.
- **Available:** async/await, closures, arrow functions, destructuring, spread, template literals,
  `Promise`, `Map`, `Set`, `JSON`, `Math`, `RegExp`, array methods, and `new Date(x)` with an
  argument.
- **Deterministic:** `Date.now()`, `Math.random()` and a no-argument `new Date()` throw, because they
  would break resume. Pass timestamps in through `args`, and vary prompts by index instead of
  randomness.

## Resume

Each run's transcript directory (`<data dir>/<sessionID>/<runId>/`) holds:

| File | Content |
|---|---|
| `script.js` | The script that ran. |
| `journal.jsonl` | One line per finished agent, with its return value. |
| `run.json` | The run summary, including the result. |
| `agents/<i>.json` | Each agent's prompt, result, usage and child `sessionID`. |

Relaunch with `{ scriptPath, resumeFromRunId }` after a stop, a failure or a script edit. The run
replays in agent **start** order. The longest unchanged prefix of finished `agent()` calls (same
prompt and options) returns cached results at once. The first changed, failed or unfinished call,
and every call after it, runs live. Same script and same args give a 100% cache hit.

A resume is refused while agents from the stopped run are still running. Resuming an unknown run, or
one with no finished agents, fails with `nothing to resume`.

## Saved workflows

| Scope | Directory |
|---|---|
| Project | `.opencode/workflows/<name>.js` (any ancestor directory of the project; the closest wins) |
| Personal | `~/.config/opencode/workflows/<name>.js` (`$XDG_CONFIG_HOME/opencode/workflows/` if set) |
| Bundled | `deep-research` |

Each valid script becomes a `/<name>` command. The rest of the command line becomes `args`: the
model passes structured JSON when the workflow's `description` or `whenToUse` asks for it, and
otherwise the line as a string. A project workflow wins over a personal one with the same name.
`workflow_control save` writes a run's script to either directory, and never writes through a
symlink.

## Patterns

- **Pipeline by default.** Put a `parallel()` barrier between stages only when stage N needs all of
  stage N-1's results together, for example to dedupe across all findings or to stop early when the
  total is zero.
- **Adversarial verify.** Give each finding to N independent skeptics told to *refute* it, and drop
  it if most succeed. Treat a `null` verifier as "unverified", not as a refutation.
- **Perspective-diverse verify.** Give each verifier a different lens (correctness, security,
  reproduction) instead of N identical ones.
- **Judge panel.** Make N attempts from different angles, have judges score them in parallel, and
  build on the winner.
- **Loop until dry.** For discovery of unknown size, keep running finders until K rounds in a row
  find nothing new. Dedupe against everything *seen*, not only against what was confirmed.
- **No silent caps.** If you sample or truncate, `log()` what was dropped.

### Example: review with majority-vote verification

```js
export const meta = {
  name: 'review-changes',
  description: 'Find correctness bugs in the listed files and keep only findings that survive verification',
  whenToUse: 'args: an array of file paths',
  phases: [{ title: 'Find' }, { title: 'Verify' }],
}

const FINDINGS = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['line', 'issue'],
        properties: { line: { type: 'number' }, issue: { type: 'string' } },
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
if (files.length === 0) return 'Pass a list of file paths as args.'

const perFile = await pipeline(
  files,
  (file) => agent(`Review ${file} for correctness bugs only. Report each with its line.`,
                  { label: file, phase: 'Find', schema: FINDINGS }),
  async (found, file) => {
    const kept = []
    for (const f of found.findings) {
      const votes = await parallel([0, 1, 2].map((k) => () =>
        agent(`Try to REFUTE this finding in ${file} line ${f.line}: ${f.issue}`,
              { label: `${file} #${k}`, phase: 'Verify', schema: VERDICT })))
      const cast = votes.filter(Boolean)
      if (cast.filter((v) => !v.refuted).length >= 2) kept.push({ file, ...f })
    }
    return kept
  },
)
return perFile.filter(Boolean).flat()
```

If a stage's agent resolves to `null`, the next stage receives `null`. Here `found.findings` then
throws, and that throw turns the item into `null`, which the final `.filter(Boolean)` drops.
