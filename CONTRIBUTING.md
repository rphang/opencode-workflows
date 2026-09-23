# Contributing

Thanks for helping. This plugin reproduces Claude Code's dynamic workflows on opencode v2, and its
behavior is pinned down item by item in [`docs/PARITY.md`](docs/PARITY.md). Most contributions
either close a parity gap, fix a bug, or keep up with a new opencode release.

Agent-facing rules (also useful for humans) are in [`AGENTS.md`](AGENTS.md).

## Development setup

Requirements: Node.js 22 or newer, npm, and git. Bun does not need to be installed globally: Bun
1.4.2 is a devDependency and runs through `npx bun`.

```sh
git clone https://github.com/rphang/opencode-workflows.git
cd opencode-workflows
npm ci
npx tsc --noEmit                        # type-check (must stay clean)
npm test                                # unit + parity suites (npx bun test tests/unit tests/parity)
npm run build                           # bundle into dist/ (what npm ships)
```

To try your checkout in opencode without publishing, point a loader file at the sources, for
example `.opencode/plugins/workflows.js` in a scratch project:

```js
export { default } from "/absolute/path/to/opencode-workflows/src/index.ts"
```

While experimenting, use an isolated opencode data and config dir (see "Live opencode" in
`AGENTS.md`) so your real sessions are not touched.

## Code layout

- `src/engine.ts` and its siblings are **host-agnostic**: no opencode imports. Engine tests use the
  fake runner in `tests/helpers/`.
- Everything opencode-specific lives in `src/opencode/` and `src/plugin/`.
- Import from `@opencode/plugin` with **`import type` only**; the runtime does not need it.
- Plain TypeScript, ESM. opencode's Bun runtime loads `.ts` directly; `npm run build` produces the
  published `dist/` bundle.
- Workflow scripts (for example `workflows/deep-research.js`) run in opencode's codemode
  interpreter: no classes, `this`, getters, `globalThis` or imports.

## Test-driven development

This project uses TDD. For every change:

1. Write or extend a test that fails for the right reason.
2. Make the change.
3. Run `npx tsc --noEmit` and `npm test`. Never open a PR with red tests.

## Test suites

| Suite | Command | Cost | When |
|-------|---------|------|------|
| Unit | `npx bun test tests/unit` | free, seconds | always |
| Parity | `npx bun test tests/parity` | free, seconds | always |
| e2e harness (offline) | `npx bun test tests/e2e/harness.test.ts` | free | always |
| Live e2e | `OPENCODE_E2E=1 npx bun test tests/e2e --timeout 600000` | about $0.20 and 2 minutes per full run | opt-in |

The live e2e suite drives the real opencode 2.0.15 CLI with real model calls. It needs
`OPENAI_API_KEY`. Without `OPENCODE_E2E=1`, the live tests are skipped. The harness isolates every
opencode process under `.sandbox/` (its own `XDG_*` dirs), so your real opencode data is never
used. Details, costs and flakiness notes are in [`docs/E2E.md`](docs/E2E.md).

In CI, pull requests run the free suites on Linux, Windows and macOS (`.github/workflows/ci.yml`).
The live suite runs only on manual dispatch and weekly (`.github/workflows/e2e.yml`).

## Parity rule

Every row of `docs/PARITY.md` has an ID (`P01`, `P02`, ...), and **every ID must have at least one
test in `tests/parity/` whose name starts with that ID**, for example
`test("P03 a syntax error returns async_launched with error", ...)`. A test may list several IDs up
front (`"P41 P44 ..."`). `tests/parity/coverage.test.ts` enforces this in both directions.

When you change behavior covered by a row, update the row (behavior, FULL/DEGRADED/N/A status,
target and test columns) in the same PR. A new behavior gets a new ID and a test. User-facing
DEGRADED and N/A items are also summarized in the README's Limitations section.

## Testing against a new opencode version

The plugin is pinned to one opencode release: `@opencode/plugin`, `@opencode/codemode` and
`@opencode/cli` are all 2.0.15, and so is `engines.opencode`. Dependabot deliberately ignores
`@opencode/*` and `effect` (which must stay the exact version `@opencode/codemode` depends on), because
the plugin API is young and each bump must be verified by hand:

1. On a branch, bump all `@opencode/*` packages and `engines.opencode` to the same new version, set
   `effect` to the version the new `@opencode/codemode` depends on, then run `npm install` and check
   that `npm ls effect` shows a single deduped copy.
2. Read opencode's changelog for plugin API, session, permission, worktree and codemode changes.
   Compare it with the verified API notes in `AGENTS.md` and `docs/OPENCODE-API-NOTES.md`.
3. Run `npx tsc --noEmit` and `npm test`. Type errors usually point at API changes.
4. Run the full live suite: `OPENCODE_E2E=1 npx bun test tests/e2e --timeout 600000`. It covers
   plugin loading, background delivery, resume, worktrees, stop and the commands.
5. Re-check the DEGRADED and N/A rows in `docs/PARITY.md`: a new opencode API may allow a FULL
   implementation (for example, child sessions linked to their parent).
6. Update the version references in `README.md`, `AGENTS.md`, `docs/E2E.md` and `CHANGELOG.md`.

## Pull requests

- Keep PRs focused. Describe the behavior change and how you tested it.
- Add an entry under `## [Unreleased]` in `CHANGELOG.md` for anything user-visible.
- Fill in the PR template checklist (tests, parity row, e2e).

## Release process (maintainers)

1. Make sure `main` is green in CI. Run the live e2e suite if anything opencode-facing changed.
2. Bump `version` in `package.json` with `npm version <x.y.z> --no-git-tag-version` (this also
   updates `package-lock.json`).
3. In `CHANGELOG.md`, rename `## [Unreleased]` to `## [x.y.z] - YYYY-MM-DD`, add a new empty
   `## [Unreleased]` above it, and update the compare links at the bottom.
4. Commit (`chore: release vx.y.z`), then tag and push: `git tag vx.y.z && git push origin main vx.y.z`.
5. The `Release` workflow checks that the tag matches `package.json`, runs the type-check, tests and
   build, publishes to npm with provenance (`npm publish --provenance --access public`, using the
   `NPM_TOKEN` repository secret), and creates the GitHub Release with the notes from that
   version's `CHANGELOG.md` section. Tags with a hyphen (for example `v0.2.0-rc.1`) are marked as
   prereleases.

### Smoke-testing the package before publishing

`opencode plugin add` only accepts npm registry or git specifiers: a `.tgz` path or `file://` URL
fails with "Plugin target must be an npm registry package or Git package specifier". To test the
exact tarball the way users install it, publish it to a throwaway local registry, inside an isolated
opencode sandbox (see "Live opencode" in `AGENTS.md`):

1. `npm run build && npm pack` produces `rphang-opencode-workflows-<version>.tgz`.
2. Start [verdaccio](https://verdaccio.org) on `127.0.0.1:<port>` with its storage under `.sandbox/`
   and an uplink to npmjs for the dependencies.
3. `npm publish <tgz> --registry http://127.0.0.1:<port>` (use a throwaway `--userconfig` so your
   real npm login is not touched).
4. With the sandbox `XDG_*` variables and `NPM_CONFIG_REGISTRY=http://127.0.0.1:<port>` set, run the
   README steps literally: `opencode plugin add @rphang/opencode-workflows`, `opencode plugin list`,
   the Quick start prompt, then `opencode plugin remove`. If your real opencode service holds port
   49374, move the sandbox service first with `opencode service set port <port>`.
5. Stop the sandbox service and verdaccio afterwards.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
