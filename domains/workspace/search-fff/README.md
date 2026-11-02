# workspace.search-fff

Searches files with [fff](https://github.com/dmtrKovalenko/fff), a fuzzy file
finder in Rust, through `@ff-labs/fff-node`. It contributes the bundled entry of
`FileSearchers` (`@lemma/workspace`), in its phase `default`. It opens and keeps
fff's indexes, and provides them as `FffIndexes` (`@lemma/workspace/fff`) to the
`grep` and `find` tools ([tools.search-fff](../../tools/search-fff/README.md)),
so a directory both search is indexed once.

Clients search through `files.search`, a channel `workspace.local` serves, and
host plugins through `searchFiles`. Both ask `FileSearchers` at each search,
so a plugin contributing its own searcher can replace this one. Turned off,
searches fail `Unavailable`, and `tools.search-fff`, which requires its
indexes, stops.

```jsonc
{ "plugins": { "workspace.search-fff": { "config": { "idleMinutes": 15 } } } }
```

| Config        | Default | Meaning                                                                                                                           |
| ------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `idleMinutes` | `15`    | 1 to 1440: how long an index stays in memory after the last search using it ends, a file search or a tool's; the next reopens it. |

## Behavior

- **Matching** is fff's: fuzzy and typo-tolerant (`compoesr` finds
  `Composer.tsx`), words narrow together (`web comp`), and globs work
  (`*.css`). `within` keeps to a folder. An empty query lists the most
  recently changed entries first.
- **What is indexed.** In a git work tree, its `.gitignore` files apply and
  hidden files are included. Elsewhere, hidden files and dependency folders are
  skipped. fff refuses the home directory and `/`.
- **Indexes** are one per directory, opened on the first search and kept
  current by fff's watcher until `idleMinutes` after the last. A change made
  while an index builds shows when it reopens, since fff starts the watcher
  only once the index is built. Indexes hold contents too, as `grep` needs: on
  llvm-project (185k files) one took about 950MB, against 500MB without
  ([tools.search-fff](../../tools/search-fff/README.md#rationale)).
- **A first file search** waits up to 2s for the scan, then answers with what
  is indexed so far and `indexing: true`.
- **Failures.** fff loads on the first search, so a platform without its
  native library fails searches `Unavailable` while the plugin keeps running.
- **Inspector.** `lemma inspectors workspace.search-fff.indexes` lists the open
  indexes.
