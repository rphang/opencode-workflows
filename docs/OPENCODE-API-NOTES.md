# opencode 2.0.15 plugin API: verified facts for the workflow runner

Everything below was observed live on opencode **2.0.15** (`npx opencode2 run --standalone`) using
the throwaway plugins in `tests/e2e/spikes/` (`explore.js`, `runner-live.ts`), unless it is marked
*(source)*, which means it was read from the v2 branch of `anomalyco/opencode` (`packages/core/src`).
The fake in `tests/helpers/fake-opencode-ctx.ts` mirrors these shapes.

## Session API (`ctx.session`)

- `create({title?, metadata?, agent?, model?, permissions?, location?, id?})` returns the
  Session.Info object:
  ```json
  {"id":"ses_…","projectID":"c5e10c0c9e…","model":{"id":"gpt-5.4-mini","providerID":"openai","variant":"default"},
   "cost":0,"tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}},
   "time":{"created":…,"updated":…},"title":"[wf:live1] plain",
   "metadata":{"workflowRunId":"live1","workflowAgentIndex":0,"parentSessionID":"ses_…"},
   "permissions":[{"action":"workflow","resource":"*","effect":"deny"}, …],
   "location":{"directory":"C:\\…\\rproj"}}
  ```
  - `model` is `{providerID, id, variant?}`. If you omit it, the child does **not** inherit the
    parent's model. It gets opencode's default (a free `opencode/*` model), and `get()` shows no
    `model` field. So the runner always passes the parent's model explicitly (P25).
  - A `variant` is stored as given, e.g. `{…, "variant":"high"}`. When no variant is given, opencode
    fills in `"default"`.
  - The plugin `create` has no `parentID` *(source: plugin/host.ts)*. The default `location` is the
    plugin's own location.
  - `metadata` and `permissions` are stored verbatim and returned by `get()`.
- `prompt({sessionID, text})` returns immediately with
  `{id, sessionID, time, type:"user", payload:{text}, delivery:"steer"}`.
- `wait({sessionID})` resolves with `undefined` once the session is idle.
- `get({sessionID})` returns Session.Info with cumulative `tokens`, `cost` (USD), and
  `outcome: "succeeded" | "failed" | "interrupted"`, plus `time.idle`.
- `context({sessionID})` returns an array of messages:
  - `{type:"user", text}`
  - `{type:"assistant", agent, model, content:[{type:"reasoning",…}|{type:"text",text}|{type:"tool", name, state:{status, input, content:[{type:"text",text}]}}], finish, cost, tokens, error?}`
  - `{type:"idle", outcome}`
- `interrupt({sessionID})` returns `{interrupted:true}`. The following `wait()` resolves and `get()`
  reports `outcome:"interrupted"`. **The tokens and cost of an interrupted turn are not counted**:
  `get()` showed 0 for all of them after interrupting a turn that had streamed for about 2.5
  seconds. As a result, stopped agents report whatever usage had been recorded before the stop.
- **Terminal failure** (tested with an unknown model `openai/no-such-model-xyz`): `wait()` resolves
  within milliseconds and `get().outcome` is `"failed"`. `context()` contains **only**
  `[user, {type:"idle", outcome:"failed"}]`, with no assistant message and no error text. When an
  assistant message does exist, `error: {type, message, status?}` is set on it *(types)*. The
  runner reports that message, or a generic "agent session failed (terminal error)".

## Permissions (P60/P61)

- A rule has the shape `{action, resource, effect: "allow"|"deny"|"ask"}`. For tools, `action` is
  the tool name (or `tool.options.permission`, if set).
- Effective rules are the agent's rules followed by the session's `permissions`. Evaluation uses
  `findLast`, so **later rules win** *(source: permission.ts)*.
- A tool whose last matching rule is `{resource:"*", effect:"deny"}` is **removed from the tool
  list** *(source: tool.ts `whollyDisabled`)*. **Verified live** with a `session.hook("context")`
  that logs `Object.keys(input.tools)`:
  - The parent session sees `…,workflow,workflow_submit`.
  - A child with `[{action:"workflow",resource:"*",effect:"deny"}, {action:"workflow_submit",…,"deny"}]`
    sees neither tool.
  - A schema child with `…workflow_submit allow` sees `workflow_submit` but not `workflow`.
- Parent sessions created by `opencode run` have **no** session-level `permissions` field (it is
  undefined), so there is usually nothing to copy. Restrictions such as Plan mode live in the
  **agent's** rules (`plugin/plan.ts` pushes `edit * deny` onto `plan`), so the runner creates the
  child with the parent's current agent (tool `ctx.agent`, else `Session.Info.agent`); with a
  different `agentType` it appends the parent agent's deny/ask rules to the child's session rules.
