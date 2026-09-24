# Design: steering running agents (A) and the live progress tree (B)

Status: approved for implementation on branch `feat/steering-live-tree`. Target: 0.2.0.
Chunk 1 (Feature A, steering) and chunk 2 (Feature B, the live tree) are implemented: see the
"Implementation notes" sections at the end.
Both features are **extensions** beyond Claude Code. They get `EXT` rows (IDs `X01`…) in
`docs/PARITY.md`, not `P` rows.

Evidence base: two live spikes on opencode 2.0.15 (isolated XDG sandboxes under `.sandbox/`), plus
the v2 source (`packages/core/src/session/{inbox.ts,session.ts,execution.ts,run-coordinator.ts,runner/llm.ts,runner/to-llm-message.ts}`,
`packages/tui/src/plugin/{context.tsx,discovery.ts}`, `@opencode/plugin/dist/host.js`). Where the
spikes contradict the roadmap, this doc follows the spikes. The main changes from the roadmap are:

| Roadmap said | Spikes showed | Decision |
|---|---|---|
| `synthetic({delivery:'steer', resume:false})` | A message that lands after the drain loop's last inbox check, or after the child went idle, is **orphaned** (3/3 live). The plugin API cannot list or cancel inbox items. | Use **`resume:true`**, and the runner owns a *steer window* (§A.4). **Revised:** `resume:false` plus an explicit wake by the runner, see "Review revisions" at the end. |
| Steering redirects the agent right away | A steer is picked up only at the **next step boundary**, after the step in progress and all its tool calls finish. | Document this. Offer `urgent` = steer + `interrupt({resume:true})`, which was verified live (§A.3). |
| `delivery:'queue'` is an option | Queued input runs as an extra turn *after* the current turn, and its reply **replaces the agent's result**. | Never use `queue` for steering. |
| The TUI can scope by Location | `/api/event` is **one global stream**. RPC *calls* are routed per Location; RPC *events* are not. | The TUI filters events itself (by `location.directory` and `parentSessionID`) and sends calls to the parent session's Location. |
| Apply `meta.phases[].model` as the phase's default model | In Claude Code it is a **label** shown in the progress view. Agents get their model from `opts.model`. | **Display only** (§B.0). Do not route models from it. |

---

## B.0 Background: the `meta.phases[].model` gap

`src/meta.ts` (lines 125–140) validates `phases[].model` and keeps it in `WorkflowMeta.phases`.
`WorkflowRun`'s constructor (`src/engine.ts`) then calls `addPhase(p.title)`, which keeps **only
the title**. `PhaseSummary` has no `model` field. So the label the script author wrote never
reaches `run.json`, `/workflows`, `workflow_control status` or the notification. Claude Code shows
it next to the phase in its progress view.

Nothing runs on the wrong model because of this. The authoring reference already says: "Add
`model` to a phase entry when that phase uses a model override". The override itself is
`agent(…, {model})`. The roadmap called it a parity bug and proposed using the label as the phase's
default model. That would make agents run on a model the script never asked for with `opts.model`.
Claude Code does not do that, and it would also change which model a resumed agent gets. **The fix is
display only:** `PhaseSummary.model?: string`, shown in every view (X10).

---

# Feature A: steering a running agent

## A.1 User stories

1. *As the user*, I watch a research fan-out and see agent #3 heading into irrelevant files. I type
   `/workflows msg wf_ab12 3 skip the vendor/ folder, focus on src/auth` and #3 changes course
   without losing its work so far.
2. *As the user*, I tell the model "tell the researchers to prefer primary sources". The parent
   model calls `workflow_control {action:'message', runId, phase:'Research', text}` and every
   running or queued agent of that phase gets the message.
3. *As the user*, in the TUI tree I select an agent, press `m`, type a message, and see
   `✉ 1 delivered` appear on that agent's row.
4. *As the user*, I need an immediate redirect (an agent is streaming a 10k-char answer in the
   wrong language). I use `urgent` and accept that the current step's tokens are thrown away.
5. *As a maintainer*, I resume a run in which an agent was steered and get a correct run:
   the steered agent and every agent after it run live again (the P41 rule), never a cached result
   that depended on a message that is not replayed.

## A.2 Surfaces

### Slash command (user)

```
/workflows msg <runId> <target> <text…>
/workflows msg! <runId> <target> <text…>      # urgent: interrupts the current step
```

`<target>` is one of:

| Form | Meaning |
|---|---|
| `3` or `#3` | the agent with index 3 |
| `@Research` or `@"Deep dive"` | every running **and queued** agent whose phase is that title |
| `*` | every running and queued agent of the run |
| `label` or `"multi word label"` | the one agent whose label matches exactly; an ambiguous match is an error that lists the candidates with their indices |

The command replies with one line per targeted agent (`#3 sent`, `#5 held (queued)`,
`#7 refused: finished`), through the same `session.synthetic({resume:false})` display path as
`/workflows`.

### `workflow_control` (parent model)

```jsonc
{ "action": "message", "runId": "wf_…",
  "agentIndex": 3,            // or
  "label": "auth scan",       // or
  "phase": "Research",        // or
  "all": true,                // exactly one target selector
  "text": "…",                // 1..4000 chars
  "urgent": false }
```

`CONTROL_ACTIONS` gains `"message"`. The tool description says: *"message: send an instruction to
a running agent of your run without restarting it. It is read at the agent's next step boundary.
Use it only when the user asks you to redirect agents."* This is the same restraint the existing
stop/pause/save wording asks for.

The parent model is **allowed** to steer, but only this way: an explicit tool call on a run its own
session owns (P75). It gains no power it does not already have, since it wrote every prompt in the
script. Child agents **cannot** steer: `workflow_control` is already denied in every child session
(P60, `deniedTools` in `src/plugin/setup.ts`).

### TUI (Feature B)

`m` opens `ui.dialog.prompt` and `M` does the urgent variant. Both call the RPC
`control({action:'message'})`, which goes through the same host method.

## A.3 Transport (verified opencode calls)

Normal message to a running child:

```ts
const res = await ctx.session.synthetic({
  sessionID: childSessionID,
  text: formatOrchestratorMessage(msg),   // §A.7
  description: `workflow message (${msg.from})`,
  metadata: { workflowRunId, workflowAgentIndex, workflowMessageId: msg.id },
  delivery: "steer",
  resume: true, // revised to false: see "Review revisions"
})
// res = { id: "msg_…", sessionID, type:"synthetic", delivery:"steer", … }; returns within 1–6 ms
```

Behavior that was verified live and the design relies on:

- The drain loop in `runner/llm.ts` promotes steer-scoped inbox items **before every model step**.
  Mid-turn, the message becomes a user-role message at the next step boundary of the **same**
  execution: one execution, `wait()` resolves once, final outcome `succeeded`.
- `resume:true` behaves exactly like `resume:false` mid-turn. At the end of a turn it wakes the
  session (`coordinator.wake`, then `pendingWake` or a successor execution), so the message is never
  orphaned. `awaitIdle` follows successor executions.
- `res.id` is the id of the context message it becomes. So "was it delivered?" becomes
  `context().some(m => m.id === res.id)`. The delivered message's `time.created` is the
  **delivery** time.

Urgent variant (verified: `interruptresume`):

```ts
await ctx.session.synthetic({ …same…, resume: true })
await ctx.session.interrupt({ sessionID: childSessionID, resume: true })
```

