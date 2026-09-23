# Parity spec: Claude Code dynamic workflows → opencode v2 plugin

Source of truth: Anthropic's Claude Code documentation, which this repository does not copy:

- [Dynamic workflows](https://code.claude.com/docs/en/workflows) (code.claude.com/docs/en/workflows)
- the Agent SDK TypeScript reference, `Workflow` tool section
  ([code.claude.com/docs/en/agent-sdk/typescript](https://code.claude.com/docs/en/agent-sdk/typescript))
- the Claude Code workflow-authoring reference (script API, summarized below)

Short quotations from those pages below are attributed to them; everything else is our own wording.

Every item has an ID. Each ID MUST have at least one test in `tests/parity/` whose name starts
with the ID (e.g. `test("P03 agent() with schema returns validated object", ...)`).
Status column: FULL = same behavior, DEGRADED = works with a documented limitation,
N/A = cannot be done as an opencode plugin (the reason is given in the Target column).
Install methods, env vars and the user-facing summary of DEGRADED/N/A items: `README.md`.

## Tool surface

| ID  | Behavior | Target | Test |
|-----|----------|--------|------|
| P01 | Tool named `workflow` with input `{script?, name?, scriptPath?, args?, resumeFromRunId?, title?, description?}`; at least one of script/name/scriptPath required; `scriptPath` takes precedence over `script` and `name`; `title`/`description` ignored | FULL | `tool-surface.test.ts` "P01 …" ×6 |
| P02 | Output shape `{status:"async_launched", taskId, taskType:"local_workflow", workflowName, runId, summary, transcriptDir, scriptPath, warning?, error?}`; returns immediately (background) | FULL | `tool-surface.test.ts` "P02 …" ×3 |
| P03 | A script failing its syntax/meta check returns `status:"async_launched"` WITH `error` set, and never runs | FULL | `tool-surface.test.ts` "P03 …" ×2 |
| P04 | Every invocation persists the script to a file and returns its path as `scriptPath`; re-invoking with that `scriptPath` runs the (possibly edited) file | FULL | `tool-surface.test.ts` "P04 …" ×3 |
| P05 | `args` is exposed verbatim as global `args` (arrays/objects as real JSON values); `undefined` when omitted | FULL | `tool-surface.test.ts` "P05 …" ×3 |
| P06 | On completion the final result is delivered to the parent session as a task notification (status completed/failed/stopped, result, usage: agent_count, tokens, duration) | FULL (via `session.synthetic`, live-verified in `tests/e2e/basic.test.ts`, note 1; a run stopped because opencode disposed the plugin (shutdown, plugin reload, location eviction) still notifies `stopped` with the reason and a resume hint, note 9) | `tool-surface.test.ts` "P06 …" ×5<br>e2e `basic.test.ts` (live) |

## Script format

| ID  | Behavior | Target | Test |
|-----|----------|--------|------|
| P10 | `export const meta = {...}` must be the FIRST statement and a pure object literal (no variables, calls, spreads, template interpolation); required `name`, `description`; optional `phases:[{title, detail?, model?}]`, `whenToUse` | FULL | `script-format.test.ts` "P10 …" ×8 |
| P11 | Non-literal meta → error for inline scripts; for saved workflows the `/<name>` command is dropped (not registered) | FULL | `script-format.test.ts` "P11 …" ×4 |
| P12 | Body is plain JS with top-level `await` and top-level `return` (return value = workflow result) | FULL | `doc-examples.test.ts` "P12 …" ×1<br>`script-format.test.ts` "P12 …" ×3 |
| P13 | `import`/`import()`/`require` → fails before the run starts | FULL | `script-format.test.ts` "P13 …" ×4 |
| P14 | TypeScript syntax (type annotations, interfaces, generics) → syntax error reported, run does not start | FULL (note 2) | `script-format.test.ts` "P14 …" ×4 |
| P15 | `Date.now()`, `Math.random()`, no-arg `new Date()` throw inside the script; `new Date(x)` with an argument keeps working | FULL (note 3) | `script-format.test.ts` "P15 …" ×5 |
| P16 | No filesystem, shell, network, or Node API access from the script | FULL (codemode interpreter) | `script-format.test.ts` "P16 …" ×3 |

## Script API

| ID  | Behavior | Target | Test |
|-----|----------|--------|------|
| P20 | `agent(prompt, opts?)` spawns one subagent; without schema resolves to its final text (string) | FULL (note 4) | `doc-examples.test.ts` "P20 …" ×1<br>`script-api.test.ts` "P20 …" ×2 |
| P21 | `opts.schema` (JSON Schema, root `{type:'object'}`) → resolves to the validated object; validated at the tool-call layer with retries; after `MAX_STRUCTURED_OUTPUT_RETRIES` (default 5) failed attempts the call THROWS an error including the last validation failure | DEGRADED (no forced tool choice; submit-tool + retries) | `doc-examples.test.ts` "P21 …" ×2<br>`script-api.test.ts` "P21 …" ×7 |
| P22 | Schema preflight: a provably self-contradictory schema (e.g. `required` key ruled out by `additionalProperties:false`, root not object) throws before the subagent starts | FULL | `script-api.test.ts` "P22 …" ×4 |
| P23 | `agent()` resolves to `null` when the agent is stopped/skipped mid-run or dies on a terminal API error | FULL | `script-api.test.ts` "P23 …" ×3 |
| P24 | `opts.label` sets the display label; `opts.phase` assigns the agent to a progress group explicitly (overrides current `phase()`) | FULL | `script-api.test.ts` "P24 …" ×2 |
| P25 | `opts.model` overrides the model (`provider/model` ref); default = the parent session's model | FULL | `script-api.test.ts` "P25 …" ×2 |
| P26 | `opts.effort` ('low', 'medium', 'high', 'xhigh', 'max') maps to a model variant when the model supports one; otherwise ignored with a warning | DEGRADED | `script-api.test.ts` "P26 …" ×3 |
| P27 | `opts.agentType` selects a custom agent (opencode agent id) | FULL (as opencode's own subagent tool: an unknown id, a primary-mode agent, or one the parent's `subagent` permission denies fails that agent → `null`; see P61) | `script-api.test.ts` "P27 …" ×1<br>`subagents.test.ts` "P61 …" (agentType cases) |
| P28 | `opts.isolation:'worktree'` runs the agent in a fresh git worktree, auto-removed if unchanged | FULL (opencode worktree API; note 5) | `script-api.test.ts` "P28 …" ×3 |
| P29 | `parallel(thunks)` runs concurrently, is a barrier, never rejects; a throwing thunk resolves to `null` | FULL | `script-api.test.ts` "P29 …" ×3 |
| P30 | `pipeline(items, ...stages)` runs each item through all stages with NO barrier between stages; each stage gets `(prevResult, originalItem, index)`; a throwing stage drops that item to `null` and skips remaining stages; result order = item order | FULL | `doc-examples.test.ts` "P30 …" ×1<br>`script-api.test.ts` "P30 …" ×4 |
| P31 | `parallel`/`pipeline` reject lists longer than 4096 items with an explicit error (no silent truncation) | FULL | `script-api.test.ts` "P31 …" ×2 |
| P32 | `phase(title)` starts a progress group; subsequent agent() calls are grouped under it | FULL | `script-api.test.ts` "P32 …" ×2 |
| P33 | `log(message)` emits a narrator line to the progress view | FULL | `script-api.test.ts` "P33 …" ×1 |
| P34 | `budget = {total, spent(), remaining()}`: `total` null when no target; `remaining()` = `max(0,total-spent())` or `Infinity`; hard ceiling: once `spent() >= total`, further `agent()` calls throw. Claude Code: `spent()` = output tokens spent this turn by the main loop and all workflows (one shared pool) | DEGRADED (note 7: the total is the tool's `budget` input; the pool is per run; the parent session's tokens are not counted; agents replayed on resume count 0) | `script-api.test.ts` "P34 …" ×5<br>`engine.test.ts` "P41 P34 …" ×1 |
| P35 | `workflow(nameOrRef, args?)` runs another workflow inline (name or `{scriptPath}`), returns its result, shares concurrency/agent counter/budget/abort; nesting one level only (throws inside a child); throws on unknown name / syntax error; `args` reach the child verbatim (explicit `null` stays `null`, omitted → `undefined`) | FULL | `script-api.test.ts` "P35 …" ×8 |
| P36 | Concurrent agents capped at `min(16, cpus-2)` (min 1) by default; env `OPENCODE_WORKFLOW_MAX_CONCURRENT_AGENTS` 1..256 overrides; excess calls queue | FULL | `script-api.test.ts` "P36 …" ×3 |
| P37 | 1000 agents total per run; the 1001st `agent()` throws | FULL | `script-api.test.ts` "P37 …" ×1 |

## Runs, journal, resume

| ID  | Behavior | Target | Test |
|-----|----------|--------|------|
| P40 | Each run has a `runId` and a transcript dir containing `script.js`, `journal.jsonl` (one `{type:"result", index, key, ...}` line per completed agent) and per-agent records | FULL | `runs-resume.test.ts` "P40 …" ×3 |
| P41 | `resumeFromRunId`: replay in agent START order; the longest unchanged prefix of completed agent() calls (same prompt+opts key) returns cached results; the first changed/failed/unfinished call and EVERY call after it runs live | FULL | `doc-examples.test.ts` "P41 …" ×1<br>`runs-resume.test.ts` "P41 …" ×7 |
| P42 | Resuming an unknown/empty run fails with a `nothing to resume` error instead of starting over | FULL | `runs-resume.test.ts` "P42 …" ×3 |
| P43 | Resume is refused while agents from the stopped run are still running | FULL | `runs-resume.test.ts` "P43 …" ×1 |
| P44 | Stopping the whole run does not count any agent as failed (running ones restart on resume) | FULL | `doc-examples.test.ts` "P44 …" ×1<br>`runs-resume.test.ts` "P44 …" ×2 |

## Management & UX

| ID  | Behavior | Target | Test |
|-----|----------|--------|------|
| P50 | `/workflows` lists running and completed runs with per-phase agent counts, token totals and per-phase elapsed time (agents outside every phase get a `(no phase)` group; a declared `meta.phases` entry that ended with 0 agents is hidden once the run finished); `/workflows <runId>` shows each agent's prompt and result | DEGRADED (text view, no interactive TUI tree; the agent detail has no recent tool calls or task list, and the prompt/result are shown as one clipped line; the full transcript is the child session, P74) | `management.test.ts` "P50 …" ×7 |
| P51 | Stop a whole run; stop a single agent (counts as failed → `null`) | FULL (`workflow_control` tool / command) | `management.test.ts` "P51 …" ×5 |
| P52 | Save a run's script as a command: project `.opencode/workflows/` or personal `~/.config/opencode/workflows/`; refuse to write through symlinks | FULL | `management.test.ts` "P52 …" ×6 |
| P53 | Saved workflows (project + personal; project wins on name clash; closest dir wins) run as `/<name>`; the rest of the line is handed to the model, which passes `args` as structured JSON when the workflow's description/`whenToUse` expects it (as Claude does), else as the string | FULL (the shaping is the model's, as in Claude Code; the prompt gives the raw line, `whenToUse` and the string fallback) | `doc-examples.test.ts` "P53 …" ×1<br>`management.test.ts` "P53 …" ×5 |
| P54 | Bundled `/deep-research` workflow | FULL (plugin-specific hardening: a skeptic whose web tools fail returns `couldNotCheck` and abstains instead of refuting; researchers without web access reply `NO_WEB_ACCESS` and the run stops early with a setup hint when at least half do) | `doc-examples.test.ts` "P54 …" ×4<br>`management.test.ts` "P54 …" ×3 |
| P55 | Large-workflow warning when > 25 agents scheduled (or the chosen size guideline's count, P70) | FULL (logged + in status; note 6) | `management.test.ts` "P55 …" ×2 |
| P56 | Approval prompt showing phases before the run | DEGRADED (plugins cannot ask; rely on opencode permission rules for the `workflow` tool) | `management.test.ts` "P56 …" ×3 |
| P57 | Disable switch: env `OPENCODE_DISABLE_WORKFLOWS=1` (or plugin option `disabled:true`) removes the tool and commands | FULL (the option needs a config install, `"plugins": [{"package": "file:///<repo>", "options": {"disabled": true}}]`, verified live; loader files in a `plugins/` dir always get empty options, so there only the env var works; README) | `management.test.ts` "P57 …" ×3 |
| P58 | Workflow-authoring reference available to the model (tool description + `/workflow-authoring` command/skill), including that `meta.phases` only labels groups and `phase()` (or `agent({phase})`) assigns agents to them | FULL | `management.test.ts` "P58 …" ×5 |
| P59 | `meta.whenToUse` is surfaced: in the `/<name>` command description and in the `workflow` tool description, which lists every saved and bundled workflow (name, origin, description, whenToUse) and is rebuilt when the saved workflows change | FULL | `management.test.ts` "P59 …" ×3 |

## Subagent semantics

| ID  | Behavior | Target | Test |
|-----|----------|--------|------|
| P60 | Workflow agents cannot themselves launch workflows (the `workflow` tool is denied in child sessions) | FULL | `subagents.test.ts` "P60 …" ×2 |
| P61 | Child sessions inherit the parent's permission rules (and permission mode: Plan mode carries through) | DEGRADED (copied at create; no parentID. The child runs as the parent's current agent (tool `ctx.agent`, else `Session.Info.agent`), so agent-level rules such as Plan mode's edit deny apply; with a different `agentType` the parent agent's deny/ask rules are appended after that agent's rules, its allow rules are not. The parent's session rules are copied verbatim. A `subagent` rule that evaluates to "ask" is treated as allowed, since launching the workflow was itself permission-gated and plugins cannot ask) | `subagents.test.ts` "P61 …" ×8 |
| P62 | Child sessions are tagged (title prefix + metadata `{workflowRunId}`) so they are identifiable | DEGRADED (no parent nesting in opencode's public API) | `doc-examples.test.ts` "P62 …" ×1<br>`subagents.test.ts` "P62 …" ×2 |
| P63 | A workflow agent's permission prompts reach the user; a skipped/stopped agent returns `null`, so a run always finishes | DEGRADED (note 8: a plugin child has no parentID, so opencode never shows its prompts. Instead the `question` tool is denied in every child, and a `permission.hook("evaluate")` turns any "ask" in a session tagged `workflowRunId` into "deny" with an explanation, so the agent carries on without it instead of waiting forever) | `subagents.test.ts` "P63 …" ×3 |

## Other Claude Code behaviors

| ID  | Behavior | Target | Test |
|-----|----------|--------|------|
| P70 | Size guideline (`unrestricted`/`small`/`medium`/`large` → aim for < ∞/5/10/50 agents), sent to the model as advice; default `medium`; a value the user chose replaces the 25-agent Large-workflow threshold | FULL (set with plugin option `sizeGuideline` or env `OPENCODE_WORKFLOW_SIZE_GUIDELINE` instead of `/config workflowSizeGuideline`; the Pro-plan `small` default does not apply) | `cc-extras.test.ts` "P70 …" ×4 |
| P71 | Fan-out prefix stagger: agents sharing the first agent's prompt-cache prefix are held until its response begins, capped at `CLAUDE_CODE_WORKFLOW_PREFIX_STAGGER_MS` (5000) | DEGRADED (not implemented: all agents start at once. Cache sharing between opencode child sessions is provider-specific, and the public API has no "response began" event, only session polling) | `cc-extras.test.ts` "P71 …" ×1 |
| P72 | Plugin-namespaced workflows (`/<plugin>:<name>` from a plugin's `workflows/` dir) | N/A (opencode plugins have no `workflows/` component and the plugin API cannot enumerate other plugins' roots; workflows load from project, personal and bundled dirs only) | `cc-extras.test.ts` "P72 …" ×1 |
| P73 | Restart one running agent (`r` in `/workflows`) | DEGRADED (no restart action. Use `stop_agent` (the agent counts as failed and `agent()` returns `null`), or stop the run and relaunch with `resumeFromRunId`: that agent and every later one run again) | `cc-extras.test.ts` "P73 …" ×1 |
| P74 | Each agent's full transcript can be opened from the run view | DEGRADED (the transcript is the agent's opencode child session, tagged `[wf:<runId>]` (P62); `agents/<i>.json` in the transcript dir holds its prompt, result, usage and that `sessionID`, and `/workflows <runId>` shows prompt and result as one clipped line) | `cc-extras.test.ts` "P74 …" ×1 |
| P75 | Run management (status, stop, stop one agent, pause/resume, save, `/workflows <runId>`) only acts on the current session's own runs | FULL (another session's run, live or on disk, answers "not found in this session", the same as an unknown id, so ids cannot be probed) | `cc-extras.test.ts` "P75 …" ×2 |
| P76 | `scriptPath` (tool input and `workflow({scriptPath})`) only reads files the session may read | DEGRADED (plugins cannot ask the user, so the plugin evaluates opencode's rules itself and "ask" counts as refused: a file whose real path (links resolved) is outside the project dir, this session's run store and the personal workflows dir needs an `external_directory` allow rule for its directory; a `read` deny refuses any file; UNC/device paths are refused before any file access. Nothing is copied into the run dir when refused) | `cc-extras.test.ts` "P76 …" ×7 |
| P77 | Single delivery path: a run's result reaches the parent model only as the task notification (Claude Code has no model-facing status tool that returns it). After launching, the model ends its turn and does not poll, sleep or shell-wait | FULL (`workflow_control` status/list exist for when the user asks about progress, but they never include the run's result or per-agent result previews. For a running/paused run they tell the model to end its turn; for a finished run they say the result is delivered as the task notification (end the turn if not received yet) and point to `<transcriptDir>/run.json`. The user-facing `/workflows <runId>` always shows the result. The `workflow` tool description, its launch `summary`, the `workflow_control` description and the authoring reference all say to end the turn after launching; note 10) | `delivery.test.ts` "P77 …" ×6 |
| P78 | Workflow subagents know they run non-interactively inside a script: nobody answers questions, and their final message is returned verbatim to the script as data | FULL (every plain child prompt starts with `SUBAGENT_PREAMBLE` (`src/opencode/runner.ts`): no human, no questions or confirmations (assume and continue), final message = only the requested content in the requested format, assumptions only if that format has room, no workflows. Schema agents get `STRUCTURED_SUBAGENT_PREAMBLE` (the `workflow_submit` call is the answer; no "final text answer" wording) and the `workflow_submit` instructions after the task. The resume key (P41) hashes the script's own prompt, so adding the preamble does not change it; the resume-key test is a regression guard, it passed before P78 too) | `subagents.test.ts` "P78 …" ×4 |

## Test evidence

`npm run test:parity` (`bun test tests/parity`) runs 221 tests in 10 files, and all pass. They
enter at the highest level possible: the plugin's `setup()` over a fake opencode v2 Context
(`tests/helpers/plugin-harness.ts`), then the `workflow` and `workflow_control` tools
(`execute`), the slash commands, and the `<task-notification>` delivered through
`session.synthetic`.

- Agents run through the `FakeRunner` (`tests/helpers/fake-runner.ts`).
- Tests of opencode-specific behavior (P20–P28, P60–P62) use `{ real: true }`. This runs the
  real `src/opencode/runner.ts` against the fake session, worktree and model APIs, and schema
  agents submit through the plugin's real `workflow_submit` tool.
- `tests/parity/coverage.test.ts` fails if any ID in this file has no test whose name starts
  with that ID.
- The doc examples run verbatim in `doc-examples.test.ts`: the `audit-routes` script, the
  bundled `/deep-research`, and the resume case where A, B (fails), C and D start in that order,
  in `runs-resume.test.ts`.

The parity suite exposed two bugs, both now fixed:

- **store** (`src/store.ts`): the writes to run.json, agents/<i>.json, journal.jsonl and
  script.js awaited `runDir()` and `mkdir()` before joining their per-file queue. A stale
  `running` agent record could therefore land after the final `completed` one. P40 now has a
  regression test, and the unit test "P40 every finished agent is journaled…", which used to be
  flaky, is stable.
- **engine** (`src/engine.ts` `onAgentUpdate`): runner `warnings` (P26) and a kept `worktree`
  (P28) were dropped, so the AgentRecord and the status view never showed them.

Review fixes (unit tests in `tests/unit/journal.test.ts` and `tests/unit/engine.test.ts`):

- **store, Windows**: an atomic write (tmp file + rename) failed with EPERM whenever another
  handle had run.json or agents/<i>.json open, for example the host listing runs, a
  `/workflows` view, an antivirus or an indexer. The engine drops store errors, so the final
  `completed` summary could be lost, and the run then showed as interrupted with no result. The
  rename is now retried with backoff on EPERM/EACCES/EBUSY (about 1.5 s in total, the approach
  graceful-fs uses), and `settled()` retries the final run.json write up to 3 times.
- **engine** (`finish()`): the summary that `result()` delivers as the task notification was
  built before the agents the script left unawaited had settled after the abort, so it
  under-reported tokens and showed those agents as `running`. `finish()` now waits up to
  `finishGraceMs` (default 2 s) for aborted agents to settle before it builds that summary.
  The wait is bounded so an agent that ignores its abort cannot hold back the notification.
  `settled()` still rewrites run.json with the fully settled summary.

### Notes on targets

1. **P06**: the notification is `session.synthetic({resume:true, delivery:"queue"})`. Verified
   live on opencode 2.0.15 (`tests/e2e/basic.test.ts`, E2E.md gotcha 7): it wakes an idle parent,
   and the parent model answers the `<task-notification>` in a new turn. It is queued after the
   parent's current turn, not injected mid-turn. With `opencode run --standalone` the private
   server exits as soon as the parent turn goes idle, which kills the background run before it can
   notify; use a long-lived `opencode serve` / TUI session (E2E.md, "Why a server").
2. **P14**: annotations, interfaces, generic declarations and `as` casts are rejected statically.
   TypeScript that also parses as JavaScript, such as `agent<string>('x')` (which parses as two
   comparisons), fails only at run time, with a ReferenceError.
3. **P15**: the guards keep scripts deterministic but are not a security boundary. For example,
   `new Date(0).constructor.now()` still reaches the native clock. `new` through an alias
   (`const D = Date; new D(0)`) fails with codemode's "cannot be constructed" error.
4. **P20**: an agent that ends with no text reply resolves to `null` (it is treated as failed)
   instead of `""`. This follows the rule to fail on empty replies.
5. **P28**: a worktree that is kept is reported in the agent record and the status view
   (`AgentRecord.worktree`); `agent()`'s return value is unchanged. A *schema* agent in a
   worktree needs the plugin to load in that worktree too (a global install or a committed
   `.opencode/`). Otherwise `workflow_submit` is missing there, and the run falls back to
   extracting JSON from the reply.
6. **P55**: only the agent-count trigger is implemented: more than 25 agents, or the agent count of
   a size guideline the user chose (P70). Claude Code also warns when the projected token total
   passes 1.5M; that trigger is not implemented. The warning is advisory and does not limit the
   run, which the tests check. Claude Code hides the warning when ultracode is on; this plugin has
   no ultracode switch.
7. **P34**: Claude Code's budget is one pool per turn, taken from the user's turn token target and
   shared by the main loop and every workflow. opencode has no turn token target, and a plugin
   cannot observe the parent session's spend as it happens, so here: `total` is the non-CC
   `budget` field of the `workflow` tool input, which the tool and authoring descriptions tell the
   model to set only when the user explicitly states a token budget (a live probe showed
   gpt-5.4-mini inventing one when the field was undocumented); `spent()` is the
   output + reasoning tokens of this run's agents, including nested `workflow()` children; two runs
   launched in the same turn each get their own pool; and agents replayed from the journal on
   resume count 0, because they cost nothing this turn.
8. **P63**: opencode shows (and `--auto` answers) permission asks and question forms only for the
   viewed session and its `parentID` family, and plugin-created children have no parentID. Verified
   live before this fix: a child reading `C:/Windows/win.ini` hung on a pending `external_directory`
   ask, and a child calling `question` hung on a pending form, each for as long as the run lived.
   Now `{action:"question", resource:"*", effect:"deny"}` is appended to every child's rules (after the
   inherited ones, so a parent allow cannot re-enable it), and every plugin instance registers
   `ctx.permission.hook("evaluate")`: an "ask" for a session whose metadata has `workflowRunId`
   becomes "deny" with the message "workflow agents cannot ask for approval…", which the model sees
   as the tool failure. Allow/deny results and other sessions are untouched. Limits: opencode runs
   that hook only for sessions in the plugin instance's own location, so an `isolation:'worktree'`
   child is guarded only when the plugin also loads in the worktree (a global install or a committed
   `.opencode/`; the same requirement as schema agents in worktrees, note 5). There is no default
   per-agent timeout: Claude Code has none, and the public API has no idle signal to base one on
   (`OPENCODE_WORKFLOW_AGENT_TIMEOUT_MS` still sets one).
