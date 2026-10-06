# @lemma/plugin-commands-builtin

The host's own commands, as three plugins so a composition missing one
capability still gets the others. Each requires `Commands` and `Interaction`,
plus the capability named below.

| Plugin               | Requires      | Commands                                                                                                                                                                                                                                                                                                                                                   |
| -------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commands-host`      | `HostControl` | `host.reload` (Reload config), `host.restart-plugin` (Restart plugin…: asks which failed plugin, or which running plugin the host does not depend on, and restarts it), `host.toggle-plugin` (Turn plugin on or off…: asks which unlocked plugin, writes its `enabled` row in the config file that decides it, and fails if the plugin is still as it was) |
| `commands-llm`       | `Llm`         | `llm.logout` (Log out of a provider…: asks which configured provider)                                                                                                                                                                                                                                                                                      |
| `commands-workspace` | `Workspace`   | `workspace.checkout` (Switch branch…: asks which), `workspace.new-branch` (Create branch…: asks a name)                                                                                                                                                                                                                                                    |

The git commands act on the caller's `cwd`. Switch branch leaves out the current
branch and any branch checked out in another worktree. Picking a remote branch
(`origin/x`) switches to the local `x`. The command lists (`hostCommands`,
`llmCommands`, `workspaceCommands`) are exported for reuse and testing. No config.
