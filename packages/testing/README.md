# @lemma/testing

Test support shared by Lemma's packages. Private; tests import it as a dev
dependency.

## `SimDisk`

A disk in memory for crash tests, after SQLite's crash VFS and FoundationDB's
simulator. `disk.mount()` returns a `FileSystem` (`@lemma/contracts/fs`), the
seam storage code takes instead of `node:fs` (the sessions plugin through
`makeSessionsPlugin({ fs })`).

- **Durability.** Data is durable once `datasync` (or `sync`) returns on its
  file; a name (created, renamed, removed) once its directory is synced. A new
  directory's own name needs its parent synced, as POSIX says; a journaling file
  system often hides a missing sync, a power loss on another does not.
- **Crashes.** `disk.crash()` is a power loss: each file keeps its durable bytes
  and, of what was appended since, all, none, or a prefix that may end mid-line
  and be followed by zeros; unsynced names may be undone. `disk.crashAfter(n)`
  crashes after `n` more operations, so a crash lands part-way through one.
  Every earlier mount and handle then fails, as the process that held it is gone.
- **Faults.** `disk.faults` gives each kind of operation (`write`, `sync`,
  `truncate`, `rename`, `open`) a probability of failing as a full or failing
  disk does; a failed write may leave part of its bytes. A failed sync drops
  what it had to write, as Linux does: the bytes stay readable, but no later
  sync writes them (it leaves zeros there) until they are written again.
  `disk.injected` counts what fired. `disk.faultAfter(n)` fails the operation
  after the next `n` instead, and with `{ persistent: true }` every one after
  it, so a test can fail each of an operation's steps in turn, until one
  completes before its fault is due; `clearFaults()` heals the disk.
- **Other programs.** `disk.outside` appends to, rewrites, truncates, replaces,
  or removes a file, durably at once.

A seeded random source (`seededRandom(seed)`) decides crashes and faults, so a
seed replays a run. Only what `FileSystem` covers is modelled: one process,
regular files and directories, POSIX paths.

## Conformance suites

`sessionsConformance(name, compose)` registers the `Sessions` contract as Vitest
tests, against whatever plugins `compose` returns: the sessions plugin runs it
on a simulated and a real disk, and a plugin written to replace it can run the
same suite. `compose` is given `Deletions`, which the provider's storage waits
on before it deletes a session's data, so the suite can hold a deletion up, or
fail it, as a slow or failing disk would.

`llmConformance(name, compose)` does the same for the `Llm` contract. `compose`
is asked for a provider in one of three cases, each answering a request as the
suite expects (its doc comment says how): a reply with text and a tool call, a
failure with a partial response, and a stream that stays open to be
interrupted. The suite checks the catalog, the stream's shape (`streamProblems`:
one start, one terminal last, deltas that make up the final text, no tool call
id twice), `LlmRequestHook`, and that closing the stream aborts the request.
`toolsConformance(name, compose)` checks a `ToolRunner`, with tools of its own:
attribution, input validation, errors as results, unknown tools, every chunk
of a tool's output reaching the caller before its result, and cancellation
while the caller's listener never returns. The bundled `llm.pi-ai` and
`tools.registry` run these, as does a replacement for each written from the
contracts alone, in `tests/providers.test.ts`.

## Failure evidence

`failureArtifact(kind, details, files, copies)`, from `@lemma/testing/artifacts`,
saves what a failed run leaves before its temporary files go: in a new
directory under `LEMMA_TEST_ARTIFACTS` (the OS temp directory by default),
`failure.json` with the commit and `details` (the seed, and the command that
replays it), each of `files`, and a copy of each path in `copies`.
`diskFiles(disk)` gives a `SimDisk`'s files for it. A token in a URL is
redacted; a caller copies durable state, never credentials.
