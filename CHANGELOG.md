# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Until 1.0.0, minor versions
may contain breaking changes.

## [Unreleased]

### Added

- **Steering at the idle boundary** (opencode 2.3+, X22). A message to an agent that is finishing
  its turn is read in that same turn through opencode's `experimental.idle` hook: no wake-up, no
  extra turn. A message that arrives after that is refused `finishing` instead of being parked
  unread. Worktree agents, a hook timeout and opencode without the hook keep the 0.2 path.
- **Schema nudge** (opencode 2.3+, X23). A schema agent that stops without calling
  `workflow_submit` is nudged in the same turn. Nudges count against
  `MAX_STRUCTURED_OUTPUT_RETRIES`, shared with the runner's re-prompts.
  `OPENCODE_WORKFLOW_IDLE_HOOK=0` turns the hook off.
- **`workflow_script`** (opencode 2.3+, X24): a freeform tool that takes a new inline script as raw
  text (no JSON escaping) on models whose capabilities list freeform text; it is removed from
  requests for other models. It shares the `workflow` permission key, so every deny of `workflow`
  covers it; the `workflow` tool is unchanged. Turn it off with `freeformTool: false` or
  `OPENCODE_WORKFLOW_FREEFORM=0`.
- **TUI agent dialog** (X25): `<leader>j` opens one searchable list of running agents. Enter
  steers, `ctrl+u` sends an urgent message, `ctrl+d` stops, `ctrl+o` opens the child session.
- **TUI sidebar section** (X26): a Workflows summary in the session sidebar (foldable when there
  are more than two runs); a child session shows its parent's runs.
- **Desktop app companion** (experimental, opencode 2.3 GUI plugin API; X28–X30), shipped as
  `./gui-experimental` → `dist/gui-experimental.cjs`: a composer pill with the session's active
  runs (warning when paused, danger when an agent failed), the live progress tree as a side panel
  (open, pause/resume, stop, message, urgent message; this session or the whole project), and one
  system notification per finished run across windows. The plugin must be listed in
  `opencode.json(c)`; build-only devDependencies `vite` and `vite-plugin-solid` were added.

### Fixed

- **Background subagents** (opencode 2.3, X31). opencode's `subagent` tool now always runs in the
  background; an agent that launches one returns the answer it gives after the subagent reports,
  not "I launched a subagent". A schema agent no longer spends a retry while its subagent runs,
  and a worktree a running job may still use is kept. The wait ends on stop or the agent timeout
  (30 min cap with a warning). Background shells are not waited for.
- Steering messages are no longer refused for the rest of an agent's turn when another plugin or a
  user prompt keeps the agent working.
- A late structured-output nudge no longer uses up an extra retry; parallel or cross-instance
  `workflow_submit` calls no longer lose an attempt or bring back a finished agent's state.
- Failed agents report opencode 2.3's actual error instead of "agent session failed (terminal error)".
- After an urgent message whose follow-up turn produced no text, the result no longer falls back to
  the cut-off text of the interrupted step.
- The tree's resync driver no longer updates a disposed view when a pending `list` answers.
- Cancelling a `workflow` tool call while its `scriptPath` approval prompt is open withdraws the
  prompt and starts no run (opencode rejects every prompt open in that session at that moment).
- A deny rule on any spelling of a `scriptPath` directory (for example through a symlink) refuses
  it, even when another spelling is allowed (P76).
- `workflow({scriptPath})` inside a running script can no longer wait forever on a prompt that
  another plugin's permission hook re-opened: after 3 s it is refused and the prompt withdrawn.
- TUI cold start on opencode 2.3 (X27): the tree retries its first list while plugins load and
  starts over on `plugin.updated`, instead of staying empty until a run starts.

### Changed

- A `scriptPath` that needs approval now raises opencode's own permission prompt on the `workflow`
  tool call (`ctx.permission.assert`) and honours saved "always" approvals, instead of being
  refused. A plain rejection ends the step. `workflow({scriptPath})` inside a running script still
  never prompts: only allow rules and saved approvals admit it.
- TUI internals: global commands are registered at setup, `setup` is typed, the 500 ms target
  poll is a reactive effect, and the host-agnostic tree logic lives in `src/client/` (shared with
  the desktop companion; no `process` reference, so it runs in a browser).

- **Requires opencode 2.3.0** (was 2.0.15). `@opencode/*` 2.3.0, `effect` 4.1.0 (the version
  codemode 2.3.0 needs; older pins crash every run), and the TUI is built with OpenTUI 0.8.4 and
  solid-js 1.9.17 (opencode 2.2+ refuses TUI plugins built for older OpenTUI). Use 0.2.x on 2.0.15.
