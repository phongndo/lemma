# @lemma/plugin-sessions

Provides `Sessions` (`@lemma/contracts`): each session is an append-only tree of
`SessionEvent`s stored as one JSONL file. Requires `Paths`. Serves the
`sessions.*` channels (`SessionChannels`, through `serveSessions`): the calls
clients make on sessions; `sessions.log`, one session's log as it grows; and
`sessions.changes`, every session created, changed, or removed.

```ts
Effect.gen(function* () {
  const store = yield* Sessions;
  const { id } = yield* store.create({ cwd });
  const event = yield* store.append(id, { type: "title", title: "Fix the build" });
  const branch = yield* store.branch(id); // root → leaf
  yield* store.checkout(id, event.id); // later appends branch from here
});
```

```jsonc
{ "plugins": { "sessions": { "config": { "unloadAfter": 300 } } } }
```

| Config        | Default | Meaning                                                                                                                                    |
| ------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `unloadAfter` | `300`   | Seconds a session may go unused before its events leave memory and its file is closed; the next use reloads it. `0` keeps sessions loaded. |

## Storage

`<Paths.home>/sessions/<encoded cwd>/<createdAt ISO>_<id>.jsonl`, the directory
`~/.lemma/sessions` unless `$LEMMA_HOME` moves the home. The cwd is encoded
pi-style (`/home/me/app` → `--home-me-app--`); the header's `cwd` is authoritative.

| Line     | Shape                                                                       |
| -------- | --------------------------------------------------------------------------- |
| 1        | `{ "type": "session", "version": 1, id, cwd, createdAt }`                   |
| event    | a `SessionEvent` (`seq`, `id`, `parent`, `at`, `data`); no top-level `type` |
| checkout | `{ "type": "checkout", "leaf": eventId, "at" }`                             |
| marks    | `{ "type": "marks", "pinned"?, "archived"?, "at" }`                         |

`seq` counts events only (checkout lines do not advance it). The leaf is the last
event appended or the last checkout, whichever is later. The title is the latest
`title` event; `pinned` and `archived` are the latest value each marks line gave
(a marks line moves neither the leaf nor `updatedAt`: filing a session is not activity in it). Session ids are 12 url-safe random characters; event ids 8.

`<Paths.home>/sessions/.index.json` is the listing index: for each file, its size,
mtime, and inode when last read or written, the `SessionInfo` it described up
to those bytes, and a hash of its last line. It is a cache, so deleting it only
costs re-reading the files.

## Behavior

- **Durability.** `append` and `checkout` write through a per-session file handle
  and `fdatasync` before returning. `create` also fsyncs the file's directory and
  that directory's parent, since a new directory's name survives a power loss only
  once its parent is synced; a failed directory sync fails the `create` and
  removes the file (one the platform cannot do at all is skipped). Appends to one session are serialized by
  a semaphore. The cost is one sync per event, and the agent appends only settled
  events (never stream deltas).
- **Crash tolerance.** A write a crash cut short is a torn write: bytes after the
  last newline, or a last line that is not JSON (a power loss can keep a line's
  newline but not its bytes). It is ignored when reading, with a `Notice` when
  the session is opened, and cut off before the next append. A write that fails at
  runtime (full disk, failed sync) fails the append and truncates the file back to
  the last confirmed line, at once or, failing that, before the next write, when
  the session is unloaded, or when the plugin closes; every confirmed line was
  synced when it was written, so retrying never relies on a failed sync. Any other
  complete line that does not decode, an unknown parent, a seq gap, or a checkout
  to nowhere makes the session `Corrupt`. Skipping such a line would silently
  change what the model saw.
- **Validation.** `append` decodes the event's JSON against the schema first, so
  a line that could not be read back is never written, and memory holds the event
  exactly as a reload will. A field the schema lacks is refused (it would be
  dropped on reading), and so is a value JSON cannot carry where the schema needs
  it (`NaN` becomes `null`). `parent` must exist (`InvalidParent`).
- **Listing.** `list` reads directory entries and `stat`s each file. A file whose
  size, mtime, and inode match the listing index is not read; one that grew is read
  (with `JSON.parse` only) from where the last read stopped, since sessions are
  only appended to, once the line read last is found unchanged (a failed write's
  line may since have been replaced; if it was, the whole file is read). Sessions
  are indexed when created, read, unloaded, and when the plugin stops, those last
  two from memory, so a restarted host reads only what changed since. Sessions
  this process has opened are served from memory. A file that cannot be read is
  left out with a `Notice` warning instead of failing the listing.
