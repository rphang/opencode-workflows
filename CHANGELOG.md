# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Until 1.0.0, minor versions
may contain breaking changes.

## [Unreleased]

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

[Unreleased]: https://github.com/rphang/opencode-workflows/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/rphang/opencode-workflows/releases/tag/v0.1.0
