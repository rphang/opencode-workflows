# DRAFT (not posted): expose `parentID` on the plugin API's `session.create`

Target: `anomalyco/opencode`, branch `v2`. Verified against `v2` @ `9c8a63e8` (2026-09-23, core/plugin
`2.0.15`). This file has not been posted anywhere.

## Read before posting: this request already exists upstream

Checked read-only with `gh` on 2026-09-23:

- **PR #47745 "feat(plugin): support parent session creation"** (open, by dbpolito, created
  2026-09-07, 0 reviews, 0 comments) implements this across protocol, server handler, plugin host,
  generated clients and docs. It was written against an older `v2`. Its `host.ts` hunk has no
  `metadata`/`permissions` lines, and its protocol hunk still has `success: Session.Info` and the
  `"v2.session.create"` identifier, while current `v2` has `PublicSessionInfo` and
  `"session.create"`. So it needs a rebase. It also adds no test, and it silently drops `location`
  when both `parentID` and `location` are passed.
- **Issue #49389 "Five session capabilities that exist in core but are unreachable from a
  plugin"**, item 3, asks for exactly this, with the same `host.ts` / `session.ts` references.
- Adjacent requests: #40863 (hidden/ephemeral plugin sessions, which relies on `parentID`), #39911
  (visibility separate from parentage), #34957 (the public vs internal `PluginRuntime` gap; the
  internal subagent tool can set `parentID`), and #47229 (other missing session APIs; not about
  `parentID`).
- #49568 is a PR (session message reads), not an issue, and is unrelated to `parentID`.

**Recommendation:** don't open a new issue. Post the "Use case", "Security" and "Test" sections
below as a comment on #49389 (item 3) or as a review comment on PR #47745: ask for a rebase, a
same-project check on the parent, a defined rule for `parentID` + `location`, and a test. The full
issue text follows in case the maintainers want a separate, focused issue.

---

## Title

`[FEATURE] v2 plugin API: forward parentID on ctx.session.create so plugins can create child sessions`

## Problem

Core already supports child sessions. The plugin projection of `session.create` can't reach that
path, so every session a plugin creates is a root session.

- Core input type, `packages/core/src/session.ts:82-92`:
  ```ts
  type CreateInput = CreateBaseInput &
    ({ location: Location.Ref; parentID?: never } | { parentID: SessionSchema.ID; location?: never })
  ```
- Core implementation, `packages/core/src/session.ts:254-258,268-275`: it looks up the parent
  (`NotFoundError` if missing), inherits `parent.location`, records `parentID`, and copies the
  parent's `metadata` and `permissions` when the caller gives none.
- Plugin host, `packages/core/src/plugin/host.ts:520-530`: the call lists its fields one by one and
  always supplies `location`, so the `parentID` branch can never be reached:
  ```ts
  create: (input) =>
    sessions.create({
      id: input?.id, title: input?.title, agent: input?.agent, model: input?.model,
      metadata: input?.metadata, permissions: input?.permissions,
      location: input?.location ?? Location.Ref.make({ directory: location.directory, workspaceID: location.workspaceID }),
    }),
  ```
- The public type has no field for it either. `SessionDomain` in
  `packages/plugin/src/{promise,effect}/session.ts:153` is a `Pick` of the generated client's
  `SessionApi`. Its `SessionCreateInput` (`packages/client/src/effect/api/api.ts:190-198`) is
  generated from the `session.create` payload in `packages/protocol/src/groups/session.ts:220-231`,
  and that payload has no `parentID`. The HTTP handler (`packages/server/src/handlers/session.ts:125-137`)
  also always passes `location`.

Built-in code sets `parentID`: the subagent tool (`packages/core/src/tool/plugin/subagent.ts:187-193`)
and subagent commands (`packages/core/src/config/plugin/command.ts:101-106`). They do this through
internal services that external plugins can't use.

### What `parentID` controls today, and what plugin sessions miss

