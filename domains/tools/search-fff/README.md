# tools.search-fff

The `grep` and `find` tools, searching with [fff](https://github.com/dmtrKovalenko/fff) through `@ff-labs/fff-node`. Adds both to `Tools`; its web half (`./web`) shows a call as its pattern and where it searched. Their descriptions, defaults, and output follow fff's own pi extension ([pi-fff](https://github.com/dmtrKovalenko/fff/tree/main/packages/pi-fff), 0.11.0), which fff's author tunes against agents.

```jsonc
{ "plugins": { "tools.search-fff": { "config": { "idleMinutes": 15 } } } }
```

| Config        | Default | Meaning                                                                                                   |
| ------------- | ------- | --------------------------------------------------------------------------------------------------------- |
| `idleMinutes` | `15`    | 1 to 1440: how long an index stays in memory after the last call using it ends; the next call reopens it. |

| Tool   | Input                                                                                                     | Behavior                                                                                                                             |
| ------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `grep` | `pattern`, `path?`, `exclude?`, `caseSensitive?`, `context?` (0–20), `limit?` (20, at most 50), `cursor?` | Matching lines grouped by file, each line cut at 500 characters. Nothing matching a plain pattern shows close fuzzy matches instead. |
| `find` | `pattern`, `path?`, `exclude?`, `limit?` (30, at most 200), `cursor?`                                     | Files whose whole path fuzzily matches; an empty pattern lists what `path` holds. A weak best match shows only 5.                    |

## Behavior

- **Where it searches.** `path` resolves against the session's directory
  (`resolveToCwd` in `@lemma/tools/files`). A folder or file that exists matches
  exactly; a top-level file also matches its namesakes below it, since fff
  matches no glob without a `/`. A path that does not exist, and a glob, read
  as pi-fff reads them: `main.rs` is a file of that name anywhere, `lib` a
  folder of that name anywhere. `exclude` reads each entry that way.
- **Outside the session's directory**, an absolute, `~/`, or `../` path
  indexes the deepest directory of it that exists, and results show absolute
  paths. The home directory and `/` are never indexed: fff refuses them.
- **Matching.** Case is ignored unless the pattern has a capital letter. A
  pattern with regex syntax that compiles is a regex; one that matches
  everything (`.*`) is refused. fff's agent mode reads path-like words in a
  pattern as filters too (`schema.rs parse` greps `parse` in `schema.rs`).
- **Ranking.** Files changed recently come first, and files git sees changed
  are tagged. No frecency database is opened, so what you open in an editor
  does not count.
- **Paging.** A cursor is a number, a grep's next file or a find's count
  shown, so a call with one replays after a restart.
- **Indexes** are one per directory searched, opened by the first call, which
  waits up to 15s for the scan and then answers with what is indexed so far,
  saying so. fff's watcher keeps them current until `idleMinutes` after the
  last call. `tools.search-fff.indexes` (`lemma inspectors tools.search-fff.indexes`)
  lists them.
- **Failures.** fff loads on the first call, so a platform without its native
  library fails the calls while the plugin keeps running.

## Rationale

- **Its own indexes**, not `workspace.search-fff`'s: a plugin meets another
  only through contracts, and `FileSearchers` returns paths, not contents. A
  project both search keeps two indexes.
- **Contents indexed** (fff's agent defaults: files mapped, contents
  indexed). Measured with fff 0.11.0 on a warm disk cache (2026-10-11): on
  llvm-project (185k files), a grep for a rare word took 26ms indexed against
  105ms without, at about 950MB of memory against 500MB. On Lemma (900 files)
  and llama.cpp (3.8k), every grep took under 25ms either way.
- **A time budget.** fff's calls are synchronous, so a search runs on the
  host's thread, which serves every client: a grep stops after 2s and gives a
  cursor to continue.
- **Named `grep` and `find`.** pi-fff's `ffgrep` and `fffind` stand beside pi's
  own; Lemma has none.
- **It repeats and runs alongside others** (`replay: "safe"`, `parallel: "safe"`),
  as `read` does: it only reads.
- **A cursor built as fff builds one.** fff-node does not export
  `createGrepCursor`; a grep cursor is the offset of the next file, which the
  pinned version and the tests hold to.
