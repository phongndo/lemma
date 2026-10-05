# @lemma/plugin-file-search-fff

Searches files (plugin id `file-search`) with [fff](https://github.com/dmtrKovalenko/fff), a fuzzy file finder in Rust, through `@ff-labs/fff-node`. It contributes the bundled entry of `FileSearchers` (`@lemma/contracts`) at order 100 and requires nothing. Clients search through the transport's `Files.Search`, and host plugins through `searchFiles`, both of which ask `FileSearchers`, so this plugin can be turned off (searches then fail `Unavailable`, and nothing else stops) or replaced by a plugin contributing below order 100.

```jsonc
{ "plugins": { "file-search": { "config": { "idleMinutes": 15 } } } }
```

| Config        | Default | Meaning                                                                                                |
| ------------- | ------- | ------------------------------------------------------------------------------------------------------ |
| `idleMinutes` | `15`    | 1 to 1440: how long an index stays in memory after the last search using it ends; the next reopens it. |

## Behavior

- **Matching** is fff's: fuzzy and typo-tolerant (`compoesr` finds `Composer.tsx`), words narrow together (`web comp`), and globs work (`*.css`). A lone `src/` is a fuzzy word, not a folder: to keep to a folder, pass `within` (`within: "src"`), which only returns entries inside it, still relative to the directory searched. An empty query lists the most recently changed entries first. Files and directories rank together unless `kind` asks for one; the directory searched (or the `within` folder) is never an entry. Entries use `/` separators and no trailing slash.
- **What is indexed.** In a git work tree, its `.gitignore` files apply, including the root's to a search in a subdirectory, and hidden files are included; elsewhere, hidden files and dependency folders (`node_modules`, `target`, …) are skipped. fff refuses the home directory and `/`: a search there fails `Unavailable`.
- **Indexes.** One per work tree (the nearest directory above the one searched holding `.git`, never the home directory or `/`), or per directory outside one, with symlinks resolved; searches in its subdirectories share it. It opens on the first search and closes `idleMinutes` after the last search using it ends, or when the plugin stops; it never closes under a running search. Searches that arrive while it opens share it. fff's watcher keeps it current, so a file created after the first search is found by the next. A first search waits up to 2s for the scan, then answers with what is indexed so far and `indexing: true`.
- **Limits.** At most `FILE_SEARCH_LIMIT` (200) entries, default 50; `truncated` says more matched. fff answers on the host's thread (a few milliseconds per page), which is why pages stay small.
- **Failures.** A path that is not an absolute directory, or a `within` that is not a folder in it (or leaves it, with `..`), is `NotFound`. fff is loaded on the first search, so a platform without its native library (prebuilt for macOS, Linux glibc and musl, and Windows, on x64 and arm64) fails searches with `Unavailable` and the loader's message, while the plugin keeps running.
- **Inspector.** `file-search.indexes` (in `Inspectors`; `lemma inspectors file-search.indexes`) lists the open indexes: their directory, files read, whether a scan is running, searches using it, and seconds since the last one ended.

`makeFileSearch` takes the engine as `open`, so another engine with the shape of fff's `FileFinder` (`Finder`) can stand in; the tests use that for the index lifecycle.