- **Memory.** A session opened for `events`, `branch`, `append`, `checkout`, or
  `mark` stays in memory, with its file open, until no operation but `list` has
  used it for `unloadAfter` seconds. A sweep (every `unloadAfter / 2`, at least
  once a minute) then closes the file and drops the events, skipping a session
  in the middle of an operation; `list` keeps its info without re-reading the
  file, and the next use reloads it. A loaded session takes about 1.1× its file
  size in heap, and reloading a 40 MB one about 70 ms: without unloading, a
  long-running host's heap and open files grow with every session it touches.
- **One process per directory.** The store holds `<Paths.home>/sessions/.lock`
  (`{ pid, hostname, token, startedAt }`) while it runs, and touches it every 10
  seconds, so a second host on the same directory fails to activate this plugin
  instead of interleaving appends with the first (and resuming its turns
  twice). The error names the holder and the file: stop that host, or delete
  the file if it is not running. A lock is taken over when its holder, on this
  machine, is no longer running, or was started before the machine last booted
  (its pid may be another process's now, and a host restarted at boot must not
  refuse to start) and has not touched the lock for 30 seconds (a clock set
  after the holder started makes it look older than the boot, but it still
  touches the lock). A lock from another hostname (another machine sharing the
  directory, or this one under an old name: a Mac's follows its network) cannot
  be checked, so it holds until it goes 30 seconds untouched. One that names
  nobody is taken over once it is ten seconds old (a crash while it was
  written). Only the process that creates `.lock.takeover` takes a stale lock
  over, so two starting at once cannot both have it. A store that finds the lock
  held by another process (it took the lock over, say after this host was
  frozen) fails, stopping the plugins that write through it. The plugin is
  `exclusive`: a reload closes the old instance, which removes the lock, before
  the new one takes it, so two never write one log.
- **Other programs.** The lock keeps out other Lemma processes, not other
  programs. Before each write the file must still be linked and its size what
  this process left, and a file is opened for writing only while it is the size
  it was read at: a program that writes to, deletes, or replaces it makes the
  write fail (`Io`) instead of interleaving with it or going to a deleted file,
  and the session is read again on its next use. A deleted session is not
  recreated.
- **Reading.** Files are read a chunk at a time, so no string holds a whole file
  and a session larger than the longest string Node allows still opens (each line
  must still fit in one). Opening validates every line; listing uses `JSON.parse`
  alone.
- **Removal.** Holds (`hold`) are counted per session, in memory: the store
  starts with none, as the plugins that held sessions through it restart with
  it. `remove` checks that the session has none and marks it as being removed
  in one step, then runs through `SessionRemoveHook`; a handler that refuses
  keeps the session. Otherwise it deletes the file and closes it, then
  fsyncs its directory so a power loss does not bring the session back (best
  effort: on a failing disk it may come back, whole); the session is gone from
  memory and listings, and `SessionRemoved` is published.
- `SessionAppended` and `SessionChanged` are published after each write. They are
  losable; the file is the source of truth, from which `sessions.log` reads
  what its client missed.

## Testing

`tests/simulation.test.ts` runs random operations on a simulated disk
(`SimDisk` from `@lemma/testing`; the plugin takes it through
`makeSessionsPlugin({ fs })`) that crashes, including part-way through an
append, keeps or tears what was not synced, fails writes, syncs, truncations,
and opens at rates drawn per run, and is written to by other programs. It
checks that every acknowledged event survives as returned, that a crash leaves
at most one failed append, that no session nothing else wrote to is ever
`Corrupt`, and that `list` agrees, then that every session takes an append once
the disk is healthy. Time comes from Effect's `Clock`, and ids from
`IdBytes` (secure random bytes unless a test seeds them), so one seed fixes a
run. `LEMMA_SIM_RUNS` (default 100),
`LEMMA_SIM_SEED`, and `LEMMA_SIM_PATH` (printed by a failure) control it; a
failing seed becomes a regression test. It also counts the situations runs reach
(torn tails, failed appends kept and dropped, removals undone by a crash) and
fails if one is never reached, so the generator cannot quietly stop covering
them.
