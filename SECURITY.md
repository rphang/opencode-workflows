# Security policy

## Supported versions

Only the latest release of `@rphang/opencode-workflows` receives security fixes. The plugin
supports one opencode version at a time (currently 2.0.15).

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report them privately through GitHub's private vulnerability reporting:
<https://github.com/rphang/opencode-workflows/security/advisories/new>
(the repository's **Security** tab, then **Report a vulnerability**).

Include the plugin and opencode versions, your OS, a minimal workflow script or prompt that
reproduces the issue, and what an attacker gains. You should get an acknowledgement within 7 days.
Once a fix is released, the advisory is published and credits you, unless you prefer otherwise.

## Threat model (summary)

The full description is in the **Security model** section of the [README](README.md#security-model).
In short:

- Workflow scripts are written by the model and run in opencode's codemode interpreter, with no
  filesystem, network, shell, Node API or `import`. They can only call the workflow globals
  (`agent`, `parallel`, `pipeline`, ...).
- Launching is opt-in and can be gated with an opencode permission rule on the `workflow` tool.
  There is no approval dialog.
- Subagents get the parent session's permissions and never more: rules are copied into each child,
  "ask" becomes "deny" (nobody could answer), and children cannot launch nested workflows.
- `scriptPath` only reads files that the session may read under opencode's rules, and saving a
  workflow never writes through symlinks.
- Runs are private to the session that launched them.

In scope: escaping the script sandbox, a subagent gaining permissions its parent session does not
have, reading or writing files outside the documented locations, and one session reading or
controlling another session's runs.

Out of scope: what a subagent does with permissions you granted it, prompt injection that stays
within those permissions, the cost of runs you launched, and vulnerabilities in opencode itself
(report those to the opencode project).
