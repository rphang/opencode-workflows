# AGENTS.md

Contributor and coding-agent guide for `@rphang/opencode-workflows`, an opencode v2 plugin that
reproduces Claude Code's dynamic workflows (`workflow` tool running a JS orchestration script:
`agent()`, `parallel()`, `pipeline()`, `phase()`, `log()`, `budget`, `workflow()`, resume from
journal). Parity target: `docs/PARITY.md`. The upstream behavior it mirrors is documented at
https://code.claude.com/docs/en/workflows and in the `Workflow` section of
https://code.claude.com/docs/en/agent-sdk/typescript (link to those pages; do not copy them into
the repo).

## Rules

- **TDD.** Write or extend the failing test first, then the code, then run the tests. Never
  finish a change with red tests.
- Run tests with `npx bun test <path>` (Bun is a devDependency; no global bun is needed).
  `npm test` runs the unit and parity suites. `npx tsc --noEmit` must stay clean.
- Do not add dependencies without discussing it first. Dependencies: `@opencode/codemode`,
  `@opencode/plugin` (use **`import type` only** from it — the runtime does not need it),
  `acorn`, `ajv`, `effect`, all pinned to opencode 2.0.15 (`effect` must stay the exact version
  `@opencode/codemode` depends on, so both share one copy).
- The engine (`src/engine.ts` and friends) is host-agnostic. Everything opencode-specific lives in
  `src/opencode/`. Engine tests use the fake runner in `tests/helpers/`.
- Every PARITY ID needs a test in `tests/parity/` whose name starts with the ID.
- Plain TypeScript, ESM. Bun loads `.ts` directly in development; `npm run build` produces the
  published `dist/` bundle.
- Keep the repo free of personal data: no absolute local paths, usernames, emails, API keys or
  session transcripts with real paths. Use placeholders such as `<project>` and `<data-dir>`.

## Script sandbox

Scripts run in `@opencode/codemode` (restricted JS interpreter: async functions, closures,
destructuring, Promise, Map/Set/JSON/Math/Date/RegExp; NO classes, `this`, getters, `globalThis`,
`Object.freeze`, imports). Host functions are exposed as globals via `Extension.make`; they can
receive and return plain data only — never functions — so `parallel`/`pipeline`/`budget` are
written in a JS prelude inside the interpreter. Verified: host-global async calls run
concurrently, host errors surface as catchable exceptions, `const Date = ...` shadowing works and
`new Date()` on a user function throws.

## Live opencode (e2e)

Never run live tests against your real opencode data or config. Use an isolated sandbox inside the
repo (`.sandbox/` is git-ignored):

```sh
export XDG_DATA_HOME=$PWD/.sandbox/data XDG_CONFIG_HOME=$PWD/.sandbox/config \
       XDG_STATE_HOME=$PWD/.sandbox/state XDG_CACHE_HOME=$PWD/.sandbox/cache
npx opencode2 run --standalone --auto --format json -m openai/gpt-5.4-mini "..."
```

The automated suite does this for you: `OPENCODE_E2E=1 npx bun test tests/e2e --timeout 600000`
with `OPENAI_API_KEY` set (see `docs/E2E.md`). Child sessions default to a free `opencode/*`
model. Plugin logs: `.sandbox/data/opencode/log/opencode.log`. Plugin `console` output is not
visible; write debug logs to a file with an absolute path.

Verified live on 2.0.15: `ctx.tool.transform(e => e.add({id, name, description, input: <JSON
Schema>, options:{codemode:false}, execute(input, tctx)}))`; `tctx = {sessionID, agent,
messageID, id, progress, signal}`; `ctx.session.create({title, metadata, agent?, model?,
permissions?, location?, id?})` returns the Session.Info (`.id`); `prompt({sessionID, text})`;
`wait({sessionID})` resolves when idle; `get({sessionID})` → `{model, tokens:{input,output,
reasoning,cache:{read,write}}, cost, outcome:"succeeded"|...}`; `context({sessionID})` → array of
messages; assistant messages are `{type:"assistant", content:[{type:"text", text}|{type:"reasoning"}|...]}`;
`ctx.storage.get/set` work. More API notes: `docs/OPENCODE-API-NOTES.md`.

## Docs map

- `docs/PARITY.md` — behavior spec, one ID per behavior, each with a parity test.
- `docs/E2E.md` — live test harness, known gotchas, the demo script.
- `docs/OPENCODE-API-NOTES.md` — observed opencode 2.0.15 plugin API behavior.
- `docs/notes/` — maintainer notes and drafts (not published anywhere).
- `docs/assets/` — images used by the README.
