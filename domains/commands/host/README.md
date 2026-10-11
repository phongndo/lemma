# commands.host

The host's own commands. Adds them to `Commands`. Requires `Interaction` and `HostControl`.
No config.

| Command               | Title                  | Does                                                                                                                                |
| --------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `host.reload`         | Reload config          | Re-reads the config files and applies them                                                                                          |
| `host.restart-plugin` | Restart plugin…        | Asks which failed plugin, or which running plugin the host does not depend on, and restarts it                                      |
| `host.toggle-plugin`  | Turn plugin on or off… | Asks which unlocked plugin, writes its `enabled` row in the config file that decides it, and fails if the plugin is still as it was |

`hostCommands` is exported for reuse and testing.