- `ctx.agent.get({agentID})` returns `{location, data: Agent.Info}` (`data.mode`:
  `"subagent"|"primary"|"all"`, `data.permissions`) and rejects with `Agent not found: <id>`.
  opencode's subagent tool refuses `mode === "primary"` and asserts `{action:"subagent",
  resource:<agent id>}` *(source: tool/plugin/subagent.ts)*; the runner mirrors both checks.
- File reads are gated by `external_directory` (resource `<dir>/*`, for paths outside the location
  and project directories) then `read` (resource: path relative to the location, or the absolute
  path) *(source: file-access.ts)*. Default agents allow `external_directory` for opencode's tmp,
  config and tool-output dirs; unmatched → `ask`. `scriptPath` checks mirror this (P76).

- **Asks and forms in children are never seen** *(source + live probe)*. The TUI shows (and
  auto-accepts) permission requests and question forms only for the viewed session and its
  `parentID` family; `opencode run --auto` answers only its own session. Plugin children have no
  parentID, so a child's "ask" (default agents ask for `external_directory` and `*.env` reads) or a
  `question` call waits forever. Fix (P63): children get `question` denied, and
  `ctx.permission.hook("evaluate", e => …)` rewrites `e.effect` "ask" → "deny" (plus `e.message`)
  for sessions whose metadata has `workflowRunId`. The hook sees the effect after saved "always"
  approvals *(source: permission.ts `evaluateInput`)*. Both the permission service and the hook
  registry are **per location**, so only the plugin instance loaded for the child's location sees
  its evaluations, and `ctx.permission.list({sessionID})` only lists requests in that location.

## Plugin lifetime *(source)*

- A plugin instance is scoped to its location. Its cleanup runs on shutdown, and also on a live
  server when `Plugin.activate` closes every plugin after the first definition whose (id, revision)
  changed (adding or updating a plugin that sorts earlier, a pending npm install finishing), and
  when `LocationActivity` evicts a location after 60 minutes without durable session events there
  (it interrupts that location's active sessions, then `locations.invalidate`).
- `ctx.session.update({sessionID, title})` publishes a durable `Session.Renamed` event even when the
  title is unchanged; that event carries the session's location and refreshes its idle timer. The
  host uses it as a keep-alive for the parent while a run is active (every 20 min). Title
  generation compares title values, so a same-title rename does not block it.

## Tools

- `ctx.tool.transform(e => e.add({name, description, input: <JSON Schema>, options:{codemode:false}, execute}))`.
  `execute(input, tctx)` returns `{content: string | [{type:"text",text}], output?, metadata?}`.
  Returned content is shown to the model as the tool result, as the retry trace below shows.
- **Tools are registered per location (plugin instance).** A session whose `location` is another
  directory, such as a worktree, only sees the tools of the plugin instance loaded for that
  directory. In `explore.js` the plugin lived in an uncommitted `.opencode/`, the worktree did not
  have it, and the child could not find the tool. Consequences:
  - For worktree agents with a schema, the plugin must also load in the worktree. Either install it
    globally (`~/.config/opencode`), or ship it in a committed `.opencode/`.
  - The `workflow_submit` call is then handled by the worktree's instance. For that reason the
    submit registry mirrors its state to `ctx.storage`.
- **`ctx.storage` is shared across plugin instances.** It is backed by one global KV with the
  namespace `plugin:<hex(pluginID)>:` *(source: plugin/host.ts `storage`)*. **Verified live**: in
  `wtschema`, a schema agent inside a worktree submitted through the worktree instance's tool, and
  the runner in the parent instance read the accepted value. The `workflow-submit/<sessionID>` keys
  were gone from the `kv` table afterwards.

## Structured output: live retry trace

Schema `{code: {type:"string", pattern:"^ZX-[0-9]{4}$"}}`, prompt "submit 'abc'":
```
workflow_submit {"output":{"code":"abc"}}     -> "Output failed schema validation:\n/code: must match pattern \"^ZX-[0-9]{4}$\"\nFix the output and call workflow_submit again."
workflow_submit {"output":{"code":"ZX-0000"}} -> "Output accepted. …"
```
The runner returned `{status:"completed", value:{code:"ZX-0000"}}` with a single prompt. The model
retried inside the same turn.

## Models (P25/P26)

- `ctx.model.list()` returns `{location, data: ModelInfo[]}`. Each entry is
  `ModelInfo = {id, modelID, providerID, name, variants:[{id,…}], enabled, time:{released}, …}`.
  In this run it listed 62 models. Observed variants:
  - `openai/gpt-5.4-mini`: `none, low, medium, high, xhigh`
  - `openai/gpt-5`: `minimal, low, medium, high`
  - `opencode/mimo-v2.6-flash-free`: none
  - `opencode/muse-spark-1.3-contributor-free`: `minimal … xhigh`
- `ModelInfo.id` can differ from `modelID`. For example, `gpt-5.4-mini-fast` has
  `modelID: gpt-5.4-mini`. The session model ref uses `id`.
- **Verified live**: `effort:"high"` on the default model `openai/gpt-5.4-mini` produced a child
  whose `get().model` is `{…,"variant":"high"}`.

## Worktrees (P28)

- `ctx.worktree.create({projectID, name?, directory?, from?, branch?})` returns `{directory}`.
  `projectID` is `parent.projectID`, which equals `ctx.location.project.id`. The directory defaults
  to `<XDG_DATA_HOME>/opencode/worktree/<projectID[0:6]>/<name>` *(source: worktree/strategies.ts)*.
  A git project is required (in a non-git directory the project id is `"global"`). `branch` is a
  starting ref, not a new branch name.
- A session created with `location:{directory: worktree}` runs inside that directory, and opencode
  loads (activates) the plugins for that location (`setup` ran again with the worktree directory).
- `ctx.worktree.remove({projectID, directory, force:false})` returns `undefined` and deletes the
  directory (**verified live**: `wf-live1-4` and `wf-live1-6` were removed).
- `ctx.vcs.status({location:{directory: worktree}})` **ignores the directory** and reports the
  plugin's own location, which is the main checkout. For that reason the runner detects changes
  with `git status --porcelain` plus a comparison of `rev-parse HEAD` against the value recorded at
  creation, run through `node:child_process` in the worktree directory. **Verified live**: the
  `wtdirty` agent created `hello.txt`, so the worktree was kept and reported through
  `onUpdate({worktree})`. `git status` there shows `?? hello.txt`.

## Tool context

`tctx = {sessionID, agent, messageID, id, progress, signal}`. `progress(metadata)` returns a Promise.

## Live verification recipe

```sh
S=$PWD/.sandbox
# own git project + committed loader (so worktrees load the plugin too)
cd $S/rproj   # git repo; .opencode/plugins/loader.js = export { default } from "<abs>/tests/e2e/spikes/runner-live.ts"
export XDG_DATA_HOME=$S/r-data XDG_CONFIG_HOME=$S/r-config XDG_STATE_HOME=$S/r-state XDG_CACHE_HOME=$S/r-cache
export SPIKE_LOG="$(cygpath -w $S/r-live.log)"
npx opencode2 run --standalone --auto --format json -m openai/gpt-5.4-mini "Call the rt_live tool with mode=all and then reply OK."
```

Setup notes:
- The loader must be a **static** re-export. A top-level-await dynamic `import()` in the loader
  never activated: the run hung until timeout with a `Transport` error.
- Now and then (1 run in 5) `opencode run` stalls at startup: the server logs "cli starting" and
  the plugin never loads. Re-running the same command worked.
- To inspect finished sessions, read `r-data/opencode/opencode.db` with `bun:sqlite`: tables
  `session_message` (`data` JSON) and `kv`.

Live results (2026-09-23): `plain`, `schema`, `effort`, `abort` (stopped after 3s, child
`outcome:"interrupted"`), `wtclean` (removed), `wtdirty` (kept), `wtschema` (cross-instance
submit), and `retry` all behaved as specified.

## Plugin install resolution

- A config entry `"plugins": ["file:///<dir>"]` (or a plain directory path, or
  `{"package": "file:///<dir>", "options": {...}}`) is resolved by `Host.resolve({directory})`
  (`@opencode/plugin/dist/host.js`), which tries `<dir>/server` then `<dir>/index` and **ignores
  package.json `main`/`exports`** *(source)*. Hence the repo's root `server.ts`. **Verified live**
  (`.sandbox/review/probe-install2.ts`, `opencode serve`): both directory forms load the plugin, and
  `options: {disabled: true}` reaches `setup` (plugin active, no workflow commands).
- A file target (`.../src/index.ts`) is rejected with `configured plugin path must be a directory`;
  the legacy `"plugin"` key and the tuple form `[url, options]` load nothing, silently.
- Loader files in a `plugins/` directory (`~/.config/opencode/plugins/`, `.opencode/plugins/`) always
  get `options: {}`.
