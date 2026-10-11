# tools.bash

The `bash` tool: a shell command in the session's directory. Adds it to `Tools`.
Its web half (`./web`) shows a call as its command, as a shell line.

| Input                           | Behavior                                                                                                                                                                                                                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command`, `timeout?` (seconds) | `bash -c` in the session cwd, stdout+stderr combined, tail-truncated to 2000 lines or 50KB; the full output goes to a temp file named in the result. Without a `timeout`, the plugin's default applies. Non-zero exit, timeout, and abort are error results; `details.exitCode` carries the code. |

`makeBashTool(timeout)` makes one with another default timeout, for a plugin
that registers its own `bash`.

## Config

`timeout`: the seconds a command runs when the model names no timeout of its
own (default `600`; `0` for none). The tool description states it and tells
the model to run servers in the background, so a command that never exits
cannot hold a turn forever.

## Rationale

- **Replaceable alone.** A sandboxed `bash` is a plugin that registers a tool
  named `bash`, with this plugin turned off. Its web half goes with it, and
  with it how the chat shows bash calls (the terminal icon, the command as the
  summary): a replacement shows its calls with a `ToolViews` item of its own,
  or keeps this one by taking the id `tools.bash` and wrapping this plugin.
- **Process groups.** It spawns the shell as a group leader; abort and timeout
  kill the whole group. After the shell exits, output is read until the pipes go
  idle for 100ms, so a background child holding them cannot hang the call.
