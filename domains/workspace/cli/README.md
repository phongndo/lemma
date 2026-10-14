# workspace.cli

The project directory's commands for the `lemma` command (`CliCommands` in [`@lemma/cli`](../../cli/README.md)): `workspace status|branches|checkout|worktree|mkdir|browse|files`, the controls the web app's workspace bar and add-project dialog offer. Requires nothing: it reaches the workspace through its channels. No config.

A path is the client's directory, or one it names, resolved there; `~` is left
for the host to expand. With a host on another machine, name the host's path.
