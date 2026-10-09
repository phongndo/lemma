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
  disk does; a failed write may leave part of its bytes. `disk.injected` counts
  what fired.
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
