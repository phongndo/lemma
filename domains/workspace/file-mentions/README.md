# workspace.file-mentions

Completes mentions of the project's files in the prompt. Typing `@` at the start
of a word offers the files and folders of the thread's directory, and picking
one writes its path after the `@` (`@src/app.ts`). It adds the source
`file-mentions` (`Files`) to `ComposerCompletions`
([`@lemma/threads`](../../threads/contract/src/threads.ts)) at order 100. The
source searches `Workspace.workingDir` (`@lemma/workspace/web`) through
`files.search` (`FileChannels` in
[`@lemma/workspace`](../contract/src/files.ts)).

| Config    | Default | What it does                                                                                      |
| --------- | ------- | ------------------------------------------------------------------------------------------------- |
| `trigger` | `"@"`   | What starts a word to complete, at least one character; a pick writes the path after it           |
| `limit`   | `50`    | At most this many suggestions, 1 to 200 (`FILE_SEARCH_LIMIT`)                                     |
| `folders` | `true`  | Offers folders among the files, and picking one goes on completing inside it; `false`: files only |

## Behavior

- **A mention is text**: the path relative to the thread's directory. Nothing
  of the file is attached. The file tools drop a leading `@` (`resolveToCwd`
  in `@lemma/tools/files`).
- **Matching** is the host's file searcher's (`FileSearchers`, by default
  `workspace.search-fff`), so a plugin that replaces it changes what mentions
  find.
- **Inside a folder.** `src/ap` searches the folder `src` for `ap` (`within`)
  when there is one, and otherwise matches all of `src/ap`.
- **Quoting.** A path with whitespace or `"` is quoted (`@"my notes/a b.md"`),
  with `"` and `\` escaped. A folder ends in `/` and is left open (`@src/`,
  `@"my notes/`), so completing goes on inside it.
- **Asking the host.** It searches once typing pauses for 80 ms. A search that
  fails, as when no plugin searches files, shows why.