This produces `execution.interrupted{reason:'user'}`, then a new execution, then the message is
delivered. A `wait()` started earlier resolves only after the successor turn, and `get().outcome`
is `succeeded`. Costs: the interrupted step's tokens are **lost from the session usage**, so the
agent's tokens and `budget.spent()` undercount, and the child history gets an
`{type:'idle', outcome:'interrupted'}` marker. The runner's `turn()` needs no special case, because it
reads the final outcome (`succeeded`).

Rejected transports: `delivery:'queue'` (its reply becomes the agent's result), and
`resume:false` (orphans at the end of a turn).

## A.4 The steer window (runner protocol)

The race to close: a message sent just as the child's turn ends either starts a successor turn
whose output the runner never reads (with `resume:true`), or is lost (with `resume:false`). The runner
closes it with a per-agent **mailbox** that has explicit states:

```
          attach()             turn prompt sent            wait() resolved
 pending ─────────► between ───────────────────► open ─────────────────────► finishing
   │ (queued agent:   ▲                                                         │
   │  messages held)  └──────────── next schema-retry turn ◄────────────────────┤
   │                                                                            │ settle
   └──────────────────────────────── stop / settle ─────────────────────────────► closed
```

`src/mailbox.ts` (host-agnostic, in the engine layer):

```ts
export type MessageFrom = "user" | "model"
export interface AgentMessage { id: string; from: MessageFrom; via: "command"|"tool"|"tui"; text: string; urgent: boolean; at: number }
export type PostResult =
  | { ok: true; state: "sent"; deliveryId: string }
  | { ok: true; state: "held" }                    // queued agent: goes into its first prompt
  | { ok: false; reason: "finished"|"finishing"|"not_running"|"submitted"|"limit"|"send_failed"; detail?: string }

export class AgentMailbox {
  state: "pending" | "between" | "open" | "finishing" | "closed"
  post(msg: AgentMessage): Promise<PostResult>          // synchronous state check, then send
  // runner side
  attach(send: (m: AgentMessage) => Promise<{ id: string }>, guard?: () => Promise<string | undefined>): AgentMessage[] // returns held messages
  open(): void                                          // before prompt()
  close(): Promise<string[]>                            // → "finishing"; awaits in-flight sends; returns delivery ids sent in this window
  seal(): void                                          // → "closed"
}
```

Rules:

- **`post()` decides synchronously** (JS is single-threaded, so the state check and the state
  change cannot interleave). `open` → send. `pending` → hold (at most 5 held messages; more gives
  `limit`). `between`/`finishing` → refused with `finishing` ("the agent is finishing its turn; try
  again or stop it"). `closed` → `finished`.
- The in-flight `send` promise is tracked. `close()` awaits it, so a message whose
  `synthetic()` call started before the window closed is always verified.
- `guard()` is the schema-agent hook: when `registry.read(sessionID).accepted` is set, the answer is
  `submitted` ("the agent already submitted its structured result; a message can no longer change
  it"). Verified from `src/opencode/submit.ts`: a later `workflow_submit` gets "Output was already
  accepted earlier."
- At most 20 messages per agent, and at most 4000 characters each. Beyond that: `limit`.

Runner changes (`src/opencode/runner.ts`):

```ts
// after session.create:
const held = request.mailbox?.attach(sendSteer, schema ? acceptedGuard : undefined) ?? []
// first prompt = childPrompt(prompt) + (held.length ? "\n\n" + held.map(formatOrchestratorMessage).join("\n\n") : "")

const turn = async (text) => {
  request.mailbox?.open()
  await ctx.session.prompt({ sessionID, text })
  let done = await race(wait(), stopped)
  if (done !== "idle" || stopReason) return stoppedOutcome()
  const ids = await request.mailbox?.close() ?? []
  // Verify each message sent in this window was delivered and answered.
  for (let i = 0; ids.length && i < 3; i++) {
    await race(wait(), stopped)            // follows the successor execution that resume:true guarantees; resolves at once if idle
    if (stopReason) return stoppedOutcome()
    const ctxIds = new Set((await ctx.session.context({ sessionID })).map(m => m.id))
    const missing = ids.filter(id => !ctxIds.has(id))
    if (!missing.length) break
    if (i === 2) warn(`message(s) ${missing.join(", ")} were not delivered before the agent finished`)
  }
  … existing outcome handling (get → outcome) …
}
// finally: request.mailbox?.seal()
```

- If **any** message was sent in the window, `wait()` is always called one extra time. That covers
  a message admitted in the gap between the drain's final `Complete` and the end of the execution
  (source only; live it showed up as a successor execution). The extra `wait()` costs nothing when
  the session is idle.
- The result is read **after** this loop, so the agent's result is its reply to the last message.
- Between schema-retry turns the mailbox is `between`, not `closed`, so a message sent there is
  refused with `finishing`, not `finished`.
- The stop path (`stoppedOutcome`) seals the mailbox. A message still in the child's inbox after a
  stop stays orphaned, which is harmless: a stopped agent is never prompted again, and the plugin has
  no cancel API.

`AgentRecord.messages` tracks each message's status: `held`, then `sent`, then `delivered`
(when the id shows up in `context()` at `close()`), or `undelivered` (warning).

## A.5 Engine and host changes

- `LiveAgent` gets `mailbox: AgentMailbox`, created at `callAgent` time in state `pending`, and it
  is passed to the runner as `AgentRequest.mailbox`. Cached (replayed) agents have no mailbox and
  are refused with `finished`.
- `WorkflowRun.message(target: MessageTarget, msg): Promise<MessageReport[]>` resolves the target
  (index, label, phase, all) against `records`, calls `mailbox.post` for each agent, journals each
  accepted message, updates the record, and emits an `agent` event.
- `WorkflowHost.control` gains `case "message"`. It runs the same P75 `ownsRun` check first
  (another session's run answers "not found in this session"). Then it validates the text (trim,
  non-empty, at most 4000 characters) and refuses a run that is not `running`/`paused` ("run is
  not running"). Messaging a paused run is allowed: its running agents still run. `/workflows msg`
  calls the same method with `from:'user', via:'command'`. The tool calls it with
  `from:'model', via:'tool'`, and the RPC with `from:'user', via:'tui'`.

## A.6 State, persistence and determinism (P41)

**journal.jsonl** gets a new line type, written when a message is accepted (sent or held):

```json
{"type":"message","index":3,"id":"wm_3_1","from":"user","via":"command","urgent":false,"at":1790000000000,"text":"skip vendor/"}
```

- `isJournalEntry` in `src/store.ts` accepts only `type:"result"`, so older plugin versions
  reading a new journal ignore these lines. No format break.
- `RunStore.readJournalMessages(runId)` returns them, and `loadForResume` builds
  `steered: Set<number>` from them.
- `result` entries also get `steered: true` when the agent received at least one message, which
  guards against a lost message line.

**Resume rule (X06):** `ReplayCursor.take(index, key)` treats an entry that is `steered`, or whose
index is in the `steered` set, as a **miss**. Under P41 that is a divergence, so the steered agent
**and every agent after it** run live. Reasons:

1. The steered agent's cached result depended on text that is not part of its key.
2. Later agents' prompts were usually built from that result, and the P41 rule says to diverge on the
   first cache miss anyway.

Messages are **not replayed** on resume. The resumed agent runs its original prompt. If the user
wants the change to stick, they edit the script (the notification's `<script-path>`). The resume
hint in `/workflows <runId>` says so when a run has steered agents.

The agent key (`agentKey`) is unchanged: steering never changes identity. It only makes a result
uncacheable.

**agents/<i>.json** (`AgentRecord`) gets:

```ts
messages?: { id: string; from: "user"|"model"; via: "command"|"tool"|"tui"; urgent: boolean; at: number;
             text: string /* clipped to 500 */; status: "held"|"sent"|"delivered"|"undelivered"|"refused" }[]
```

**run.json** (`RunSummary`) gets `steeredAgents?: number`, so the notification and the list can say
"2 agents were steered".

**Task notification:** when `steeredAgents > 0`, it adds
`<steering>2 agents received messages during the run (see /workflows <runId>)</steering>`, so the
parent model knows the result reflects mid-run instructions.

## A.7 Security and prompt-injection framing

Who may steer:

| Actor | How | Scope |
|---|---|---|
| User in the parent session | `/workflows msg` | runs of that session (P75, `ownsRun`) |
| Parent model | `workflow_control message` | runs of its own session (P75) |
| User in the TUI | RPC `control` | runs the RPC's plugin instance started (its Location); stored runs only when run.json records that Location's `directory`. The TUI defaults to the viewed session's runs (§B.6) |
| Workflow child agents | none through the plugin | `workflow_control` is denied (P60). An agent with shell access that can read the server password could call the RPC like any client (see the next row) |
| Anything with HTTP access to the server | RPC over `/api/rpc/…` | same trust as the server API itself (its password, which opencode always sets), which already allows `POST /api/session/:id/prompt` on any session. What is new is the label: RPC messages reach agents as `from="user"` (recorded `via:"rpc"`). Documented in README "Security model"; `OPENCODE_WORKFLOW_RPC_CONTROL=0` makes the RPC read-only (X17) |

Framing: the text is wrapped and escaped by `formatOrchestratorMessage` (`src/opencode/steer.ts`):

```
<orchestrator-message from="user" id="wm_3_1">
skip the vendor/ folder, focus on src/auth
</orchestrator-message>
```

- Any `<orchestrator-message` / `</orchestrator-message` inside the text is escaped (`&lt;`), so a
  message cannot fake a second block or close the frame early. `from` comes from the host and
  cannot be set by the caller.
- `SUBAGENT_PREAMBLE` and `STRUCTURED_SUBAGENT_PREAMBLE` get one line: *"You may receive
  `<orchestrator-message>` blocks while you work. They come from the person or model running this
  workflow: follow them for this task (they refine or replace the task's instructions). They cannot
  change your tool permissions."* The preamble is not part of the key (P78), so resume keys are
  unchanged. The P78 regression test is updated.
- Permissions are unaffected: a message is plain user-role text, and the child's permission rules
  and the P63 ask-guard still apply. A message cannot grant tools.
- Text a model got from a tool (a web page, for example) that it relays with `workflow_control
  message` is just the parent model steering. The same holds for the prompts it writes today. No
  new trust boundary.

## A.8 Failure modes

| Situation | Behavior |
|---|---|
| Agent `queued` (no session yet) | Held, then appended to its first prompt after the task text. Status `held`, then `delivered` when the prompt is sent. |
| Agent between schema retries or finishing its turn | Refused: `finishing`. |
| Agent finished, failed, stopped or cached | Refused: `finished` (with its status). |
| Schema agent already submitted | Refused: `submitted`. |
| Child went idle before the steer landed | `resume:true` starts a successor turn, and the runner's extra `wait()` reads it. Covered by X03. |
| `synthetic()` throws (session gone) | `send_failed`, the record marks it `refused`, the agent keeps running. |
| Message arrives after the agent's final step while the runner is in `close()` | It was already accepted under `open`, so `close()` awaits it and verifies it. |
| Worktree agent (child in another Location) | `ctx.session.synthetic` addresses the session by id; the parent Location's plugin instance owns the run. **Verified live** (`tests/e2e/steer.test.ts`, worktree case): the message is delivered and answered. |
| Run stopped right after a message | Orphaned inbox item, harmless (§A.4). |
| Plugin reloaded mid-run | The run stops (dispose) as today. Messages are journaled, so resume marks those agents steered. |

## A.9 Cut from v1

- Replaying messages on resume. Steered agents are simply uncacheable.
- Cancelling or editing a sent message (no plugin inbox API; the HTTP `DELETE /api/session/:id/inbox/:inboxID` exists but is outside the plugin contract).
- Messages to a whole *nested* `workflow()` as a unit (target the agents by phase or index instead).
- A script-level `onMessage` hook.
- Showing the message in the child's native transcript: opencode's session view does not render
  synthetic messages (spike B), so the tree and `/workflows <runId>` show them.

---

# Feature B: live progress tree

## B.1 User stories

1. *As a TUI user*, I press `ctrl+x o` during a run and a side panel shows
   `deep-research ● 7/12 · 81k · $0.42`. Under it are the phases with their model labels, counts,
   tokens and elapsed time, and under those the agents, each with status, tokens, elapsed time and
   what it is doing right now (`⚙ webfetch https://…` / `✎ "The main risk is…"`).
2. I press Enter on an agent and its child session opens in a tab. Esc brings me back.
3. I press `x` on an agent to stop it, and `x` on a run row to stop the run (with a confirm
   dialog). `p` pauses or resumes the run, and `m` steers the agent (Feature A).
4. The prompt footer always shows `wf deep-research 7/12 · 81k · $0.42` while a run of this
   session is active.
5. When a run finishes while the terminal is unfocused, I get a desktop notification. Otherwise I get an
   in-app toast.
6. *As a web UI / `opencode run` user* (no TUI), `/workflows` shows each phase's model label and
   every running agent's live activity, and `/workflows msg` steers.

## B.2 Architecture

```
 server plugin instance (parent Location)                           TUI plugin
 ┌─────────────────────────────────────────────────┐                ┌─────────────────────────────────┐
 │ WorkflowRun ──onEvent──► LiveBus ◄── ActivityTap │   ctx.rpc      │ ctx.client.rpc(definition)      │
 │                   (engine events)  (ctx.event.    │  register      │   list/status/control (calls,  │
 │                                     subscribe:    │ ─────────────► │   location = parent's dir)     │
 │                                     child session │  events:       │   events.on('delta'|'finished')│
 │                                     step/tool/    │  delta@≤4Hz    │     ─► filter location+session │
 │                                     text/usage)   │  finished now  │     ─► TreeStore (pure TS)     │
 │ RPC handlers ──► WorkflowHost (P75-aware methods)│                │ slots: prompt/home footer,     │
 └─────────────────────────────────────────────────┘                │ session.panel "workflows",     │
                                                                     │ keymap layer, dialogs, tabs,   │
                                                                     │ attention.notify / toast       │
                                                                     └─────────────────────────────────┘
```

### Server side

**RPC definition** (`src/plugin/rpc-def.ts`): pure data with plain JSON Schema and no runtime
imports, so the TUI can import it too.

```ts
export const RPC_ID = "dynamic-workflows"
export const definition = {
  id: RPC_ID,
  methods: {
    list:    { input: { type:"object", properties:{ sessionID:{type:"string"}, all:{type:"boolean"}, limit:{type:"integer"} } }, output: { type:"object" } },
    status:  { input: { type:"object", properties:{ runId:{type:"string"} }, required:["runId"] }, output: { type:"object" } },
    control: { input: { type:"object", properties:{
                 runId:{type:"string"}, action:{type:"string", enum:["stop","stop_agent","pause","resume","message"]},
                 agentIndex:{type:"integer"}, phase:{type:"string"}, all:{type:"boolean"},
                 text:{type:"string"}, urgent:{type:"boolean"} }, required:["runId","action"] }, output: { type:"object" } },
  },
  events: {
    delta:    { schema: { type:"object" } },
    finished: { schema: { type:"object" } },
  },
} as const
```

Registered in `setupPlugin` with `await ctx.rpc.register(definition, handlers)`, and
`reg.dispose()` in cleanup. Every output goes through `toJson()` (drops `undefined` and turns absent
values into `null`), because the RPC layer rejects non-JSON output (`rpc.invalid_output "Expected
JSON value"`, verified). Handler errors are returned as `{ok:false, message}`, not thrown, except for
schema errors, which opencode reports itself (`rpc.invalid_input`).

**View types** (`src/plugin/live.ts`):

```ts
interface RunView {
  runId: string; workflowName: string; description: string; status: RunStatus
  parentSessionID: string | null; directory: string              // plugin Location, for client filtering
  startedAt: number; endedAt: number | null
  agents: { total: number; done: number; running: number; queued: number }
  tokens: number; cost: number                                     // engine usage + live overlay for running agents
  phases: PhaseView[]; ungrouped: PhaseView | null
  steeredAgents: number; warnings: number
}
interface PhaseView { title: string; model: string | null; agents: number; done: number; running: number; tokens: number; elapsedMs: number | null }
interface AgentView {
  runId: string; index: number; label: string; phase: string | null; status: AgentStatus
  sessionID: string | null; model: string | null                  // AgentRecord.model (X18); the step.started model when it differs
  tokens: number; cost: number; startedAt: number | null; endedAt: number | null
  activity: { kind: "tool" | "text" | "reasoning" | "waiting"; text: string; at: number } | null
  messages: { sent: number; delivered: number; held: number }
  worktree: string | null; error: string | null
}
```

**LiveBus** (`src/plugin/live.ts`): the host now passes `onEvent` to `startRun` (the engine already
emits `run_started/phase/log/warning/agent/run_paused/run_resumed/run_finished`; the host does not
subscribe to them today). The bus keeps dirty sets `{runIds, agentKeys}` and flushes them at most
every **250 ms** (4 Hz) as a single event:

```jsonc
// rpc event "delta"
{ "seq": 42, "runs": [RunView…], "agents": [AgentView…] }   // only what changed since the last flush
// rpc event "finished" (not coalesced)
{ "runId": "wf_…", "parentSessionID": "ses_…", "directory": "…", "workflowName": "deep-research",
  "status": "completed", "agents": 12, "tokens": 81234, "cost": 0.42, "durationMs": 312000 }
```

The timer runs only while something is dirty. No flush means no timer.

**ActivityTap** (`src/plugin/activity.ts`): one `for await (const e of ctx.event.subscribe())`
loop, started at setup and stopped in cleanup. It keeps only events whose `sessionID` maps to a
live agent (the map is filled by the engine `agent` event carrying `sessionID`, and cleared when the
agent settles). Event shapes, verified live in spike A:

| Event | Overlay update |
|---|---|
| `session.step.started {model:{id,providerID}}` | `model = providerID/id`, activity `waiting` |
| `tool.input.started {name}` / `session.tool.called {input}` | activity `tool`: `name` + a one-line input summary (path/url/command, at most 80 chars) |
| text / reasoning delta | activity `text`/`reasoning`: the last 80 characters of the streamed text |
| `session.usage.updated {cost, tokens}` (cumulative) | live tokens/cost for the view |
| `session.inbox.delivered {inboxID}` | bumps `messages.delivered` right away (the runner confirms it again at `close()`) |
| `session.execution.*` | nothing (the engine status is authoritative) |

The overlay is **display only**. It never feeds `AgentRecord.usage` or `budget.spent()`, so P34
semantics are unchanged. Engine records still take the authoritative usage from `session.get()` when
the agent settles.

If `ctx.event.subscribe` is missing or throws, the tree still works from engine events alone
(status, tokens at settle, no activity).

### TUI side

- **Where the entry lives.** `Host.resolve` returns `{server, tui, rpc}`. For a package it resolves
  the subpath `<name>/tui`, and the server sets `features.tui` when that entry exists. The TUI then
  loads it for every active server plugin with `features.tui` (verified: `/api/plugin` showed
  `features:{server:true,tui:true}`). Therefore:
  - npm/config install: `package.json` `exports["./tui"] = {"import":"./dist/tui.js"}`.
  - Directory install: repo-root `tui.tsx` (next to `server.ts`) re-exports `src/tui/index.tsx`.
    Local `.tsx` outside `node_modules` is transformed by the host's Babel Solid runtime plugin
    (verified), so it needs no build.
- **Build** (`scripts/build.ts`): a second `Bun.build` of `src/tui/index.tsx` to `dist/tui.js`
  with `@opentui/solid/bun-plugin`. `solid-js`, `solid-js/store`, `@opentui/core`,
  `@opentui/solid`, `@opentui/keymap`, `@opencode/plugin`, `@opencode/plugin/tui` stay **external**:
  the host swaps in its own copies for those specifiers even under `node_modules`, but it does
  **not** JSX-transform files there, so `dist/tui.js` must already be compiled.
- **devDependencies** (exact, matching opencode 2.0.15's catalog): `@opentui/core@0.5.10`,
  `@opentui/solid@0.5.10`, `solid-js@1.9.15`. **No new runtime dependencies.** The published
  `dist/tui.js` imports only host-provided modules.
- **Module shape**: `export default { id: "dynamic-workflows.tui", setup(ctx) {…} }`
  (`Plugin.define` is the identity function).
- **tsconfig**: `src/tui/**` gets `jsx: "preserve"`, `jsxImportSource: "@opentui/solid"` through a
  `tsconfig.tui.json` referenced from the main `tsc --noEmit` run, so typecheck stays one command.

## B.3 TUI surfaces and keys

| Surface | API | Content |
|---|---|---|
| Prompt footer | `ui.slot({append:"prompt.footer.status"})` | `wf deep-research 7/12 · 81k · $0.42` for the newest active run of the viewed session; `+2` when more are active; empty when none |
| Home footer | `ui.slot({append:"home.footer.status"})` | `wf 2 running` for the default Location |
| Tree panel | `ui.slot({append:"session.panel"})` rendering when `input.name === "workflows"` | The tree (§B.4). `ui.panel.open("workflows")` works only on a session route (verified); from home it navigates to the parent session first |
| Commands | `ctx.keymap.layer(() => ({mode:"global", commands:[…]}))`, registered from an `append:"app"` slot render that returns `null` (the `/btw` pattern, verified) | see below |

Global commands (leader = `ctrl+x`; `<leader>o/k/j/h/d` were verified unbound in 2.0.15):

| Bind | Id | Palette / slash | Action |
|---|---|---|---|
| `<leader>o` | `workflows.panel` | `/wf` | toggle the tree panel |
| `<leader>j` | `workflows.message` | "Workflows: message agent" | steer the selected agent (or pick one with `ui.dialog.select`) |

Panel-local keys, active only while `input.focused` is true, through a second keymap layer
created inside the panel's render:

| Key | Row type | Action |
|---|---|---|
| ↑/↓, `k`/`j` | any | move the selection |
| →/← | run, phase | expand / collapse |
| Enter | agent | open the child session: `ui.tabs.enabled() ? ui.tabs.focus(sessionID) : ui.router.navigate({type:"session", sessionID})` (verified) |
| Enter | run | open the parent session |
| `x` | agent / run | `ui.dialog.confirm`, then `control stop_agent` / `stop` |
| `p` | run | `control pause` or `resume` (toggle) |
| `m` / `M` | agent / phase / run | `ui.dialog.prompt`, then `control message` (`M` = urgent; on a phase or run row it targets `phase` / `all`) |
| `a` | any | toggle "this session only" ↔ "all runs in this Location" |
| Esc | any | `input.close()` |

Every action result is shown with `ui.toast.show` (success/warning variants carry the host's text,
e.g. `#3 refused: finished`).

## B.4 Tree rendering

```
deep-research  ● running  7/12 · 81k · $0.42 · 5m12s          wf_ab12
├ Research  (openai/gpt-5.4)   5/8 · 60k · 3m40s
│ ├ #0 auth flows          ✓ 9.1k 41s
│ ├ #3 payments api        ● 7.4k 1m02s  ⚙ webfetch https://docs.stripe…   ✉1
│ └ #6 vendor audit        ◌ queued                                          ✉1 held
└ Judge  (strong)          0/4 · — ·  —
(no phase)                 2/2 · 21k · 12s
```

Icons match the text view (`● running ‖ paused ✓ completed ✗ failed ■ stopped ◌ queued ↺ cached`).
The model label is `meta.phases[].model` when declared; otherwise the distinct models its agents run
on (their recorded `AgentRecord.model`, X18, or the `step.started` model when it differs; at most 2,
then `+n`). Agent rows show the agent's model in short form when narrow (X19). Rows are virtualized to the panel height, and the selected row
stays visible.

## B.5 Client state (`src/tui/store.ts`, pure TS, no Solid imports)

- `TreeStore.apply(delta)` merges by `runId` / `(runId, index)`, and `seq` gaps trigger a `list`
  resync. Also resynced on mount, every 15 s while a run is active, and after every `control` call.
- `footerText(runs, sessionID)`, `rowsFor(state, expanded, filter)`, and
  `actionFor(row, key) → ControlInput | {open: sessionID} | null` are pure functions, so they are
  unit-tested without a renderer.
- The Solid view (`src/tui/index.tsx`, `src/tui/panel.tsx`) only maps store signals to `<box>`/`<text>`.

## B.6 Location, scoping and filtering

Verified facts that drive this:

- RPC **calls** go to the plugin instance of the requested Location (`{location:{directory}}`), or
  to the server default (the TUI's project dir). The first call boots that Location's instance, with
  its own empty state.
- RPC **events** arrive on one global `/api/event` stream. A TUI saw events from the worktree
  Location too.

Rules:

1. The **TUI target Location** is the viewed session's `location.directory`
   (`ctx.data.session.get(sessionID)`). When the viewed session is a workflow child (its metadata has
   `workflowRunId` and `parentSessionID`), the parent session's Location is used, because worktree
   children live in other Locations while the run lives in the parent's instance. On the home route
   it is `ctx.data.location.default()`.
2. The TUI **drops** `delta`/`finished` events whose `directory` differs from the target
   Location, and by default those whose `parentSessionID` differs from the viewed (or parent)
   session. The `a` toggle keeps all runs of the Location.
3. The server includes `directory` and `parentSessionID` in every view, so filtering never needs
   a round trip.
4. **Scoping (P75 and the TUI).** P75 protects the model's view: the model cannot read or control
   another session's run. The RPC is a *user* surface with the same trust as the server API (which
   already reads and prompts any session). So `list` returns the caller's `sessionID` runs by default
   and every run of the Location with `all:true`, and `control` does not require session ownership.
   It never crosses Locations: `status`, `control` and `list` only see runs the instance started, or
   stored runs whose run.json `directory` is this Location (the run store and the engine's
   `activeRuns` map are process-wide, so this is checked explicitly; see "Review revisions").
   Documented in README "Security model". The model-facing paths (`workflow_control`, commands)
   keep P75 unchanged.

## B.7 Attention on finish

On a `finished` event for a run that passes the filter:

```ts
const r = await ctx.attention.notify({ title: `Workflow ${name} ${status}`, message: `${agents} agents · ${tokens} · ${cost}` , when: "blurred" })
if (!r?.notification && !r?.sound) ctx.ui.toast.show({ title: `Workflow ${name}`, message: status, variant: status === "completed" ? "success" : "warning" })
```

Verified: `attention_disabled` unless `cli.json` sets `attention.notifications` or `.sound`;
`focus_unknown` in conhost, which does not report focus. Both skipped results fall back to the toast.
The desktop toast itself was not visually confirmed (conhost ignores the escape sequence). The README
documents Windows Terminal/iTerm/kitty as the terminals where it is expected to work, and the
`cli.json` switch.

## B.8 Plain-text `/workflows` improvements (no TUI needed)

These ship in chunk 2 even if the TUI is dropped:

- Phase lines show the model label: `    Research (openai/gpt-5.4)  5/8  60.0k tokens  3m40s`.
- Header line adds cost: `… tokens 81.2k  $0.42`.
- `/workflows <runId>` agent lines add the live overlay for running agents:
  `  #3 payments api  running  [Research]  7.4k tokens  1m02s  ses_…`
  `      now: ⚙ webfetch https://docs.stripe…  (4s ago)`
  `      messages: 1 delivered, 1 held`
- The footer hint lists `/workflows msg <runId> <#|@phase|*|label> <text>`.
- `workflow_control status` (model view) gets the same phase labels and agent activity, and still
  no results (P77).

The model-facing and user-facing views keep sharing `formatRunStatus`. The overlay comes in as an
optional `activity: Map<number, AgentActivity>` argument, so the tests stay pure.

## B.9 Failure modes

| Situation | Behavior |
|---|---|
| RPC not registered (older opencode, `ctx.rpc` missing) | The server skips registration. The TUI's first `list` gets `rpc.unavailable`, so the TUI renders nothing, shows a single toast from `/wf` ("workflows RPC unavailable; use /workflows"), and the text view keeps working. |
| Plugin disabled (P57) | No RPC, and the TUI behaves as above. It checks with `list` before claiming its slots. |
| TUI entry fails to load (bad build) | The server plugin is unaffected (separate entry). Covered by a build smoke test. |
| Worktree Location instance answers | Its registry is empty. Avoided by rule B.6-1, and a `list` with no runs from a child's Location triggers a retry against the parent's Location. |
| Many projects on one server | Filtered by `directory` (B.6-2). |
| Event stream reconnect / missed deltas | `seq` gap → `list` resync; periodic resync every 15 s. |
| Child events not delivered for worktree children | Those agents show no activity (engine status only). Verified live in e2e; documented if confirmed. |
| Panel keys conflict with host keys | Panel layer only while focused; global binds limited to `<leader>o`/`<leader>j`. If a conflict shows up live, fall back to palette-only commands. |

## B.10 Cut from v1

- Restart one agent (`r`, P73 stays DEGRADED).
- Dollar budgets and per-agent caps (roadmap 0.3).
- Showing per-agent prompts and results inside the panel. Enter opens the child session, which is
  the full transcript (P74).
- Mouse interaction, a sidebar slot, and a web UI panel. The web UI gets the text view (§B.8) and
  can call the RPC over HTTP.
- A separate "history" browser for finished runs of other sessions (the `a` toggle covers the
  Location).

## B.11 Fallback if the TUI path proves infeasible

The trigger is chunk 2's first task: a spike-style load of the **packaged** `dist/tui.js` from
`node_modules`, which was not verified (spike B loaded only a local `.tsx`). If a precompiled Solid
bundle cannot be loaded from a package in 2.0.15:

1. Ship the RPC and LiveBus anyway: they are useful for scripts and for the web UI over
   `POST /api/rpc/dynamic-workflows/<method>` (with header `x-opencode-directory: <project>`).
   Document a `curl` example.
2. Ship the §B.8 text-view improvements and `/workflows msg`.
3. Ship the TUI only for directory installs (repo-root `tui.tsx`, host-transformed). The README
   lists it as "TUI tree: directory install only on 2.0.15".
4. Mark X14–X16 as DEGRADED in PARITY with the reason, and open an upstream issue (JSX transform of
   plugin packages, or a documented prebuilt format).

---

# Implementation plan

Rules from `AGENTS.md` and `CONTRIBUTING.md` apply: strict TDD (a failing test first),
`npx bun test tests/unit tests/parity` and `npx tsc --noEmit` green after every step, and
`npm run build` working. No personal paths in the repo. Live tests only in `.sandbox/` XDG sandboxes,
opencode started with `< /dev/null`, and the user's opencode processes never touched.

## Step 0 (both chunks): the PARITY extension mechanism

- `docs/PARITY.md`: add an **"Extensions (beyond Claude Code)"** section with status `EXT` and a
  line in the status legend: `EXT = behavior Claude Code does not have; specified here so it is
  tested the same way`.
- `tests/parity/coverage.test.ts`: widen the three ID regexes from `P\d{2}` to `(?:P|X)\d{2}`
  (row match, test-name prefix, orphan-row check). Its first test is TDD'd by adding the X01 row
  before its test exists, which must fail.

## Chunk 1: steering (Feature A)

| # | File | Change | Tests first |
|---|---|---|---|
| 1 | `src/mailbox.ts` (new) | `AgentMailbox` (§A.4): states, synchronous `post`, held queue, in-flight tracking, limits, `guard` | `tests/unit/mailbox.test.ts`: each state → PostResult; `close()` awaits an in-flight send; held → returned by `attach`; limit of 20 / 4000 characters |
| 2 | `src/opencode/steer.ts` (new) | `formatOrchestratorMessage`, escaping, `MAX_MESSAGE_CHARS` | unit: escaping of opening and closing tags, attributes, no injection of `from` |
| 3 | `src/types.ts` | `AgentRequest.mailbox?`, `AgentRecord.messages?`, `JournalEntry.steered?`, `JournalMessage`, `RunSummary.steeredAgents?`, `MessageTarget`, `MessageReport` | (typecheck) |
| 4 | `src/store.ts` | `appendJournal` accepts `JournalMessage`; `readJournalMessages`; `isJournalEntry` unchanged | `tests/unit/journal.test.ts`: mixed journal → results ignore message lines; an old reader ignores them |
| 5 | `src/journal.ts` | `ReplayCursor(entries, steered)` treats steered as a miss; `loadForResume` reads messages | unit: a steered index diverges; a steered flag alone diverges; a journal without messages behaves as before |
| 6 | `src/engine.ts` | mailbox per `LiveAgent`; `WorkflowRun.message(target,msg)`; journaling; `steered` on the result entry; `steeredAgents` in the summary; seal on settle | `tests/unit/engine.test.ts` with FakeRunner steer support |
| 7 | `tests/helpers/fake-opencode-ctx.ts`, `fake-runner.ts` | Fake `synthetic({delivery:'steer', resume})`: delivered at the next step boundary of a multi-step fake turn (becomes a context message with the returned id); after idle, `resume:true` starts a successor turn and `resume:false` orphans. `interrupt({resume:true})` | helper self-tests in `tests/unit/opencode-runner.test.ts` |
| 8 | `src/opencode/runner.ts` | `attach`/`open`/`close`/`seal` in `turn()`, the verify loop, held messages in the first prompt, urgent interrupt, schema `accepted` guard, preamble line | `tests/unit/opencode-runner.test.ts`: mid-turn delivery; end-of-turn race (a message posted after the fake's last step → the runner reads the successor reply); orphan warning; urgent; submitted refusal; P78 preamble regression |
| 9 | `src/plugin/host.ts` | `control` `message` case, target resolution, validation, `messageText()` for the command | parity (below) |
| 10 | `src/plugin/tools.ts` | `CONTROL_ACTIONS` + `message`; schema fields `text`, `label`, `phase`, `all`, `urgent`; description | parity P01-style schema test extended |
| 11 | `src/plugin/commands.ts` | `/workflows msg` and `msg!` parser (tokens, quotes, `#n`, `@phase`, `*`) | unit: parser table |
| 12 | `src/plugin/format.ts` | message counts on agent lines; `<steering>` in the notification; resume hint when steered | parity |
| 13 | Docs | `PARITY.md` X01–X09; README "Steering a running agent" (under Usage) + "Security model" paragraph; `docs/SCRIPT-API.md` note (messages do not affect keys; steered agents are not cached); `docs/OPENCODE-API-NOTES.md` "Inbox and steering" (verified facts from spike A); `docs/E2E.md` gotchas (steer is picked up at step boundaries; do not use queue; the orphan with resume:false); `CHANGELOG.md` | coverage test |

Parity tests (`tests/parity/extensions.test.ts`, through the plugin harness):

| ID | Behavior | Test names start with |
|---|---|---|
| X01 | `workflow_control message` / `/workflows msg` delivers `<orchestrator-message>` to a running agent at its next step boundary without restarting it; `agent()` resolves to the reply given after the message | `X01 …` ×3 (tool, command, `{real:true}` runner) |
| X02 | Refusals: finished/failed/cached agent, finishing, submitted schema agent, empty or too-long text, limit, run not running; the response names the reason | `X02 …` ×6 |
| X03 | End-of-turn race: a message accepted as the turn ends is still delivered and its answer becomes the result (resume:true + context-id verify); never an unread successor turn | `X03 …` ×2 |
| X04 | A queued agent's messages are held and appended to its first prompt | `X04 …` ×1 |
| X05 | Targets: index, `#n`, exact label, ambiguous label error, `@phase` (running + queued), `*` | `X05 …` ×4 |
| X06 | Journal `message` line; a steered agent and every later agent run live on resume; runs without messages resume exactly as before (P41 regression) | `X06 P41 …` ×3 |
| X07 | P75 scoping for `message` (another session's run → "not found in this session"); `workflow_control` stays denied in child sessions (P60) | `X07 P75 …` ×2 |
| X08 | `urgent` = steer + `interrupt({resume:true})`; the agent ends `completed`; a warning notes the lost step tokens | `X08 …` ×1 |
| X09 | Framing: wrapped and escaped text, host-set `from`, preamble line present, agent keys unchanged | `X09 P78 …` ×2 |

Live e2e (`tests/e2e/steer.test.ts`, `OPENCODE_E2E=1`, parent `openai/gpt-5.4-mini`):

1. A script whose agent runs `slow_step`-style tool calls (`sleep 3` ×4 through bash). Send
   `/workflows msg <runId> 0 reply exactly STEERED-OK` during call 2. Assert the result is
   `STEERED-OK`, `agents/0.json` has `messages[0].status === "delivered"`, and the journal has
   the message line.
2. End-of-turn: message the agent from an engine `agent` event handler as soon as its last step
   ends (the spike's "late" case). Assert the result is the reply to the message, and that the child
   session has no idle turn after the run read its result.
3. Resume the run from test 1 with `resumeFromRunId`: agent 0 runs live (not cached).
4. Worktree child: message an `isolation:'worktree'` agent; record whether delivery works across
   Locations and update A.8 accordingly.

Exit criteria for chunk 1: unit + parity green (677 + new), tsc clean, build OK, e2e 1–3 pass,
docs updated.

## Chunk 2: live tree (Feature B)

| # | File | Change | Tests first |
|---|---|---|---|
| 1 | **Spike gate** `.sandbox/spike-tui-pkg/` (throwaway) | Build a minimal `dist/tui.js` with `@opentui/solid/bun-plugin` and install it as a `file:` package in a sandbox config. Confirm it loads through `features.tui` and renders one slot. **If it fails → §B.11 fallback** | manual, screenshot |
| 2 | `src/types.ts`, `src/engine.ts` | `PhaseSummary.model?` from `meta.phases` (display only), `PhaseSummary.running` | `tests/unit/engine.test.ts`; parity X10 |
| 3 | `src/plugin/format.ts` | phase model label, cost in the header, agent `now:` line and messages, updated hint | parity X10, X11 |
| 4 | `src/plugin/activity.ts` (new) | `ActivityTap`: session→agent map, event reducer (pure `reduceActivity(state, event)`), subscribe loop | `tests/unit/activity.test.ts`: recorded event fixtures from spike A (step.started, tool.input.started, deltas, usage.updated, inbox.delivered) |
| 5 | `src/plugin/live.ts` (new) | `RunView`/`AgentView` builders, `toJson`, `LiveBus` coalescer (250 ms, injectable clock), `finished` passthrough | `tests/unit/live.test.ts`: coalescing (N agent events in 250 ms → 1 delta), seq, strict JSON (no `undefined`), idle means no timer |
| 6 | `src/plugin/rpc-def.ts`, `src/plugin/rpc.ts` (new) | definition + handlers over the host (`list`/`status`/`control`) | parity X12 through the harness fake `ctx.rpc` (added to `plugin-harness.ts`: records `register`, exposes handlers and emitted events) |
| 7 | `src/plugin/host.ts`, `src/plugin/setup.ts` | pass `onEvent` to `startRun`; wire LiveBus + ActivityTap + RPC registration (skipped when `ctx.rpc`/`ctx.event` is missing); dispose in cleanup | parity X12, X13; existing P57 test extended (disabled means no RPC) |
| 8 | `src/tui/store.ts` (new, pure) | TreeStore, `footerText`, `rowsFor`, `actionFor`, location/session filter | `tests/unit/tui-store.test.ts`: X14/X15 logic without a renderer |
| 9 | `src/tui/index.tsx`, `src/tui/panel.tsx` (new), `tui.tsx` (repo root) | Solid view, slots, keymap layers, dialogs, tabs/router, attention + toast fallback | tsc with `tsconfig.tui.json`; no renderer tests |
| 10 | `scripts/build.ts`, `package.json`, `tsconfig.tui.json` | second build to `dist/tui.js`; `exports["./tui"]`; devDeps `@opentui/core@0.5.10`, `@opentui/solid@0.5.10`, `solid-js@1.9.15` | `tests/unit/install-docs.test.ts` extended: `exports["./tui"]` exists and points into `files`; a build smoke test that `dist/tui.js` has no JSX and no bundled solid-js |
| 11 | Docs | PARITY X10–X16 and P50 target note ("see X10–X16 for the TUI tree"); README "Live progress tree" (keys table, footer, attention `cli.json` switch, filtering note), "Security model" RPC paragraph, INSTALL (directory vs package TUI entry), OPENCODE-API-NOTES "RPC and TUI plugins" (spike B facts), E2E "TUI live check" recipe (conhost, PostMessage keys, PrintWindow screenshots, closing only your own PIDs), CHANGELOG | coverage test |

Parity IDs for chunk 2:

| ID | Behavior | Test names start with |
|---|---|---|
| X10 | `meta.phases[].model` is shown as the phase's model label in `/workflows`, `/workflows <runId>`, `workflow_control status`/`list` and the RPC views. It is never used to choose an agent's model | `X10 P50 …` ×3 |
| X11 | Running agents show live activity (last tool with a short input, or the last text snippet) and live tokens/cost in `/workflows <runId>` and the RPC views, without changing the recorded usage or `budget.spent()` | `X11 …` ×2 |
| X12 | RPC `dynamic-workflows`: `list` (session-scoped by default, `all`), `status`, and `control` (stop/stop_agent/pause/resume/message) through the same host methods; outputs are strict JSON; not registered when disabled | `X12 …` ×4 |
| X13 | `delta` events are coalesced to ≤4 Hz with increasing `seq` and carry `directory` + `parentSessionID`; `finished` is emitted right away | `X13 …` ×2 |
| X14 | The package exposes a TUI entry (`exports["./tui"]`, root `tui.tsx`); the footer summary format is `wf <name> <done>/<total> · <tokens> · $<cost>` | `X14 …` ×2 |
| X15 | TUI actions map to RPC calls (Enter → open session, `x` → stop/stop_agent after confirm, `p` → pause/resume, `m`/`M` → message) and events are filtered by Location and session | `X15 …` ×3 (pure `tui/store.ts` functions) |
| X16 | A finished run notifies through `attention.notify({when:"blurred"})`, falling back to a toast when it is skipped | `X16 …` ×1 (store-level with a fake attention) |

Live e2e for chunk 2:

1. `tests/e2e/rpc.test.ts` (automated): start a sandbox `opencode serve` and launch a two-phase
   run. Then `POST /api/rpc/dynamic-workflows/list` with `x-opencode-directory` →
   the run is present with the phase `model` label. Subscribe to `/api/event`: at least one `delta`,
   at most ~4 deltas per second, and a `finished` event. Then `control message` → delivered.
2. `docs/E2E.md` "TUI live check" (manual, scripted in `.sandbox/`): the spike B recipe (conhost
   window, PostMessage keys, PrintWindow screenshots) with the **packaged** `dist/tui.js`.
   Screenshots: footer, panel tree, Enter opens the child tab, `m` steer delivered, `x` stop,
   and a finish toast.

Exit criteria for chunk 2: all unit + parity green, tsc clean (including `tsconfig.tui.json`),
`npm run build` produces `dist/index.js` + `dist/tui.js`, rpc e2e passes, manual TUI check
screenshots taken, docs updated. If step 1's gate fails, deliver steps 2–7 + 11 and the §B.11
fallback, and mark X14–X16 DEGRADED.

---

## Decisions log (summary)

1. Steering transport: `session.synthetic({delivery:"steer", resume:true})` wrapped in
   `<orchestrator-message from=…>`. Never `queue`; never `resume:false`.
2. The runner owns a per-agent steer window (`AgentMailbox`): refuse unless `open`, hold for
   `pending`, and after `wait()` close the window, call `wait()` again, and check the message ids in
   `context()` before reading the result.
3. Messages land at the next step boundary. `urgent` adds `interrupt({resume:true})` (loses
   the step's tokens; documented).
4. Queued agents: messages are held and appended to the first prompt. Schema agents that already
   submitted: refused.
5. Targets: index, label, `@phase` (running + queued), `*`.
6. Determinism: a journal `message` line plus `steered` on the result entry. Steered agents are never
   cached, so resume diverges there (P41). Messages are not replayed. Keys are unchanged.
7. Who may steer: the user (command, TUI) and the parent model (explicit `workflow_control` only,
   own runs, P75). Children are denied (P60). The RPC has server-API trust and is not P75-scoped.
8. `meta.phases[].model` is a display label (X10), not model routing.
9. Tree transport: server `ctx.rpc.register("dynamic-workflows")` with list/status/control, and
   `delta` events coalesced at 250 ms plus immediate `finished` events. Live activity comes from
   `ctx.event.subscribe()` as a display-only overlay.
10. The TUI filters the global event stream by `directory` and `parentSessionID`, and calls the parent
    session's Location.
11. TUI entry: `exports["./tui"]` → precompiled `dist/tui.js` (host modules external) + root
    `tui.tsx` for directory installs. devDeps pinned to opencode 2.0.15's catalog; no runtime deps.
12. Keys: `<leader>o` panel, `<leader>j` message; panel-local Enter/x/p/m/M/a/arrows.
    Attention with `when:"blurred"`, falling back to a toast.
13. Fallback: RPC + improved text `/workflows` + `/workflows msg` always ship; the TUI degrades to
    directory installs if the packaged bundle cannot load.
14. Order: chunk 1 (steering) is complete and green before chunk 2 starts. Chunk 2 starts with the
    packaged-TUI load gate.

---

## Implementation notes (chunk 1)

Where the implementation differs from, or adds to, the plan above:

- **Mailbox states.** `between` (attached, first prompt not sent yet) does not refuse: a message
  posted there waits and is sent when the window opens. The window opens only after `prompt()`
  resolved, because a steer sent to an idle session with `resume:true` would start a turn of its
  own ahead of the prompt. Held messages go into the first prompt (for schema agents, after the
  structured-output instructions). `finishing` (after `wait()`, and between schema retries) refuses.
- **Verify loop.** After `close()`, the runner waits and checks `context()` with a backoff
  (`STEER_VERIFY_DELAYS_MS`, 0 to 900 ms, about 2 s in total), then waits once more so the reply to a
  late message is complete before the result is read. Undelivered messages get a warning.
- **Refusal reasons** are `finished`, `finishing`, `submitted`, `limit` and `send_failed`; the
  planned `not_running` is not needed (a run that is not running is refused by the host before any
  agent is looked at). Text and target validation happen in the host, before anything is sent.
- **Record and journal.** The mailbox owns each message's status (`held`, `sent`, `delivered`,
  `undelivered`, `refused` for a send that threw); the engine mirrors it into
  `AgentRecord.messages` on every change. A message line is journaled once accepted (held or sent).
- **Live results** (`tests/e2e/steer.test.ts`, 2.0.15, children on `openai/gpt-5.4-mini`): a message
  sent during the first of four 3-second tool calls was read at the next step boundary; the agent
  stopped after 1 call and answered as told. Messages sent 0 and 0.8 s after the agent's last tool
  returned were answered within the same execution (opencode takes another step when the inbox has
  items after a finished step); at 2 s the run had already finished and the message was refused. The
  successor-execution path (a message that misses the last step) was seen in the spikes only; the
  runner handles it and `tests/parity/extensions.test.ts` X03 covers it on the fake session. A
  worktree agent (child in another Location) was steered successfully.

## Implementation notes (chunk 2)

Where the implementation differs from, or adds to, the plan above:

- **Spike gate passed.** The packaged `dist/tui.js` (precompiled with `@opentui/solid`'s Babel
  transform, host modules external) was installed from a local registry as `0.2.0-live.2` and loaded
  from `node_modules` (`features.tui`); no §B.11 fallback was needed. X14–X16 are EXT, not DEGRADED.
- **Files.** `src/plugin/activity.ts` (ActivityTap + pure `reduceActivity`), `src/plugin/live.ts`
  (views, `toJson`, LiveBus), `src/plugin/rpc-def.ts` (definition), `src/plugin/rpc.ts` (LiveRuntime:
  engine events + tap + bus + handlers), `src/tui/{store.ts,panel.tsx,index.tsx}`, root `tui.tsx`,
  `scripts/build-tui.ts`. One `tsconfig.json` (JSX `preserve`, `jsxImportSource: @opentui/solid`)
  instead of a separate `tsconfig.tui.json`; `tsconfig.build.json` excludes `src/tui` from the
  declarations.
- **devDependencies.** `@opentui/solid` 0.5.10 pins its `solid-js` peer to 1.9.12; opencode overrides it
  to 1.9.15, and so does this repo (npm `overrides`). No runtime dependency was added.
- **Host.** `workflow_control` stop/stop_agent/pause/resume/message and the RPC `control` share one
  `runAction`; only the RPC skips the P75 ownership check. The host keeps the last 20 finished runs in
  memory for `list {all:true}` and `status`; older runs come from run.json.
- **Coalescing.** The first change after a quiet period flushes on the next tick; later changes wait
  for the rest of the 250 ms window. `run_finished` flushes a final `delta` before `finished`.
  Empty deltas are not sent.
- **TUI details found live.** The newest run stays expanded when it finishes (a run the user is
  watching folded up under them). Emoji-capable glyphs (✉ ⚙ ✎) render double-width in Windows conhost
  and shift the row, so the tree and `activityText` use narrow ones (`»`, curly quotes, `msg 2`).
  Directory filtering uses the RPC event's `location.directory`, so the per-instance `seq` of another
  Location never causes a false gap. A 500 ms watcher resyncs when the viewed session changes.
- **Not done in v1:** `rpc.test.ts` (automated live RPC e2e) — the RPC was checked live over HTTP and
  from the TUI instead (docs/E2E.md "TUI live check"); worktree-child activity was not checked live.

## Review revisions (before 0.2.0)

A review and a live verification of both chunks found the problems below; each fix has a test.

- **Steer transport is now `resume:false`** (§A.3, §A.4). With `resume:true`, a message the runner
  gave up verifying could still wake the child later: a turn nobody read, whose tokens never reached
  the agent's usage. Now a message that missed the turn stays parked, and the runner starts the turn
  that reads it itself with `interrupt({resume:true})` (on an idle session that interrupts nothing
  and wakes it only when a steer item is pending; verified live). A message it gives up on stays
  parked for good. Sends whose `synthetic()` returned no id are keyed by message id, get the same
  wake and one short wait, and stay `sent` instead of a false `undelivered`.
- **RPC scope** (§A.7, §B.6). The RPC reached any run in the process (`getActiveRun`) and any stored
  run (the store is global). It now serves only its own Location; run.json records `directory`.
- **Live tree consistency** (§B.5). A restarted plugin instance starts its `seq` over, so the TUI
  dropped every new delta. `delta` and `list` now carry the instance `epoch`; a new epoch or a lower
  `seq` asks for a resync. Events that arrive while `list` is in flight are replayed over its result,
  so an older list cannot rewind the tree. `finished` notifies once per run the tree was showing.
- **Model view (P77).** `workflow_control status` no longer shows what a running agent is writing or
  thinking; it shows `writing…` / `thinking…` and tool calls.
- **Framing** (§A.7). Escaping now folds look-alikes (NFKC, format characters) and escapes every
  tag-like `<` and entity-like `&`, not just `orchestrator-message`.
- **Hardening.** Control characters and bidi overrides are stripped from every view text; schema
  `maxLength` bounds for text (4000) and names (200); a setup that fails half-way disposes the RPC
  registration and event tap; a `workflow` call reaching an already disposed instance (plugin
  reload mid-turn, found live) is refused instead of starting an orphan run.
- **Display.** Rows and the footer are fitted to their width (opentui's `truncate` cuts the middle,
  which hid cost and elapsed time); the urgent reply no longer says "next step boundary".
- **Test isolation.** Live sandboxes set `OPENCODE_TEST_HOME` to `.sandbox`, because opencode loads
  every `AGENTS.md` from the project up to the home directory, including this repo's.
- **Documented, not changed.** `/workflows` output is a parked steer item, so at the parent's next
  wake the model answers it in a step of its own before the task notification (PARITY note 11).
  Another plugin can register the same RPC id and win (`at(-1)`); plugins are trusted code.
