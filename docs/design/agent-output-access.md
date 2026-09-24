# Design: how the parent model sees each agent's output

Status: implemented on branch `feat/steering-live-tree` (PARITY P79, X20, X21; P77 and P06 updated).

## Question

A workflow returns only its script's value. After a run has finished (or failed), can the parent
model look at each agent's own output, and should it? And can it do that without being confused or
nudged into polling before the task notification arrives?

Before this change:

- The notification carried the final value and a `<transcript-dir>` path, nothing per agent.
- The always-loaded `workflow` tool description never said that per-agent outputs exist. Only the
  authoring reference (`/workflow-authoring`) named `journal.jsonl`.
- The transcript dir is under the data dir, outside the project. opencode's `read` tool therefore
  asks for `external_directory` approval on every read.
- Model-facing `workflow_control` status showed each agent's status, model and tokens, never its
  output (P77), even after the run had finished. Its finished-run note pointed to `run.json`.
- The parent cannot read child sessions.

Claude Code's notification ends with a diagnostics block: "Per-agent results:
`<transcriptDir>/journal.jsonl` — one `{type:'result',...}` line per completed agent with its full
return value. If the result above is empty or unexpected, Read this file BEFORE diagnosing — do not
assume agents returned non-empty results."

## Candidates

Both were built on top of the steering branch and evaluated live in `.sandbox` with the free
`opencode/space-bunny-free` and `opencode/nemotron-3-ultra-free` as parent models, against a C0
baseline (no change). The scenarios covered a silent partial failure (E1), an empty result (E2), a
schema failure (E3), an aggregate that throws (E4), a slow run with a "what did it say?" follow-up
(E5), two runs in parallel (E6), a resume (E7), a per-agent lookup with and without a deny rule
(E8, E8D), a huge result (E9), and "get it right away, in this turn" (E10).

- **A: file pointers** (`cand-a-file-pointers`). Claude Code's approach. `<diagnostics>` named
  `journal.jsonl` and `agents/<i>.json`, the tool description said to read them only after the
  notification, and an `<agent-failures>` block listed the agents that returned nothing. A relative
  `dataDir` option let users keep runs inside the project.
- **B: a result action** (`cand-b-result-action`). `workflow_control {action:"result"}` listed agents
  or showed one in full, with status filters and two kinds of paging. To keep P77 strict it only
  answered once the notification's message id appeared in the parent's context (a notification
  gate, recorded in `notification.json`).

## What the evals showed

1. **Reading the files costs permission prompts and can hang.**
   - Asks multiply: 10 separate asks in each space-bunny E6 trial, 5 in one E3 trial.
   - Under `opencode serve` with no client attached, a turn woken by a notification sat blocked
     on one ask for the whole 150 s test.
   - With a deny rule, nemotron worked around it with a shell `cat`, and space-bunny gave no
     answer.
   - The read tool cuts each line at 2000 characters, and `journal.jsonl` stores one JSON line per
     agent, so a "full return value" cannot actually be read with `read`.

   B's action needed 0 file reads and raised 0 asks, and it also worked under the deny rule (E8D).
2. **B's notification gate caused the worst outcome of both evals.** In 3 of 16 nemotron B
   trials the model looped on "finished but its notification has not reached you yet":
   - 60 calls (about 517k uncached input tokens);
   - 64 calls (about 520k tokens) with no final report before the timeout;
   - 11 calls.

   The C0 baseline never looped. The gate also depended on things that can break: that the id
   returned for the queued item equals the context message id (not documented), that a compaction
   does not drop the notification before the first call, a `notification.json` file, and a scan of
   the whole session history on every call.
3. **The gate protected nothing that was hidden.** The finished-run status already pointed to
   `run.json` (field "result"). A's wording alone gave 0 transcript reads before a notification
   across 39 sessions. The worst case of opening outputs once the run has finished is a duplicate
   report, which C0 already produced, and which beats C0 nemotron guessing the output from the
   prompt.
4. **Most failures need no tool call.** In E1/E4, `<agent-failures>` alone was enough in most
   trials (0 calls). The Claude Code phrase "BEFORE diagnosing — do not assume agents returned
   non-empty results" gave exactly one follow-up lookup in E2 (5/5 with A, 3/3 with B).
5. **Polling and relaunching are model behavior.** Nemotron polled status while a run was going
   (3 of 18 sessions in A, 6–8 "Still running" calls in some B trials). It relaunched failed runs
   unasked in A (3 of 4 failed runs), in B (2/2) and in C0. It also sometimes sent `args` as a
   JSON string. None of this depends on the plugin change.