- Directory installs (`"plugins": ["file:///<repo>"]`) now load the built `dist/`: opencode 2.3
  resolves a directory through its `package.json` `exports`. Run `npm run build` first. The root
  `server.ts` and `tui.tsx` shims are gone.
- Scripts run on codemode's new bytecode VM (much faster CPU-bound code). `this`, `bind`/`call`/`apply`,
  `Object.freeze` and `WeakMap` now work; the authoring guide says so.

### Security

- Determinism guards (P15) could be bypassed on codemode 2.3.0, which added a global `require(name)`
  and `import(name)` returning the native globals (`const r = require; r("Math").random()`). The
  sandbox now hides `require` and rejects `import()` in the body syntax check. `crypto.randomUUID()`
  and `crypto.getRandomValues()` (another source of nondeterminism, also on 2.0.15) now throw.

## [0.2.0] - 2026-09-24

### Added

- **Per-agent outputs** (`workflow_control` `result`, an extension; PARITY X21). For a finished run
  (completed, failed or stopped, also after a resume or a plugin reload), `{action: "result", runId}`
  lists every agent, one line each: failed, stopped and `null` ones first, with a preview of the
  return value or the error, 50 per page. `agent: "3"` (or `"#3"`, or an exact label) shows one agent
  in full: status, phase, nested workflow, whether it was replayed from an earlier run, model, child
  session, usage, duration, prompt, error, warnings and steering messages, then its whole return
  value, 50,000 characters per page. `offset` takes the next page from the footer. While a run is
  going it returns the status note unchanged, so it cannot show partial output. The model reads no
  files for this, so there are no `external_directory` prompts.
- **Agent failure summary in the notification** (an extension; X20). `<agent-failures>` lists up
  to 10 agents whose `agent()` returned nothing (failed, stopped, still running, or a `null` value),
  one line each with the first line of the error, and says whether `agent()` threw (schema) or the
  agent belonged to a nested `workflow()`. The whole block is capped at 2,800 bytes of UTF-8 (lines
  that would overflow join the "… and K more" count), so it stays under 3 KB even for 1000 failed
  agents with long non-ASCII labels and errors. A failed
  run with no failed agent says the error came from the script (including `agent()` calls refused
  before an agent started).
- **Diagnostics pointer in the notification** (P79, adapted from Claude Code). `<diagnostics>` tells
  the model to check the agents with `workflow_control` `result` BEFORE diagnosing an empty or
  unexpected result, and not to read the transcript files with shell commands. Claude Code points at
  `journal.jsonl`; here that file is outside the project (a permission prompt per read) and opencode's
  `read` cuts its long lines. The `workflow` tool description gains a PER-AGENT OUTPUTS paragraph.
  The bake-off behind this design is in `docs/design/agent-output-access.md`.
- From the 2nd `workflow_control` status or `result` call on a run since it last changed state, the
  reply adds "Repeating this call does not wait or speed anything up." (P77).
- **Steering a running agent** (an extension beyond Claude Code; PARITY X01–X09). Send an instruction
  to a running workflow agent without restarting it: `/workflows msg <runId> <target> <text>` (user),
  or `workflow_control` with `action: "message"` (the parent model, when you ask). Targets: an agent
  index (`3`/`#3`), an exact label, `@phase` or `*`. The agent reads the message at its next step
  boundary, and its `agent()` result is its reply after the message; a message that arrives as the
  agent finishes is still answered. `msg!` / `urgent: true` also interrupts the current step (its
  tokens are lost). Messages to a queued agent are held and added to its first prompt. Messages are
  journaled; a steered agent is never reused on resume, so it and every later agent run again.
  `/workflows <runId>`, `agents/<i>.json` and the task notification (`<steering>`) show them.
- **Live progress tree in the TUI** (an extension; PARITY X10–X16). `ctrl+x o` (or `/wf`) opens a
  panel with the session's runs → phases (model label, counts, tokens, elapsed) → agents (status,
  tokens, elapsed, the model it runs on, and what each running agent is doing right now). Enter
  opens an agent's child session, `x` stops an agent or the run after a confirmation, `p`
  pauses/resumes, `m`/`M` sends a message (steering), `a` switches between this session's runs and the whole project. The prompt
  footer shows `wf <name> <done>/<total> · <tokens> · $<cost>`. A finished run sends a desktop
  notification when the terminal is unfocused (with `attention.notifications` in `cli.json`), or a
  toast. The package gains a `./tui` export (`dist/tui.js`, precompiled; no new runtime
  dependencies) and the repo a root `tui.tsx` for directory installs.
- **`dynamic-workflows` RPC** (X12, X13): `list`, `status` and `control` over opencode's server API
  (`POST /api/rpc/dynamic-workflows/<method>`), and `delta` (at most 4 per second) / `finished`
  events on `/api/event`. The TUI uses it; scripts and other clients can too.
