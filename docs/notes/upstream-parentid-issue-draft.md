# Upstream note: `parentID` on the plugin `session.create` (retired draft)

The draft that used to live here asked upstream to forward `parentID` from the plugin API's
`session.create`. It landed in opencode 2.3.0 (`anomalyco/opencode#52359`), so the draft is obsolete.

The plugin still does not use it, for two reasons verified in the 2.3.0 source
(`packages/core/src/session.ts`, `packages/core/src/session/execution/subagent-report.ts`):

1. `parentID` and `location` are mutually exclusive: a child is forced into its parent's location,
   so `isolation: 'worktree'` agents (P28) cannot have a parent.
2. Every child with a `parentID` posts a `<subagent>` report holding its last reply into the parent's
   inbox (delivery `steer`) after every completed round, including failed and interrupted ones, and
   wakes the parent (`#63209`; the per-child opt-out was removed in `#63413`). For a workflow that
   would inject every agent's raw output into the parent's context (against
   `docs/design/agent-output-access.md`), duplicate the P06 task notification, and wake an idle
   parent once per agent turn.

What we would gain (native subagent tree, parent↔child navigation, child permission prompts shown
in the parent, so P63's ask→deny rewrite could go) is real, so a possible upstream request is a
per-child "silent" flag (no report, no wake) that keeps `location` settable. Not posted anywhere.
