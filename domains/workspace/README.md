# workspace

Projects, git, directories, and file search. Its contract is [`@lemma/workspace`](contract/src/workspace.ts), with the web app's side in `@lemma/workspace/web`.

| Plugin                                         | Halves | What it does                                                                                      |
| ---------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------- |
| [`workspace.local`](local/README.md)           | host   | The filesystem and the `git` CLI: provides `Workspace`, and serves it and file search as channels |
| [`workspace.search-fff`](search-fff/README.md) | host   | Searches files with fff: an entry of `FileSearchers`                                              |
| [`workspace.commands`](commands/README.md)     | host   | Git commands: switch branch, create a branch                                                      |
| [`workspace.client`](client/)                  | web    | Projects and the directory the composer works in: provides the web app's `Workspace`              |
| [`workspace.projects`](projects/)              | web    | A project's threads, archived ones included                                                       |
| [`workspace.add-project`](add-project/)        | web    | Pick a folder on the host by typing its path                                                      |
| [`workspace.bar`](bar/)                        | web    | The strip under the composer                                                                      |
| [`workspace.file-mentions`](file-mentions/)    | web    | Mentions of the project's files in the prompt                                                     |

## Extending it

| Shape     | What the contract offers                                                                                                  |
| --------- | ------------------------------------------------------------------------------------------------------------------------- |
| Add       | `FileSearchers`: a file search, the lowest order first. In the web app, `ProjectActions` and `WorkspaceBarItems`          |
| Intercept | Nothing                                                                                                                   |
| Observe   | Nothing: clients ask again                                                                                                |
| Call      | `Workspace`: status, branches, worktrees, directories; `searchFiles`; clients call `WorkspaceChannels` and `FileChannels` |
| Serve     | `Workspace`, with `serveWorkspace` and `serveFiles`: a plugin providing it replaces `workspace.local`                     |