6. **Field filling.** space-bunny filled in every field of B's schema (`agentIndex`, `label`,
   `status`, `limit`, `maxChars`). That triggered B's conflict error 6 times across 4 trials. A
   model-filled `status:"completed"` would also hide the failed agents. And `offset` meant rows in
   one mode and characters in the other.

## Decision

A hybrid: B's surface, A's notification wording and failure lines, and no notification gate.

- **Notification.**
  - `<agent-failures>` (X20) comes after `<warnings>`/`<steering>`, whenever the run failed or an
    agent gave the script nothing. It is capped at 2,800 bytes of UTF-8 (lines that would overflow
    join "… and K more"), so it stays under 3 KB for 1000 agents.
  - `<diagnostics>` (P79) comes after `<transcript-dir>` in every run that started an agent. It
    carries Claude Code's wording, points at `workflow_control` `result`, and names no file.
  - A failed run's `<result>` says to retry "only if the user asks for it", and no longer repeats
    `Error:`.
- **Action** (X21): `workflow_control {action:"result", runId, agent?, offset?}`.
  - `agent` is a string: `"9"`/`"#9"` is an index, anything else an exact label, and `""` lists.
    A model that fills every field most likely sends `""`, which lists.
  - The list puts failed agents first. Each `offset` has one meaning per mode, and every footer
    gives the exact next value.
  - B's `agentIndex`/`label`/`status`/`limit`/`maxChars` are not read for `result`.
- **Timing.** A finished run answers at once, also before the notification, after a resume, or
  from disk after a reload. A running or paused run gets the P77 status note byte for byte, so
  polling `result` gives nothing new. `notification.json` and the session-context scan are gone.
- **P77 note.** The finished-run note no longer names `run.json` (that sentence sent C0 nemotron to
  read files) and does not name `result` either. From the 2nd status/`result` call on the same run
  since it last changed state, it adds "Repeating this call does not wait or speed anything up."
  That sentence is cheap and has not been evaluated yet; the re-evaluation decides whether it stays.
- **Descriptions.**
  - The `workflow` tool description has a separate PER-AGENT OUTPUTS paragraph.
  - The `workflow_control` description has one line for `result`.
  - The authoring reference prefers the action, still documents the on-disk layout (completion
    order, cached agents journaled again, the last line per index wins, `agents/<i>.json`), and
    says why the files are not the way in.

Not carried over from A: the opt-in sentence about `external_directory`, and resolving a relative
`dataDir` against the project.

## Known gaps (documented, not solved)

1. **`<result>` is not clipped.** E9 produced 114 KB, about 48–55k tokens. This predates both
   candidates. The follow-up is to clip it and page it through the action.
2. **Refused `agent()` calls leave no record.** A call refused by the budget, the 1000-agent cap or
   the schema preflight shows in neither block, and inside `pipeline`/`parallel` it becomes a
   silent `null`. Only the "No agent failed" wording acknowledges it. The follow-up is an
   engine-side refusal counter.
3. **Nemotron relaunches without being asked, and sometimes sends `args` as a JSON string.** This
   is model behavior (C0 does it too). The softer `<result>` text reduces the relaunches.
4. **Polling while a run is going** remains possible. It is addressed by wording only (P77 residual).
5. **A finished run can be read before its notification arrives**, so a model may report twice.
   This is accepted and noted in P77.
6. **The external_directory hang in `serve`** now happens only if a model reads the files anyway
   (docs/E2E.md, README headless section).
7. **Out of scope:** kept worktrees are not in the notification, and `<steering>` points to
   `/workflows` rather than to the action.

## Before merging: live re-evaluation

In `.sandbox`, with `opencode/space-bunny-free` and `opencode/nemotron-3-ultra-free`: E2, E5/E5b, E6
and E10 at 4 trials each, plus E1, E4 and E8D at 2 each. It passes if all of these hold:

- no trial makes more than 3 `workflow_control` calls per run before the notification;
- no transcript-dir reads;
- E2/E8 exact in every trial;
- E1/E4 still answered with 0 tools in most trials;
- no trial goes over 60k parent tokens, except E9.

The integration was checked live with the e2e `results.test.ts` (a result lookup, and a partial
failure where the parent must not poll and must name the failed agents); see docs/E2E.md. The full
re-evaluation above has not been run yet.
