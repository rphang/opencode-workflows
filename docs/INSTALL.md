# Installing opencode-workflows

This page covers every install method in detail. For the short version, see the
[README](../README.md#install).

Requirements: **opencode 2.0.15** (the version the plugin is pinned to). opencode installs npm
plugins itself, so you don't need Node, Bun or npm for the npm install. `git` is needed only for
`isolation: 'worktree'` agents.

> **Use one method only.** If the plugin is loaded twice (for example the npm package plus a loader
> file), the second copy fails with `Duplicate plugin ID: dynamic-workflows`.

## From npm (recommended)

### With the CLI

```sh
opencode plugin add @rphang/opencode-workflows
```

opencode installs the package and appends it to `plugins` in the global config. It prints:

```
Plugin "@rphang/opencode-workflows" installed and added to <path>
```

### By editing the config

Global config location:

| Platform | Path |
|---|---|
| macOS / Linux | `~/.config/opencode/opencode.json` |
| Windows | `%USERPROFILE%\.config\opencode\opencode.json` |
| `XDG_CONFIG_HOME` set | `$XDG_CONFIG_HOME/opencode/opencode.json` |
| `OPENCODE_CONFIG_DIR` set | That directory replaces the global config directory |

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@rphang/opencode-workflows"]
}
```

- The key is **`plugins`** (plural). The legacy `plugin` key loads nothing and gives no error.
- opencode downloads the package from your npm registry (as configured in your npm config) the next
  time it activates plugins. A running server picks up the config change without a restart (about
  20 s in testing, including the download). Otherwise run `opencode service restart` or restart the
  TUI.
- Packages are cached under `~/.cache/opencode/npm/` (`$XDG_CACHE_HOME/opencode/npm/` if set), as
  `@rphang/opencode-workflows@<spec>/<timestamp>/node_modules/...`.

### Why global?

opencode registers tools and permission hooks **per location** (directory). An
`isolation: 'worktree'` agent runs in another directory, and the plugin only works there if it is
loaded there as well. The global config covers every location. With a project-only install:

- a schema agent in a worktree has no `workflow_submit` tool, so the run falls back to extracting
  JSON from its reply;
- a worktree agent's approval requests are not turned into denials, so they can hang
  ([PARITY](PARITY.md) notes 5 and 8).

If you prefer a project-only install, put the same `plugins` entry in `<project>/opencode.json` and
**commit it**. Worktrees are checked out from git, so uncommitted config does not exist in them.

### Pinning a version

```sh
opencode plugin add @rphang/opencode-workflows@0.1.0
```

or `"plugins": ["@rphang/opencode-workflows@0.1.0"]`. A pinned spec is never flagged as outdated. To
upgrade, change the version.

### Plugin options

Use the object form of the entry:

```json
{
  "plugins": [
    { "package": "@rphang/opencode-workflows", "options": { "sizeGuideline": "small" } }
  ]
}
```

| Option | Effect |
|---|---|
| `disabled: true` | Registers no tools or commands. |
| `sizeGuideline` | `unrestricted`, `small`, `medium` or `large`. |
| `dataDir` | Where run transcripts are stored. |

Environment variables work with every install method. See the
[README](../README.md#configuration).

### Updating

An unpinned entry tracks the `latest` npm tag. opencode checks for a new version every 24 hours and
flags the plugin as outdated.

```sh
opencode plugin check                                   # show outdated plugins
opencode plugin update @rphang/opencode-workflows       # install the new version
```

If the new version does not load on its own, run `opencode service restart`.

### Uninstalling

```sh
opencode plugin remove @rphang/opencode-workflows
```

This removes the entry from the global config, and a running server unloads the plugin. You can also
delete the entry by hand. The downloaded copy stays in the cache
(`~/.cache/opencode/npm/@rphang/opencode-workflows@<spec>/`). Delete that whole folder, including
the timestamped subfolders in it, to free the space.

Run transcripts stay in the data directory (see `OPENCODE_WORKFLOW_DATA_DIR`). Saved workflows stay
in `.opencode/workflows/` and `~/.config/opencode/workflows/`.

### Checking that it loaded

- `opencode plugin list` should list `@rphang/opencode-workflows` (plugin id `dynamic-workflows`) as
  active.
- With `opencode serve`, `GET /api/plugin` shows
  `{"id":"dynamic-workflows","source":{"type":"package","target":"@rphang/opencode-workflows","version":"0.1.0"},"state":{"status":"active"}}`,
  and `GET /api/command` lists `workflows`, `workflow-authoring` and `deep-research`.

## From source

For contributors, or to run an unreleased commit. You need Node.js 22+ and npm. Bun comes in as a
devDependency.

```sh
git clone https://github.com/rphang/opencode-workflows
cd opencode-workflows
npm install
npm run build        # writes dist/
```

Then pick **one** of these:

### Loader file pointing at the build

Create `~/.config/opencode/plugins/workflows.js` (Windows:
`%USERPROFILE%\.config\opencode\plugins\workflows.js`) with one line:

```js
export { default } from "/absolute/path/to/opencode-workflows/dist/index.js"
```

On Windows, write the path with forward slashes, for example
`"C:/Users/me/dev/opencode-workflows/dist/index.js"`. Run `npm run build` again after each change.

### Loader file pointing at the sources (no build)

opencode's runtime is Bun, which loads TypeScript directly, so the loader can point at the sources
instead. Only `npm install` is needed:

```js
export { default } from "/absolute/path/to/opencode-workflows/src/index.ts"
```

The loader must be a **static** re-export. A loader that uses a top-level `await import()` never
activates. Loader files in a `plugins/` directory always get empty options, so only the environment
variables configure them.

A project loader file (`<project>/.opencode/plugins/workflows.js`) works too. Commit it, for the
worktree reason explained above.

### Directory entry in the config

```json
{
  "plugins": ["file:///absolute/path/to/opencode-workflows"]
}
```

A plain absolute directory path works too. Point at the **repo directory**: opencode resolves it
through the root `server.ts`, which re-exports `src/index.ts`. A file path such as
`.../src/index.ts` fails with `configured plugin path must be a directory`. This form accepts
options: `{ "package": "file:///absolute/path/to/opencode-workflows", "options": { ... } }`.
`server.ts` is not in the npm package, so this only works from a git checkout.

### The TUI part (live progress tree)

opencode finds a plugin's TUI entry next to its server entry (`Host.resolve` looks for `<package>/tui`
or `<directory>/tui`), and the TUI loads it for every active server plugin that has one
(`GET /api/plugin` shows `"features":{"server":true,"tui":true}`):

| Install | TUI entry | Live tree |
|---|---|---|
| npm package (`plugins` entry or `opencode plugin add`) | `exports["./tui"]` → `dist/tui.js`, precompiled | yes (verified live on 2.0.15) |
| Directory entry (`file:///…/opencode-workflows`) | the repo's `tui.tsx`, which the TUI compiles itself | yes |
| Loader file (`plugins/workflows.js`) | none: a single file only has a server entry | no; `/workflows` still works |

`dist/tui.js` imports `solid-js`, `@opentui/*` and `@opencode/plugin/tui` without bundling them: the
TUI provides its own copies at runtime, so the package has no new dependencies.
