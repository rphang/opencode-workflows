# Live end-to-end tests (opencode 2.0.15)

`tests/e2e/` drives the **real** opencode 2.0.15 CLI against the plugin, with real model calls.
These tests are opt-in: they cost money (about $0.20 per full run) and take about 2 minutes.

```sh
OPENCODE_E2E=1 npx bun test tests/e2e --timeout 600000       # everything (OPENAI_API_KEY must be set)
OPENCODE_E2E=1 npx bun test tests/e2e/stop.test.ts --timeout 600000
npx bun test tests/e2e/harness.test.ts                          # offline harness tests, always run
```

Without `OPENCODE_E2E=1` (or without `OPENAI_API_KEY`), the live suites are skipped. Only the
offline `harness.test.ts` runs. The opt-in exists because a bare `bun test` at the repo root would
otherwise pick these files up and spend money.

Optional env: `OPENCODE_E2E_MODEL` sets the parent model (default `openai/gpt-5.4-mini`).
`OPENCODE_E2E_BIN` sets the CLI binary.

## How the harness works (`tests/e2e/harness.ts`)

- **Isolation.** Every process gets `XDG_DATA_HOME/CONFIG/STATE/CACHE` under `.sandbox/e2e-*`, so
  your real opencode data is never touched. Run data (transcript dirs) ends up in
  `.sandbox/e2e-data/opencode/workflows/<sessionID>/<runId>/`. Worktrees end up in
  `.sandbox/e2e-data/opencode/worktree/`.
- **Project.** `createProject(name, files)` makes a fresh `git init` repo under
  `.sandbox/e2e-<name>-<ts>`. The plugin is loaded from
  `.opencode/plugins/workflows.js`, which contains one line:
  `export { default } from "<ABSOLUTE path>/src/index.ts"`. The loader is **committed**, so
  worktrees created by `isolation:'worktree'` load the plugin too (tools are registered per
  location; see OPENCODE-API-NOTES.md).
- **Long-lived server.** `startServer()` spawns `opencode serve --port 0 --hostname 127.0.0.1`
  with `OPENCODE_PASSWORD` set, then parses `server listening on <url>` from its output. The
  prompts are sent with `opencode run --server <url> --auto --format json -m <model> [--session id]`.
  The server log is written to `.sandbox/e2e-serve-<label>-<ts>.log`, and the last client output
  of each label to `.sandbox/e2e-last-run-<label>.log`.
- **Why a server.** `opencode run` returns as soon as the parent session goes idle. With
  `--standalone`, the private server dies at the same moment, and the background run dies with it.
  This was checked live: the process exited 7 s after launch, while `run.json` still said
  `"running"` and the agent was still `"running"`. No notification is ever sent. With `serve`, the
  run keeps going after the client exits, and its completion notification wakes the parent
  session inside the server.
