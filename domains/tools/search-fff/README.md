# tools.search-fff

The `grep` and `find` tools, searching with
[fff](https://github.com/dmtrKovalenko/fff) through `@ff-labs/fff-node`. Adds
both to `Tools`. They search the indexes `workspace.search-fff` keeps
(`FffIndexes`, in `@lemma/workspace/fff`). Its web half (`./web`) shows a call
as its pattern and where it searched. Their descriptions, defaults, and output
follow fff's own pi extension
([pi-fff](https://github.com/dmtrKovalenko/fff/tree/main/packages/pi-fff),
0.11.0), which fff's author tunes against agents. No config:
`workspace.search-fff`'s `idleMinutes` sets how long an index stays open.

| Tool   | Input                                                                                                     | Behavior                                                                                                                             |
| ------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `grep` | `pattern`, `path?`, `exclude?`, `caseSensitive?`, `context?` (0–20), `limit?` (20, at most 50), `cursor?` | Matching lines grouped by file, each line cut at 500 characters. Nothing matching a plain pattern shows close fuzzy matches instead. |
| `find` | `pattern`, `path?`, `exclude?`, `limit?` (30, at most 200), `cursor?`                                     | Files whose whole path fuzzily matches; an empty pattern lists what `path` holds. A weak best match shows only 5.                    |

## Behavior

- **Where it searches.** `path` resolves against the session's directory
  (`resolveToCwd` in `@lemma/tools/files`). An existing folder or file matches
  exactly. A missing path or a glob reads as pi-fff reads it: `main.rs` is a
  file of that name anywhere, `lib` a folder of that name anywhere. `exclude`
  reads each entry that way.
- **Outside the session's directory**, an absolute, `~/`, or `../` path indexes
  its deepest existing directory, and results show absolute paths. fff refuses
  to index the home directory and `/`.
- **Matching.** Case is ignored unless the pattern has a capital letter. A
  pattern that compiles as a regex is one. One that matches everything (`.*`)
  is refused.
- **Ranking.** Recently changed files come first, and files git sees changed
  are tagged. A new index's first answers can lack git's order and tags: fff
  reads git on its own thread after the scan, and waiting for it would hold the
  host's thread.
- **Paging.** A cursor is a number, so a call with one replays after a restart.
- **Indexes** are one per directory, shared with the workspace's file search
  (`workspace.search-fff.indexes` lists them). The first call waits up to 15s
  for a new index's scan, then answers with what is indexed so far, and says
  so.
- **Failures.** fff loads on the first call, so a platform without its native
  library fails the calls while the plugin keeps running. With
  `workspace.search-fff` off, nothing provides the indexes, and this plugin
  does not start.

## Rationale

- **The workspace's indexes**, through a capability (`FffIndexes`): when each
  plugin kept its own, a project both searched kept two indexes. The workspace
  domain owns them, as it owns finding a project's files; the tools search
  with them as any plugin could. `FileSearchers` would not do: it returns
  paths, not contents. A session working in a subdirectory of a repository
  still has an index of its own, since the workspace's search indexes the
  repository.
- **Contents indexed** (fff's agent defaults: files mapped, contents
  indexed, which `workspace.search-fff` opens its indexes with). Measured with
  fff 0.11.0 on a warm disk cache (2026-10-11): on llvm-project (185k files),
  a grep for a rare word took 26ms indexed against 105ms without, at about
  950MB of memory against 500MB. On Lemma (900 files) and llama.cpp (3.8k),
  every grep took under 25ms either way.
- **A time budget.** fff's calls are synchronous, so a search runs on the
  host's thread, which serves every client: a grep stops after 2s and gives a
  cursor to continue.
- **Named `grep` and `find`.** pi-fff's `ffgrep` and `fffind` stand beside pi's
  own; Lemma has none.
- **It repeats and runs alongside others** (`replay: "safe"`,
  `parallel: "safe"`), as `read` does: it only reads.
- **A cursor built as fff builds one.** fff-node does not export
  `createGrepCursor`; a grep cursor is the offset of the next file, which the
  pinned version and the tests hold to.