| Behaviour keyed on `parentID` | Where |
|---|---|
| Child sessions are hidden from the TUI session list and home list; they are shown as a tree under their root | `packages/tui/src/component/dialog-session-list.tsx:99,146,184`, `packages/tui/src/util/session.ts:16-28`, `packages/app/src/home/sessions/index.ts:51` |
| The root session's view shows **permission requests and forms from every descendant** | `packages/tui/src/routes/session/index.tsx:185-202` (`data.session.family`), `packages/app/src/session/requests/session-request-tree.ts` |
| Child sessions get "back to parent" navigation and the subagents composer tab | `packages/tui/src/routes/session/index.tsx:1189-1201,1357-1368` |
| Children don't fire "done" or "response ready" desktop notifications; they use the `subagent_done` sound instead | `packages/tui/src/feature-plugins/system/notifications.ts:12,41`, `packages/app/src/shell/notifications/notification.tsx:229,256` |
| Metadata and permission rules are copied from the parent at creation | `packages/core/src/session.ts:272-275` |
| Deleting the parent deletes its children | `packages/core/src/session.ts:360-361` |
| Children skip automatic title generation | `packages/core/src/session/runner/llm.ts:173` |
| The provider request carries `x-parent-session-id` and uses the parent for cache affinity | `packages/core/src/session/model-request.ts:237,244` |
| Restart recovery for subagent children | `packages/core/src/session/execution/restart.ts:143` |

## Concrete use case

