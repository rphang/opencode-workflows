# Troubleshooting

If none of these match, open a [bug report](https://github.com/rphang/opencode-workflows/issues/new/choose)
and include the run's `run.json` and `journal.jsonl`. They are in the run's transcript directory,
`<data dir>/<sessionID>/<runId>/`, which is `transcriptDir` in the tool output.

## Installing and loading

| Symptom | Cause and fix |
|---|---|
| The model says it has no `workflow` tool | The plugin didn't load. Run `opencode plugin list`, or check `GET /api/plugin` on `opencode serve` for `dynamic-workflows`. The config key must be `plugins` (plural); the legacy `plugin` key loads nothing and gives no error. Check that `OPENCODE_DISABLE_WORKFLOWS` is not set and that the `disabled` option isn't `true`. |
| `Duplicate plugin ID: dynamic-workflows` | The plugin is loaded twice, for example the npm package and a loader file. Keep one method ([INSTALL.md](INSTALL.md)). |
| `opencode plugin list` or `plugin add` times out waiting for the background service to start | The CLI's plugin commands go through a managed background service on port 49374. Another opencode process already holds that port. Stop it, or run `opencode service set port <port>`. The reason is logged in `opencode/log/opencode.log` under opencode's data directory. |
| `opencode plugin list` prints `No plugins found` right after an install | The first command started the service and the plugin is still loading. Run it again after a few seconds. |
| `EPERM: operation not permitted, rename '...opencode-workflows@<spec>\.staging-...'` during `plugin add` (Windows) | A transient file lock (often antivirus) in opencode's npm cache. The config was not changed. Run the same command again. |
| A new config entry is not picked up | Wait about 20 s (opencode downloads the package), then run `opencode service restart` or restart the TUI. |
| `configured plugin path must be a directory` | A from-source `file://` entry must point at the repo directory, not at a file ([INSTALL.md](INSTALL.md#directory-entry-in-the-config)). |
| A from-source loader file never activates | It must be a static `export { default } from "<abs path>"`. A top-level `await import()` never activates. For `src/index.ts`, run `npm install` in the repo; for `dist/index.js`, run `npm run build`. |

## Runs and notifications

| Symptom | Cause and fix |
|---|---|
| The run never reports back | You used `opencode run --standalone`. Its private server exits as soon as the turn ends, and that kills the background run. Use the TUI, or a long-lived `opencode serve` with `opencode run --server <url>`. `/workflows` then shows the run as `stopped` (interrupted). Relaunch it with `resumeFromRunId`. |
| `opencode run` (without `--standalone`) exits before the answer | Expected. The run continues in the background service, and the notification and the final answer land in the session there. Read them in the TUI, or with `opencode run -c` or `opencode run -s <sessionID>`. |
| `opencode run "/workflows"` doesn't show the view | Slash commands run from the TUI or web UI; `opencode run` sends the text as a normal message. With `opencode serve`, call `POST /api/session/<sessionID>/command` with `{"name":"workflows","text":""}` and the `x-opencode-directory` header, then send another message. In Git Bash on Windows, MSYS rewrites arguments that start with `/`; set `MSYS_NO_PATHCONV=1`. |
| The notification arrives late | Notifications are queued after your current turn and never injected mid-turn. `/workflows` output also waits for your next turn. |
| The run stopped with "the workflow plugin was unloaded" | opencode disposed the plugin (shutdown, a plugin update, or the location going idle for 60 minutes). The notification includes a `resumeFromRunId` hint. Relaunch with it. |
| `nothing to resume` | The run id is unknown, belongs to another session, or has no finished agents. |
| The model keeps calling `workflow_control status` instead of waiting | Status never includes the result, by design (P77). Tell the model to end its turn. The notification wakes the session when the run finishes. |

## Agents

| Symptom | Cause and fix |
|---|---|
| An agent fails with "workflow agents cannot ask for approval" | The agent needed a permission that your rules set to `ask`. Nobody can answer that prompt, so it is denied. Add an opencode `allow` rule for that tool or directory, or change the prompt. |
| An agent seems stuck | A tool may be waiting on something nobody sees. Set `OPENCODE_WORKFLOW_AGENT_TIMEOUT_MS`, or ask the model to `stop_agent` it (that `agent()` returns `null`). |
| A schema agent throws after several attempts | Its output didn't match the schema `MAX_STRUCTURED_OUTPUT_RETRIES` times (default 5). Simplify the schema, raise the limit, or use a stronger model for that agent. |
| `effort` has no effect, with a warning | The model has no variant for that effort level. The option is ignored. |
| A schema agent in a worktree returns loosely parsed JSON, or its approval requests hang | The plugin isn't loaded in the worktree. Install it globally, or commit the project config ([INSTALL.md](INSTALL.md#why-global)). |
| An `agentType` agent returns `null` right away | The id is unknown, is a primary agent (such as `build` or `plan`), or your `subagent` permission denies it. |
| Leftover `wf-<runId>-<i>` worktrees after a crash | They are not removed automatically, because another process might still own the run. Once you know the run is dead, remove them with `git worktree remove`. |

## Scripts

| Symptom | Cause and fix |
|---|---|
| `export const meta must be the first statement` or a meta error | `meta` must come first and be a pure literal: no variables, calls, spreads or template interpolation. |
| A syntax error on a type annotation | Scripts are plain JavaScript, not TypeScript. |
| `Date.now() is not available in workflow scripts` (or `Math.random()`, or `new Date()`) | These would break resume. Pass timestamps in through `args`, and vary prompts by index instead of randomness. |
| `scriptPath ... is outside the project directory` or `... is denied by opencode's read permission` | The file is outside the allowed locations (see the [security model](../README.md#security-model)). Add an `external_directory` allow rule for its directory, copy the script into the project, or pass it inline. |
| A saved workflow doesn't show up as `/<name>` | Its `meta` is not a pure literal, so it is not registered. Check the file in `.opencode/workflows/` or `~/.config/opencode/workflows/`. |

## `/deep-research`

| Symptom | Cause and fix |
|---|---|
| It stops early with `NO_WEB_ACCESS`, or its web calls hang for about 60 s | `websearch` needs a provider. The first call asks you to choose one, and a workflow agent cannot answer that prompt. Run one web search in your own session first. |
| Claims are listed as UNVERIFIED | The skeptics could not check them (errors, rate limits or failing web tools). A tool failure counts as an abstention, never as a refutation. Fix web access and rerun. |
