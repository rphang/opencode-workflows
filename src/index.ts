// opencode v2 plugin entry: Claude Code-style dynamic workflows.
//
// Registers the `workflow`, `workflow_control` and `workflow_submit` tools and the /workflows,
// /workflow-authoring and /<saved-workflow> commands. Disabled by OPENCODE_DISABLE_WORKFLOWS=1 or the
// plugin option `disabled: true` (P57).

import type { Plugin } from "@opencode/plugin"
import { PLUGIN_ID, setupPlugin, type PluginDeps } from "./plugin/setup.ts"

export type { PluginDeps } from "./plugin/setup.ts"

/** Builds the plugin object; `deps` are injection seams for tests and embedding hosts. */
export function createPlugin(deps: PluginDeps = {}): Plugin.Plugin {
  return {
    id: PLUGIN_ID,
    setup: (ctx) => setupPlugin(ctx, deps),
  }
}

const plugin: Plugin.Plugin = createPlugin()

export default plugin