9. **P06 on dispose**: opencode disposes a plugin instance on shutdown, and also on a live server
   when any plugin that sorts before it is added or updated, when a pending npm plugin install
   finishes, or when the location is evicted after 60 minutes without session events
   (`core/src/location-activity.ts`). `WorkflowHost.dispose()` stops each run with the warning
   "stopped because the workflow plugin was unloaded …" and waits (bounded, 5 s) for its `stopped`
   notification, which carries the `resumeFromRunId` hint. To avoid the eviction case, while a run is
   active the host touches its parent session every 20 minutes by renaming it to its current title
   (`ctx.session.update`, a durable `Session.Renamed` event that refreshes the location's idle
   timer). Without this, a paused run, or one whose live agents all run in worktrees (other
   locations), produced no event in the parent's location. The eviction and the keep-alive event were
   checked in opencode's source, not live (the timeout is 60 minutes).
10. **P77**: found in a live demo (parent `openai/gpt-5.4-mini`): right after launching, the model called
   `workflow_control` status three times and a shell `Start-Sleep` within 14 s. Once the run
   completed, status returned the full result, the model answered with it, and then the
   `<task-notification>` woke the session and it answered a second time. A first fix withheld the
   result only until `session.synthetic` resolved, but with `delivery: "queue"` that only means the
   notification entered the parent's inbox; the model reads it after its current turn, so a status
   call later in the same turn would still have returned the result. The plugin cannot observe when
   the model reads the notification, so model-facing status/list now never include the run's result
   (or per-agent result previews), matching Claude Code. For a finished run, status points to
   `<transcriptDir>/run.json`, which keeps the full result (for example after context compaction).