[opencode-workflows](https://github.com/rphang/opencode-workflows) is a v2 plugin that brings Claude
Code's dynamic workflows to opencode. A `workflow` tool runs a JS orchestration script in the
background, and the script's `agent()` calls fan out to many subagents: one per file, then a
skeptic per finding, and so on. Each subagent is an opencode session created with
`ctx.session.create` and driven with `prompt`/`wait`/`context`.

Because those sessions can't be children of the session that launched the workflow:

1. **The UI gets cluttered.** In a live demo (6 agents, parent model `openai/gpt-5.4-mini`), the
   home/recent-sessions list showed the user's session plus six `[wf:<runId>] …` sessions as peer
   root sessions. A 50-agent run adds 50 root sessions. The plugin's only mitigation is a title
   prefix plus `metadata.workflowRunId`.
2. **Permission prompts never reach the user.** The root view only collects requests from its own
   `parentID` family, so an `ask` inside a workflow agent would wait forever. The plugin
   has to deny the `question` tool in every child. It also installs a `permission.hook("evaluate")`
   that turns every `ask` in a tagged session into `deny`. That is less capable than the built-in
   subagent tool, which surfaces child prompts in the parent.
3. **Notifications are wrong.** Each finished agent fires a top-level "Session done" or "response
   ready" notification instead of the quiet `subagent_done`.
4. **No cleanup or ownership.** Deleting the user's session leaves the workflow sessions behind.
   Plugins also can't call `session.remove` (#49389 item 2).
5. **Permission inheritance has to be rebuilt by hand.** The plugin copies the parent's rules into
   `permissions` itself, which core already does for children.

## Proposed change (minimal)

Add optional `parentID` to the public create payload and forward it. When `parentID` is set, core
keeps its current rule: the child inherits the parent's location. Suggested rule when both fields
are passed: accept `location` only if it resolves to the same project as the parent. This keeps
per-agent git worktrees possible, because a worktree is the same project at another directory.
Otherwise reject the call; don't silently drop `location` as #47745 does.

Diff sketch against `v2` @ `9c8a63e8`:

```diff
--- a/packages/protocol/src/groups/session.ts   (~L220)
       HttpApiEndpoint.post("session.create", "/api/session", {
         payload: Schema.Struct({
           id: Session.ID.pipe(Schema.optional),
+          parentID: Session.ID.pipe(Schema.optional),
           title: Schema.String.pipe(Schema.optional),
           ...
         }),
         success: Schema.Struct({ data: PublicSessionInfo }),
+        error: SessionNotFoundError,
       }).annotateMerge(OpenApi.annotations({
         identifier: "session.create",
-        description: "Create a session at the requested location.",
+        description: "Create a session at the requested location. With parentID, create a linked child session at its parent's location.",
```

```diff
--- a/packages/core/src/plugin/host.ts   (L520-530)
-      create: (input) =>
-        sessions.create({
-          id: input?.id, title: input?.title, agent: input?.agent, model: input?.model,
-          metadata: input?.metadata, permissions: input?.permissions,
-          location:
-            input?.location ?? Location.Ref.make({ directory: location.directory, workspaceID: location.workspaceID }),
-        }),
+      create: Effect.fn(function* (input) {
+        const base = { id: input?.id, title: input?.title, agent: input?.agent, model: input?.model,
+                       metadata: input?.metadata, permissions: input?.permissions }
+        if (input?.parentID === undefined)
+          return yield* sessions.create({ ...base,
+            location: input?.location ?? Location.Ref.make({ directory: location.directory, workspaceID: location.workspaceID }) })
+        const parent = yield* sessions.get(input.parentID)             // NotFoundError if missing
+        if (parent.projectID !== location.project.id)                  // plugin may only nest in its own project
+          return yield* new Session.NotFoundError({ sessionID: input.parentID })
+        return yield* sessions.create({ ...base, parentID: parent.id })
+      }),
```

```diff
--- a/packages/server/src/handlers/session.ts   (L125-137)
               .create({
                 id: ctx.payload.id,
                 ...
-                location: ctx.payload.location ?? { directory: AbsolutePath.make(process.cwd()) },
+                ...(ctx.payload.parentID === undefined
+                  ? { location: ctx.payload.location ?? { directory: AbsolutePath.make(process.cwd()) } }
+                  : { parentID: ctx.payload.parentID }),
               })
-              .pipe(Effect.orDie),
+              .pipe(Effect.catchTag("Session.NotFoundError", missingSession)),
```

Then run `bun run generate` in `packages/client`, which regenerates
`src/effect/api/api.ts`, `src/effect/generated/client.ts` and
`src/promise/generated/{client,types}.ts`. `check:generated` enforces it. The plugin types pick up
the new field through `SessionDomain = Pick<SessionApi, "create" | …>` with no edits.

Optional follow-up for the `parentID` + `location` rule: relax core's `CreateInput` union in
`packages/core/src/session.ts:91`. Then change `const location = parent?.location ?? input.location`
(L256) to prefer `input.location` when `projects.resolve(input.location.directory).id === parent.projectID`,
and fail otherwise.

## Backwards compatibility

- The field is optional and additive. Callers that omit `parentID` go through the same code path
  as today, and the HTTP payload, generated clients and plugin types gain one optional key.
- HTTP `session.create` gains a declared 404 (`SessionNotFoundError`) for a missing parent. Today
  a core `NotFoundError` there becomes a defect through `Effect.orDie`, but it can't happen because
  `parentID` is never passed.
- Existing sessions are unaffected. `parentID` is already stored and projected
  (`packages/core/src/session/info.ts:21`) and already exists on `Session.Info` and in list filters.

## Security considerations

A child session isn't just a label. Setting `parentID` has these effects:

- the child's permission requests and forms appear in the **parent's** view, where the user may
  approve them thinking they came from their own agent;
- the child copies the parent's `permissions` and `metadata` when the caller passes none;
- the child is deleted along with the parent, and it runs in the **parent's** location, which may
  be another project;
- provider requests carry `x-parent-session-id` and share the parent's cache affinity.

The host doesn't scope `sessions.get`/`store.get` by location. So without a check, a plugin loaded
for project A could nest a session under a session ID from project B. That child would run in B's
directory, show prompts in B's session view, and copy B's session rules. Proposed safeguards:

1. **Same-project check in the plugin host.** Reject `parentID` unless
   `parent.projectID === location.project.id` (see the diff). Return `NotFoundError`, not a
   distinct "forbidden" error, so other projects' session IDs can't be probed. The HTTP route
   already runs with server-level trust, so a check there is optional. It could be the same check
   against the request's resolved location.
2. If `location` is also passed, apply the same-project rule to it (worktrees of the same project
   are fine).
3. Inheriting permissions doesn't escalate anything. A plugin can already pass any `permissions`
   ruleset to `create`, so copying the parent's rules gives it nothing new.
4. Optional, for later: record that a plugin created the child (for example a `createdBy: plugin
   id` field or metadata key), so the parent's UI can label the permission prompts it collects.

## Test idea

Add to `packages/core/test/plugin.test.ts`, following the existing "promise-input" test at
L455-471, which already calls `ctx.session.create` from a promise plugin:

1. The plugin creates `parent = await ctx.session.create({ title: "root" })`, then
   `child = await ctx.session.create({ parentID: parent.id, title: "child" })`.
   Expect `child.parentID === parent.id` and `child.location` to equal `parent.location`. Expect
   `child.permissions` and `child.metadata` to be inherited when omitted, the same assertions as
   `packages/core/test/session-create.test.ts:376-443`.
2. A missing `parentID` rejects with `Session.NotFoundError`, as `session-create.test.ts:452` does.
3. **Cross-project:** create a session in a second temp project through `Session.Service`
   directly. Then call the plugin's `create({ parentID: thatID })` from a plugin bound to the
   first project. It should reject with `NotFoundError`, and no session should be created.
4. Cascade: removing the parent through `Session.Service.remove` also removes the child created
   by the plugin.
5. HTTP: `POST /api/session` with `{ parentID }` returns the child with `parentID` set, and an
   unknown parent returns 404.