- **Phase model labels** (X10): the `model` of a `meta.phases` entry is now shown next to the phase
  in `/workflows`, `/workflows <runId>`, `workflow_control` status/list, run.json and the tree, as
  Claude Code shows it. It is a label only: agents still take their model from `agent(…, {model})`.
- **Live agent activity** (X11): `/workflows <runId>` shows, for each running agent, its last tool
  call or the last words it wrote and its live tokens/cost. `workflow_control status` shows the tool calls but only `writing…` / `thinking…` for text, so the
  model never gets a partial result (P77). Display only: recorded usage and `budget.spent()` are
  unchanged.
- **The model each agent actually runs on** (X18, X19). Each agent records its model as
  `provider/model#variant` (the variant only when set; opencode's `default` variant counts as none):
  the child session's model as opencode reports it, else the requested one (`opts.model`, else the
  parent session's model, plus the `effort` variant). It is saved in `agents/<i>.json` (`model`) as
  soon as the child session exists and on the journal result line, and a cached agent keeps it on
  resume (older journals take it from the old run's agent record). If opencode runs the agent on
  another model than requested, the agent gets the warning
  `model: requested X but the agent runs on Y`. Shown as a `model:` line per agent in
  `/workflows <runId>` and `workflow_control` status, in the RPC agent views and on the tree's agent
  rows (shortened when the panel is narrow: provider first, then variant). A phase without a
  `meta.phases[].model` label shows the model its agents share (`agentModel` in run.json).
- **Read-only RPC switch** (X17): `OPENCODE_WORKFLOW_RPC_CONTROL=0` or the plugin option
  `rpcControl: false` keeps the tree live but refuses its stop, pause and message actions.
- Docs: the design (`docs/design/steering-and-live-tree.md`), PARITY rows X01–X19, the TUI live
  check in `docs/E2E.md`, opencode API notes on steering, RPC and the TUI, and README sections with
  new screenshots (live tree, message dialog, narrow panel, stop, finished run).

### Changed

- A failed run's notification no longer reads as an order to relaunch: its `<result>` ends with
  "To retry (only if the user asks for it): …". Models relaunched failed runs unasked (P06).
- Model-facing `workflow_control` status of a finished run no longer points to
  `<transcriptDir>/run.json`. That line sent models to read files outside the project, which raises a
  permission prompt each time (P77).
- Agent records (`agents/<i>.json`) gain `workflow` (the nested `workflow()` that started the agent),
  `threw` (a schema agent whose `agent()` threw) and `cachedFrom` (the run a cached agent was replayed
  from).
- `/workflows`: phase lines show how many agents are running, and the run line shows the cost.
- Both subagent preambles (P78) now say that `<orchestrator-message>` blocks may arrive while the agent
  works. Resume keys are unchanged.
- `journal.jsonl` can contain `{"type":"message"}` lines, and a result line can carry `steered: true`
  and `model`. Readers that only know `result` lines (0.1.0) skip them. Agent keys, and so resume,
  are unchanged.
- `/workflows <runId>`: the `now:` line of a running agent no longer ends with `· model: …`; the new
  per-agent `model:` line replaces it.
- run.json records the project directory (`directory`) that started the run. The RPC only serves
  runs of its own project, so runs from 0.1.0 (without it) do not appear in the tree; `/workflows`
  still lists them.

### Fixed

- A failed run whose error already started with `Error:` showed `Error: Error: …` in the notification.
- `meta.phases[].model` was validated and then dropped: the phase label a script declared never
  appeared anywhere (X10).
- Pre-release fixes to the new features, from a review and a live verification:
  - A steering message that missed the agent's turn could start a turn after the agent's result was
    read; nobody read that turn and its tokens were not counted. Messages are now sent with
    `resume:false`, and the plugin itself starts the turn that reads a late message (X03).
  - A message whose delivery id was unknown was reported `undelivered` after a 2 s wait, with a
    warning, even when it had been delivered (X03).
  - After the server plugin restarted (reload, idle eviction), the tree ignored every update of a new
    run until you switched sessions; a slow resync could also show a finished run as running again
    (X13, X15).
  - The RPC could read and control runs of other projects in the same opencode process (X12).
  - Tree rows and the footer lost their middle when too long (cost, elapsed time, progress); they are
    now shortened from the least useful part (X14, X15).
  - `<orchestrator-message>` escaping missed look-alike characters and other tags (X09); control
    characters are stripped from the tree's text (X11); RPC and tool string inputs are size-bounded;
    a failed setup no longer leaves the RPC registered; a notification fires once per run (X16).
  - The urgent (`msg!`) reply said the message would be read at the next step boundary (X08).
  - A `workflow` call reaching a plugin instance that opencode had just reloaded started a run that
    nothing could control; it is now refused (P06).

## [0.1.0] - 2026-09-23

First public release. Requires **opencode 2.0.15** exactly (other versions are untested).

### Added

- **`workflow` tool.** The model writes a plain-JavaScript orchestration script (inline `script`,
  a saved workflow `name`, or a `scriptPath`), and the tool launches it in the background, returning
  `{status: "async_launched", taskId, runId, transcriptDir, scriptPath, ...}` immediately.
- **Script API**, matching Claude Code's workflow tool: `agent(prompt, opts)` with `schema`
  (validated structured output with retries), `label`, `phase`, `model`, `effort`, `agentType` and
  `isolation: 'worktree'`; `parallel()`; `pipeline()` (no barrier between stages); `phase()`;
  `log()`; `budget` (hard per-run token ceiling); `workflow()` (run another workflow inline, one
  level deep); `args`; top-level `await`/`return`; `export const meta = {...}` with `phases` and
  `whenToUse`.
- **Sandboxed execution** in opencode's codemode interpreter: no filesystem, network, shell,
  `import`/`require`, and deterministic guards on `Date.now()`, `Math.random()` and `new Date()`.
- **Background runs with task notifications.** When a run completes, fails or is stopped, its
  result and usage (agent count, tokens, duration) are delivered to the parent session as a
  `<task-notification>` that wakes the idle parent. The result has a single delivery path.
- **Journal and resume.** Every run gets a transcript dir (`script.js`, `journal.jsonl`,
  `run.json`, `agents/<i>.json`). `resumeFromRunId` replays the longest unchanged prefix of
  completed `agent()` calls from cache and runs the rest live.
- **Saved workflows.** Project (`.opencode/workflows/`) and personal
  (`~/.config/opencode/workflows/`) scripts run as `/<name> <args>`; `whenToUse` is surfaced in the
  command and tool descriptions. Saving never writes through symlinks.
- **Bundled `/deep-research` workflow**: plans research angles, runs web researchers, extracts
  claims, cross-checks each claim with 3 skeptics and writes a cited Markdown report.
- **`/workflows`** command: lists this session's runs with per-phase agent counts, tokens and
  elapsed time; `/workflows <runId>` shows one run agent by agent.
- **`/workflow-authoring`** command: the script API reference for the model.
- **`workflow_control`** tool: `list`, `status`, `stop`, `stop_agent`, `pause`/`resume` and `save`,
  scoped to the current session's runs.
- **Safety defaults**: launching is opt-in (`ultracode`, "use a workflow", or a workflow command);
  child sessions inherit the parent's permission rules, cannot launch nested workflows, and have
  "ask" rules turned into "deny"; `scriptPath` only reads files the session may read.
- **Configuration**: `OPENCODE_DISABLE_WORKFLOWS`, `OPENCODE_WORKFLOW_MAX_CONCURRENT_AGENTS`,
  `MAX_STRUCTURED_OUTPUT_RETRIES`, `OPENCODE_WORKFLOW_AGENT_TIMEOUT_MS`,
  `OPENCODE_WORKFLOW_SIZE_GUIDELINE`, `OPENCODE_WORKFLOW_DATA_DIR`, plus the `disabled` and
  `sizeGuideline` plugin options.
- **Parity suite**: every behavior in `docs/PARITY.md` has an ID and at least one test in
  `tests/parity/`. Opt-in live end-to-end suite against the real opencode 2.0.15 CLI
  (`OPENCODE_E2E=1`, see `docs/E2E.md`).

### Known limitations

Compared with Claude Code (details and status per item in `docs/PARITY.md`):

- Structured output has no forced tool choice; agents submit through a `workflow_submit` tool with
  validation retries (P21).
- `effort` maps to a model variant only when the model has one (P26).
- `budget` is a per-run pool; the parent session's tokens are not counted (P34).
- `/workflows` is a text view delivered on the next turn, not an interactive tree (P50).
- No approval prompt before a run; gate the `workflow` tool with opencode permission rules (P56).
- Child sessions are tagged (`[wf:<runId>]`) rather than nested under the parent, and permission
  rules are copied at creation (P61, P62); permission prompts from agents are denied instead of
  shown (P63).
- No fan-out prefix stagger (P71), no plugin-namespaced workflows (P72), no single-agent restart
  (P73).
- A run launched with `opencode run --standalone` dies when the process exits; use the TUI or
  `opencode serve`. After a hard crash, suspended child sessions and `wf-<runId>-<i>` worktrees are
  not cleaned up automatically.

[Unreleased]: https://github.com/rphang/opencode-workflows/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/rphang/opencode-workflows/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/rphang/opencode-workflows/releases/tag/v0.1.0
