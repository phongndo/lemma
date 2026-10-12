# workspace.commands

The workspace's git commands, on the caller's `cwd`, added to `Commands`. Requires
`Interaction` and `Workspace`. No config.

| Command                | Title          | Does                                                                                                                                        |
| ---------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace.checkout`   | Switch branch… | Asks which branch, leaving out the current one and any checked out in another worktree; a remote one (`origin/x`) switches to the local `x` |
| `workspace.new-branch` | Create branch… | Asks a name, creates the branch from HEAD, and switches to it                                                                               |

`workspaceCommands` is exported for reuse and testing.
