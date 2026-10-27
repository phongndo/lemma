# workspace.search-fff

Searches files with [fff](https://github.com/dmtrKovalenko/fff), a fuzzy file finder in Rust, through `@ff-labs/fff-node`. It opens and keeps fff's indexes, and provides them to other plugins (`FffIndexes`, in `@lemma/workspace/fff`): the `grep` and `find` tools ([tools.search-fff](../../tools/search-fff/README.md)) search with them, so a directory both search is indexed once. It contributes the bundled entry of `FileSearchers` (`@lemma/workspace`), in its phase `default`, and requires nothing. Clients search through `files.search`, a channel `workspace.local` serves, and host plugins through `searchFiles`, both of which ask `FileSearchers` at each search, so this plugin can be turned off (searches then fail `Unavailable`, and `tools.search-fff`, which requires its indexes, stops) or replaced by a plugin contributing a searcher of its own.

```jsonc
{ "plugins": { "workspace.search-fff": { "config": { "idleMinutes": 15 } } } }
```

| Config        | Default | Meaning                                                                                                                           |
| ------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `idleMinutes` | `15`    | 1 to 1440: how long an index stays in memory after the last search using it ends, a file search or a tool's; the next reopens it. |

## Behavior

- **Matching** is fff's: fuzzy and typo-tolerant (`compoesr` finds
  `Composer.tsx`), words narrow together (`web comp`), and globs work
  (`*.css`). `within` keeps to a folder; an empty query lists the most recently
  changed entries first.
- **What is indexed.** In a git work tree, its `.gitignore` files apply and
  hidden files are included; elsewhere, hidden files and dependency folders are
  skipped. fff refuses the home directory and `/`.
- **Indexes** are one per directory, opened on the first search, a file search
  or a tool's, and kept current by fff's watcher until `idleMinutes` after the
  last. A file search uses its work tree's. They index contents and map files
  (fff's defaults for agents), as the `grep` tool needs, though a file search
  reads only paths: on llvm-project (185k files) one took about 950MB, against
  500MB without contents (2026-10-11, [tools.search-fff](../../tools/search-fff/README.md#rationale)).
  A first file search waits up to 2s for the scan, then answers with what is
  indexed so far and `indexing: true`.
- **Failures.** fff loads on the first search, so a platform without its
  native library fails searches `Unavailable` while the plugin keeps running.
- **Inspector.** `workspace.search-fff.indexes` (`lemma inspectors workspace.search-fff.indexes`)
  lists the open indexes.
