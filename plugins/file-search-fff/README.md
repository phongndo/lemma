# @lemma/plugin-file-search-fff

Searches files (plugin id `file-search`) with [fff](https://github.com/dmtrKovalenko/fff), a fuzzy file finder in Rust, through `@ff-labs/fff-node`. It contributes the bundled entry of `FileSearchers` (`@lemma/contracts`) at order 100 and requires nothing. Clients search through `files.search`, a channel the workspace plugin serves, and host plugins through `searchFiles`, both of which ask `FileSearchers` at each search, so this plugin can be turned off (searches then fail `Unavailable`, and nothing else stops) or replaced by a plugin contributing below order 100.

```jsonc
{ "plugins": { "file-search": { "config": { "idleMinutes": 15 } } } }
```

| Config        | Default | Meaning                                                                                                |
| ------------- | ------- | ------------------------------------------------------------------------------------------------------ |
| `idleMinutes` | `15`    | 1 to 1440: how long an index stays in memory after the last search using it ends; the next reopens it. |

## Behavior

- **Matching** is fff's: fuzzy and typo-tolerant (`compoesr` finds
  `Composer.tsx`), words narrow together (`web comp`), and globs work
  (`*.css`). `within` keeps to a folder; an empty query lists the most recently
  changed entries first.
- **What is indexed.** In a git work tree, its `.gitignore` files apply and
  hidden files are included; elsewhere, hidden files and dependency folders are
  skipped. fff refuses the home directory and `/`.
- **Indexes** are one per work tree, opened on the first search and kept
  current by fff's watcher until `idleMinutes` after the last search. A first
  search waits up to 2s for the scan, then answers with what is indexed so far
  and `indexing: true`.
- **Failures.** fff loads on the first search, so a platform without its
  native library fails searches `Unavailable` while the plugin keeps running.
- **Inspector.** `file-search.indexes` (`lemma inspectors file-search.indexes`)
  lists the open indexes.
