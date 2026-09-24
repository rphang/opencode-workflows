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

Optional env: `OPENCODE_E2E_MODEL` sets the parent model (default `openai/gpt-5.4-mini`). With a free
`opencode/*` model (for example `opencode/space-bunny-free` or `opencode/nemotron-3-ultra-free`;
children default to a free model too) no provider key is used, but `OPENAI_API_KEY` must still be
set to enable the suites (`OPENAI_API_KEY=unused`).
`OPENCODE_E2E_BIN` sets the CLI binary.

## How the harness works (`tests/e2e/harness.ts`)

- **Isolation.** Every process gets `XDG_DATA_HOME/CONFIG/STATE/CACHE` under `.sandbox/e2e-*`, so
  your real opencode data is never touched. Run data (transcript dirs) ends up in
  `.sandbox/e2e-data/opencode/workflows/<sessionID>/<runId>/`. Worktrees end up in
  `.sandbox/e2e-data/opencode/worktree/`.
  It also sets `OPENCODE_TEST_HOME=.sandbox`: opencode loads every `AGENTS.md` from the project
  up to the home directory (or to the project root when the project is outside home), so a sandbox
  inside this repo would otherwise give the live models this repo's contributor `AGENTS.md`. With the
  home moved to `.sandbox`, the walk stops there. Never put an `AGENTS.md` in `.sandbox/` itself.
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
8. **Steering lands at step boundaries, never mid-step.** A `delivery:"steer"` synthetic is read before
   the child's next model step, after the current step and its tool calls finish, so a live test
   needs a child whose turn has several steps (the `slow_step` tool). `resume:false` can leave a
   late message in the inbox for ever, and `delivery:"queue"` makes its reply the agent's result;
   the runner uses `steer` + `resume:false` and wakes the child itself with
   `interrupt({resume:true})` when a message missed the turn (OPENCODE-API-NOTES, "Inbox and
   steering"; pinned live by "X03 opencode: …" in `steer.test.ts`).

   **Do not edit files under `src/` while a live suite runs.** opencode watches the plugin's source
   files and reloads every plugin instance when one changes; a run launched across that reload
   is refused (P06) or, before 0.2, started in the disposed instance where nothing could control it.

9. **TUI checks drive a real console window.** See "TUI live check" below: PostMessage keys to your own
   window handle (never SendKeys to whatever window has focus), PrintWindow screenshots, and close
   only the processes you started.

10. **A permission ask blocks a headless `serve` turn.** With no client attached, nobody answers a
   permission request. In the per-agent-outputs eval (`docs/design/agent-output-access.md`), a turn
   woken by a task notification read the run's `journal.jsonl`. That raised an `external_directory`
   ask (the data dir is outside the project), and the turn sat on it for the whole 150 s test. The
   plugin now points the model at `workflow_control` `result` instead of the files. A test that
   expects file reads must answer asks through `GET /api/session/<id>/permission` and
   `POST …/permission/<requestId>/reply`, or set a rule for the data dir in the project's
   `opencode.json`.
11. **Model habits seen with free models, independent of the plugin** (also in the C0 baseline):
   `opencode/nemotron-3-ultra-free` sometimes relaunches a failed run without being asked (the
   failed-run `<result>` now says to retry only if the user asks, which reduces it), sometimes sends
   `args` as a JSON string instead of an object, and sometimes polls `workflow_control status` while a
   run is going (from the 2nd call the note says repeating does not help). `opencode/space-bunny-free`
   fills in every field of a tool schema, which is why `result` has only `agent` and `offset`.

## TUI live check (manual, X12–X16)

The live progress tree has no automated live test (a TUI needs a console). The recipe used for
0.2.0, all under `.sandbox/live-tree/`:

1. **Package.** `npm run build`, copy `dist`, `workflows`, `README.md`, `LICENSE`, `CHANGELOG.md` and a
   `package.json` with a test version (for example `0.2.0-live.2`) into a staging dir, `npm pack`, and
   publish it to a local verdaccio (CONTRIBUTING "Smoke-testing the package"). Put a `package.json`
   with another name at the sandbox root (OPENCODE-API-NOTES "Plugin install resolution").
2. **Sandbox.** `XDG_*` and `OPENCODE_TEST_HOME` under the sandbox (see "Isolation": without it the
   repo's `AGENTS.md` reaches the models); `opencode.json`:
   `{"plugins":["@rphang/opencode-workflows@0.2.0-live.2"],"model":"openai/gpt-5.4-mini"}`;
   `cli.json`: `{"attention":{"notifications":true}}`. A git project with a `slow_step` tool plugin
   (`.opencode/plugins/slow-step.js`, 4 s per call) and a script with 3 quick agents, 2 agents that
   call `slow_step` ten times, and a second phase (`meta.phases` with `model` labels).
3. **Server.** `opencode serve --port 0` with the sandbox env, `OPENCODE_PASSWORD` and
   `NPM_CONFIG_REGISTRY`, stdin from `/dev/null`. Poll `GET /api/plugin` for the project until the
   package is `active` with `features.tui`.
4. **TUI.** `Start-Process conhost.exe "powershell -File launch.ps1 <url>"` where `launch.ps1` sets the
   same env and runs `opencode.exe --server <url> <project>`. Take the window handle from the child
   `powershell.exe`'s `MainWindowHandle` (opencode renames the window).
5. **Drive it** with `PostMessage(WM_CHAR)` (text, `ctrl+x` = 0x18) and `WM_KEYDOWN` (Enter, arrows)
   to that handle, and capture with `PrintWindow(hwnd, hdc, 2)`: type the launch prompt, `ctrl+x o`,
   ↓ to an agent, Enter (child tab opens), `ctrl+x o` there, `x` + Enter (stop), `m` + text + Enter
   (message). Poll `POST /api/rpc/dynamic-workflows/list` to know when the run finished.
6. **Clean up** only your PIDs (the TUI's `opencode.exe`, its `powershell`/`conhost`, the server and
   verdaccio); never the user's opencode processes.

Seen on 2.0.15: footer `wf live-tree-demo 3/5 · 71.6k · $0.05`, live `» slow_step {"n":3}` activity,
Enter opened the child in a new tab whose footer still tracks the parent run, `x` stopped the agent
(its transcript ends `interrupted`, the tree shows ✗ "stopped by user"), `m` delivered
`STEERED-OK`, and the finish toast appeared (conhost: `focus_unknown`).

The README screenshots (`docs/assets/live-tree-*.png`) were retaken for the per-agent model display
(X18, X19) with a shorter setup: a directory install (`"plugins":["file:///<repo>"]`, which loads the
repo's `server.ts` and `tui.tsx`; run `npm run build` first) instead of verdaccio, a project in a
short path outside the repo, and free `opencode/*` models so that the agents show several models:
parent `opencode/space-bunny-free`, one agent with `effort:'low'` (`…#low`), one with
`model:'opencode/nemotron-3-ultra-free'`, and a second phase whose `meta.phases` label and agent use
`opencode/mimo-v2.6-flash-free`. The TUI was launched at 180×48 and 120×40 (`launch.ps1` sets the
console size). Seen: the rows showed `opencode/space-bunny-free#low` and the other models,
`agents/<i>.json` recorded the same `model`, the unlabeled phase listed its agents' models, and at
120 columns the agent models lost their provider first.

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
| `steer.test.ts` | A second project plugin adds a 3-second `slow_step` tool. The child is told to call it four times; during the first call `/workflows msg <runId> 0 …` (through `POST /api/session/:id/command`) replies `#0 stepper sent`. The result is the steered answer, the child made fewer than 4 calls, its context holds the `<orchestrator-message>` before that answer, `agents/0.json` shows the message `delivered`, the journal has the `message` line and `steered:true`. Relaunching with `resumeFromRunId` runs agent 0 live (new session, original answer). A last case sends the message as the final step starts: it is either answered (that reply is the result) or refused (`finishing`/`finished`), and the child's last reply is always the result. | X01 X03 X06 P41 |
| `results.test.ts` | Two cases. (1) Two agents, empty result: the notification has `<diagnostics>` with `workflow_control {action:"result", runId:"…"}`, and in a later turn the parent is asked to call `{"action":"result","runId":…,"agent":"beta"}`. The child prompts spell the markers out ("the word BETA, then a hyphen, then the number 5512") so the marker in an output can only come from the return value; the detail view prints the prompt. The test accepts either path and logs which one ran: with `agent`, the detail (`Agent #1 "beta" of run …` and `Return value (text, …)` then `BETA-5512`); without it, the list, whose `#1 "beta" completed … → BETA-5512` preview row must show the value. Observed with `opencode/space-bunny-free`: one run dropped `agent`, filled `agentIndex:0`, `offset:0` and `location:"project"` instead, and got the list (only the list path ran). A later run sent `agent:"beta"` and got the detail view with `BETA-5512`. The detail path is always covered by `tests/parity/results.test.ts`. (2) A partial failure, in natural language ("ultracode… tell me which regions were confirmed… Do not relaunch"): 2 of 4 agents fail at once (unknown `agentType`). The notification has `<agent-failures>2 of 4 agents returned no result`; the parent makes at most 3 `workflow_control` calls before the notification, reads no transcript file, relaunches nothing, and its reply names both failed regions. Passed live with the free parents `opencode/nemotron-3-ultra-free` (twice) and `opencode/space-bunny-free`: 0 `workflow_control` calls before the notification and 0 tool calls after it in every run, with the right reason given ("unknown agent type `no-such-agent`"). | X21 X20 P79 P77 |

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
- **Per-agent outputs** (P79, X20, X21): the parent reads them with `workflow_control` `result`, not
  from the transcript files, so no `external_directory` ask is raised (gotcha 10). Open items:
  - the notification's `<result>` is not clipped (a 114 KB result, about 50k tokens, was seen);
  - a refused `agent()` call leaves no record (X20);
  - a model can read a finished run's agents before its notification arrives and report twice (P77);
  - the full re-evaluation listed in `docs/design/agent-output-access.md` ("Before merging") has not
    been run yet.

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