- **Assertions.**
  - `parseRunEvents` / `workflowToolCalls` read the `--format json` event lines
    (`tool_use.part.state.{input,output}`; the output is the tool's JSON string).
  - The HTTP API (Basic auth `opencode:<password>`, header `x-opencode-directory`) is used to read
    the parent session's messages (`GET /api/session/:id/message`, 200 per page), its inbox, child
    sessions (`GET /api/session/:id`), the command list (`GET /api/command`), and plugin state
    (`GET /api/plugin`). It is also used to run slash commands
    (`POST /api/session/:id/command {name, text}`).
  - `readTranscript(dir)` reads `script.js`, `journal.jsonl`, `run.json` and `agents/*.json`.
  - `waitForNotification` polls for the `synthetic` message whose `metadata.workflowRunId`
    matches the run.
- **Retries.** `runPrompt` retries (`shouldRetryRun`) only when an attempt produced **no events at
  all** (the known startup stall), or when a turn in a **fresh** session called **no tool at all**
  (the model refused or ignored the prompt; seen live once with gpt-5.4-mini: "I can't help launch
  that workflow"). In both cases nothing ran, so a retry never delivers work twice.
- **Costs.** Every parent turn (`step_finish.cost`) and every run's child usage (`run.json`
  `usage.cost`) is appended to `.sandbox/e2e-costs.jsonl`.

## Gotchas found while building it

1. **`opencode run` uses `$PWD` before `cwd`** to choose the project directory
   (`packages/cli/src/run/run.ts`: `process.env.PWD ?? process.cwd()`). Git Bash exports `PWD`, so
   a spawned child inherits the *caller's* directory: no plugin is loaded and the model says it has
   no workflow tool. The harness sets `PWD` to the project dir.
2. **Spawn `opencode.exe` directly** (`node_modules/@opencode/cli/bin/opencode.exe`). The `.cmd`
   shim that npx uses on Windows mangles multi-line arguments; the model received only the first
   line of the prompt.
3. **`--server` requires the password** in `OPENCODE_PASSWORD` (or the legacy
   `OPENCODE_SERVER_PASSWORD`) on both the server and the client.
4. **Plugins load lazily per location.** The first `GET /api/command` for a new directory returns
   `data: []`, and the plugin appears about 1 s later. `waitForPlugin()` polls `GET /api/plugin`
   until `dynamic-workflows` is `active`.
5. **`GET .../message?limit=` is capped at 200.** Pages are followed with `cursor.next`.
6. **`session.synthetic({resume:false})` on an idle session is not delivered right away.** It is
   admitted to the session **inbox** (`GET /api/session/:id/inbox`, `delivery:"steer"`) and becomes
   a message on the next turn. opencode's own `!shell` results use the same mechanism
   (`core/src/session/session.ts`). So `/workflows` and `/workflow-authoring` output is *pending* in
   an idle session. The harness's `syntheticEntries()` reads both the message list and the inbox.
   This settles open question (b) from the plugin notes.
7. **`session.synthetic({resume:true, delivery:"queue"})` does wake an idle parent** (open question
   (a) from the plugin notes). The task notification appears as a `synthetic` message with the
   metadata `{workflowRunId, workflowTaskId, status}`, and the parent model answers it in a new turn.

## What is covered (live)

| File | Test | PARITY IDs |
|------|------|------------|
| `basic.test.ts` | Inline script: `parallel` of 3 agents, then a 2-item `pipeline`, then a schema agent. Checks the tool output shape; that the launch returns before the notification; that the notification arrives with `status`, `result`, `usage` (`agent_count` 6, tokens, duration) and wakes the parent; the transcript dir (`script.js` equals the input, 6 journal lines `{type:"result", index, key(sha256), status, sessionID}`, `agents/0..5.json`, `run.json` phases Fan 3/3, Pipe 2/2, Shape 1/1, logs); and child session tagging (title `[wf:<runId>]`, metadata `workflowRunId`, `parentSessionID`). | P02 P06 P40 P20 P21 P29 P30 P32 P33 P62 |
| `basic.test.ts` | A script with `import` and a TS annotation returns `async_launched` with `error`, a `scriptPath`, and no `run.json`, journal or agents. | P03 P13 P14 P04 |
| `resume.test.ts` | Run 1 goes through a relative `scriptPath`. The file is then edited (call 2 changed, call 3 added) and relaunched with `resumeFromRunId`. Call 0 is `cached` with the identical value and no new session; calls 1 and 2 run live; the new run has a new id and its journal holds all 3 results. Then `resumeFromRunId:"wf_doesnotexist…"` fails with `nothing to resume` and runs nothing. | P41 P42 P04 |
| `nesting.test.ts` | A child agent is told to call `workflow` if it has it. Its session has deny rules for `workflow`, `workflow_control` and `workflow_submit`; it makes no workflow tool call; no run dir exists for it; it answers `NO_WORKFLOW_TOOL`. | P60 |
| `saved.test.ts` | `.opencode/workflows/greet.js` runs by `name` with `args:"bob"`. `/e2e-greet alice` (the command API) runs it with `args` set to the rest of the line. The command list has `e2e-greet`, `workflows`, `workflow-authoring` and `deep-research`, and does not have a non-literal-meta file. `/workflows` lists both runs, and `/workflows <runId>` shows one run. | P53 P05 P11 P50 P54 |
| `worktree.test.ts` | Two `isolation:'worktree'` agents run in `wf-<runId>-<i>` session locations. The clean one is removed and reports no `worktree`. The one that wrote `wt-proof.txt` is kept: its `agents/1.json.worktree` holds the file, the main checkout does not, and it appears in `git worktree list`. | P28 |
| `stop.test.ts` | `workflow_control stop_agent` on a streaming agent: its `agent()` returns `null` (`log first=null`) and it is journaled `failed` / "stopped by user". The next agent starts; `workflow_control stop` then gives a notification with status `stopped` and a resume hint, the journal shows that agent as `stopped` (not failed), and both child sessions have outcome `interrupted`. | P51 P44 |
| `commands.test.ts` | No model calls. `/workflow-authoring` and `/workflows` post synthetic text (API reference; "No workflow runs") without starting an assistant turn. With `OPENCODE_DISABLE_WORKFLOWS=1`, the plugin is active but registers no workflow commands. | P58 P50 P57 P54 |

## Results and costs

Full runs on 2026-09-23 (Windows 11, opencode 2.0.15, parent and children on
`openai/gpt-5.4-mini`). The latest (final gate) run:

- 22/22 pass (13 offline harness tests, 9 live), about 120 s wall clock.
- Measured spend per full run is about **$0.17 to $0.19**: parent turns about $0.08, child agents
  about $0.11. Parent
  turns triggered by notifications are not in the log; they add about $0.002 each. Stopped
  (interrupted) turns show $0, because opencode does not count usage of interrupted turns (see
  OPENCODE-API-NOTES.md).
- The most expensive pieces are `basic` (about $0.047), `worktree` ($0.022), `resume` ($0.037
  over 3 prompts) and `nesting` ($0.020). A child prompt costs about 10k input tokens because of
  opencode's system prompt, so every extra agent costs about $0.008.

## Flakiness notes

- **Stop timing (`stop.test.ts`).** The test waits until `agents/0.json` is `running`, then asks the
  parent model to call `workflow_control`, which takes 5 to 10 s. The agent is writing an essay of
  at least 5000 words, which takes more than 30 s on gpt-5.4-mini. If a much faster model finishes
  the essay first, `stop_agent` answers "is not queued or running" and the test fails.
- **Model compliance.** The parent model has to copy the tool input verbatim. `launchPrompt`
  embeds the exact JSON, and `basic.test.ts` asserts that the copied script matches after
  whitespace normalisation. gpt-5.4-mini complied in every run so far. Child replies are checked
  with `toContain` (for example `FAN-1`), not for equality.
- **Startup stall.** Seen in earlier `--standalone` spikes (about 1 run in 5): the plugin never
  loads. It has not been seen with `serve`. `startServer` retries up to 3 times, and `runPrompt`
  retries attempts that produced no events.

## Findings relevant to parity / open issues

- **Orphaned runs with `--standalone` / process exit.** When the opencode process exits while a run
  is active, `run.json` stays `status:"running"` on disk forever and no notification is sent. The
  plugin cleanup (`host.dispose()`) does not get to flush a `stopped` summary in the one-shot CLI.
  **Fixed:** `/workflows` and `workflow_control list/status` now pass stored summaries through
  `reconcileStored()` (src/plugin/host.ts): a stored `running`/`paused` run that no engine in this
  process owns (`isRunActive` false) is shown as `stopped` with an "interrupted" warning and a
  `resumeFromRunId` hint. run.json on disk is left as is. Resume works either way, because
  `isRunActive` is per process. The status view also shows that run's agents still marked
  `queued`/`running` on disk as `stopped`. An agent's record is written again as soon as its child
  session exists, so after a crash `agents/<i>.json` holds the `sessionID` of the suspended child.
- **Plugin dispose on a live server** (plugin set changed, idle location evicted): runs are
  stopped, and each still sends its `stopped` task notification with the reason and a resume hint
  (PARITY note 9). Live probe before the fix: adding `.opencode/plugins/aaa.js` mid-run stopped the
  run 187 ms later and never notified the parent.
- **Not handled after a hard crash** (a plugin cannot do it safely): child sessions suspended by
  the crash are not interrupted or resumed, and `wf-<runId>-<i>` worktrees created before it are
  not swept. Another opencode process may own that run (`isRunActive` is per process, and run.json
  still says `running` after a crash), so removing its worktrees or interrupting its sessions could
  break a live run. Remove leftovers with `git worktree remove` once the run is known dead.
- **`/workflows` output waits in the inbox** until the next turn (gotcha 6). This is opencode's
  convention for `resume:false` synthetic messages, not a plugin bug, but the view is not instant
  the way Claude Code's is. P50 remains DEGRADED.
- P06 is confirmed live: `delivery:"queue", resume:true` wakes the idle parent, and the model
  answers the `<task-notification>`.

## Demo transcript

`demo/run-demo.ts` drives one live, natural-language request through the same harness (the parent
model writes the workflow script itself) and writes the transcript to `demo/DEMO-OUTPUT.md`:

```sh
OPENAI_API_KEY=... npx bun demo/run-demo.ts
```

It uses the same isolated `.sandbox/` directories as the e2e suite. Local paths in the transcript
are replaced with `<project>` and `<data-dir>` placeholders; the unscrubbed server URL, session id
and paths go to the git-ignored `.sandbox/demo-session-info.json`. A failed run writes
`.sandbox/DEMO-OUTPUT.failed.md` and leaves the committed transcript alone. The screenshots in
`docs/assets/` come from an earlier run of the same demo, viewed in the opencode web UI.
