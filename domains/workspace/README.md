# workspace

Projects, git, directories, and file search. Its contract is [`@lemma/workspace`](contract/src/workspace.ts), with the web app's side in `@lemma/workspace/web` and fff's indexes in `@lemma/workspace/fff`.

A project is a folder threads work in; in a git repository, its main work tree. A thread works in its project's own
checkout or in a worktree of it, on a branch of its own: a worktree is a place in a project, never a project of its own,
so its threads are filed, named, and counted under the repository's project (`Place`).

| Plugin                                         | Halves    | What it does                                                                                                                                                |
| ---------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`workspace.local`](local/README.md)           | host      | The filesystem and the `git` CLI: provides `Workspace`, and serves it and file search as channels                                                           |
| [`workspace.search-fff`](search-fff/README.md) | host      | Searches files with fff: an entry of `FileSearchers`; keeps fff's indexes, provides `FffIndexes`                                                            |
| [`workspace.commands`](commands/README.md)     | host      | Git commands: switch branch, create a branch                                                                                                                |
| [`workspace.tidy`](tidy/README.md)             | host, web | Removes a worktree Lemma made once its last thread is archived, and makes it again on unarchiving                                                           |
| [`workspace.client`](client/)                  | web       | Projects and the directory the composer works in: provides the web app's `Workspace`                                                                        |
| [`workspace.projects`](projects/)              | web       | Settings › Projects: every project beside the one chosen, its settings, its worktrees, and deleting it                                                      |
| [`workspace.add-project`](add-project/)        | web       | Pick a folder on the host by typing its path                                                                                                                |
| [`workspace.bar`](bar/)                        | web       | A new thread's project, where in it to work (local, a new worktree, a worktree), and branch, under its prompt; an open thread's, as rows of its thread card |
| [`workspace.file-mentions`](file-mentions/)    | web       | Mentions of the project's files in the prompt                                                                                                               |
| [`workspace.cli`](cli/README.md)               | host      | The `lemma` command's `workspace …`: adds them to `CliCommands`                                                                                             |

## Extending it

What the contract offers in each of the [five shapes](../../docs/plugins.md#the-five-shapes):

| Shape     | What the contract offers                                                                                                                                                                                                                                                      |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add       | `FileSearchers`: a file search; the first answers, and one that names no phase comes before the bundled `default`. In the web app, `ProjectActions` and `WorktreeActions`                                                                                                     |
| Intercept | Nothing                                                                                                                                                                                                                                                                       |
| Observe   | Nothing: clients ask again                                                                                                                                                                                                                                                    |
| Call      | `Workspace`: status, places, branches, worktrees (make, list, remove, restore), directories; `searchFiles`; `FffIndexes` (`@lemma/workspace/fff`): fff's index of a directory, opened once for every plugin searching it; clients call `WorkspaceChannels` and `FileChannels` |
| Serve     | `Workspace`, with `serveWorkspace` and `serveFiles`: a plugin providing it replaces `workspace.local`; `FffIndexes`: one providing it replaces `workspace.search-fff`                                                                                                         |
