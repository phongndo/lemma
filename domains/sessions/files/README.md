# sessions.files

Provides `Sessions` (`@lemma/sessions`): each session is an append-only tree of
`SessionEvent`s stored as one JSONL file. Serves the `sessions.*` channels
(`SessionChannels`, through `serveSessions`):

- the calls clients make on sessions, such as `sessions.relocate`, which moves
  an empty one's file into its new directory's folder;
- `sessions.search`, what was said in them;
- `sessions.log`, one session's log as it grows;
- `sessions.changes`, every session created, changed, or removed;
- `sessions.records`, `sessions.request`, and `sessions.cache`, a session's
  branch as its Trajectory view reads it: its records, one request by part and
  plugin, and how it kept the prompt cache.

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
{ "plugins": { "sessions.files": { "config": { "unloadAfter": 300 } } } }
```

| Config        | Default | Meaning                                                                                                                                              |
| ------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unloadAfter` | `300`   | Seconds a session may go unused before its events leave memory and its file is closed; the next use reloads it. `0` keeps sessions loaded.           |
| `emptyAfter`  | `86400` | Seconds a session nothing has gone into may stay, since it was made, before it is deleted (a new thread a client made and left). `0` keeps them all. |

## Storage

`<Paths.home>/sessions/<encoded cwd>/<createdAt ISO>_<id>.jsonl`, the directory
`~/.lemma/sessions` unless `$LEMMA_HOME` moves the home. The cwd is encoded
pi-style (`/home/me/app` → `--home-me-app--`); the header's `cwd` is
authoritative.

| Line     | Shape                                                                       |
| -------- | --------------------------------------------------------------------------- |
| 1        | `{ "type": "session", "version": 1, id, cwd, createdAt, parent? }`          |
| event    | a `SessionEvent` (`seq`, `id`, `parent`, `at`, `data`); no top-level `type` |
| checkout | `{ "type": "checkout", "leaf": eventId, "at" }`                             |
| marks    | `{ "type": "marks", "pinned"?, "archived"?, "kept"?, "cwd"?, "at" }`        |

- `seq` counts events only: checkout lines do not advance it.
- The leaf is the last event appended or the last checkout, whichever is later.
- The title is the latest `title` event.
- `pinned`, `archived`, and `kept` are the latest value each marks line gave.
- A marks line's `cwd` (written by `relocate`) moves the session to that
  directory, over the header's.
- A marks line moves neither the leaf nor `updatedAt`, as filing a session is
  not activity in it.
- The header's `parent`, on an agent's session, is the session that started it
  (`SessionInfo.parent`), fixed when it is made.
- Session ids are 12 url-safe random characters, and event ids 8.

### Format versions

The header's `version` is the file's format (`FORMAT_VERSION`, 1). A file of
another version is refused as `Corrupt` with a message naming both versions,
never taken for damage. The rules for changing the format, so no change makes a
user's session unreadable:

- Adding a member to `EventData` (`@lemma/sessions`), or an optional field to a
  line (the header's `parent`), is not a new version, as old files hold none of
  it. Nor is making a member's field optional, which old files hold everywhere.
- Removing a member, narrowing one, or changing a line's shape is a new version.
  The store reads every earlier version through migrations, one per version
  (`vN` to `vN+1`), applied as a file is read.
- An older reader ignores a line's field it does not know. It reads a session
  written since as damaged where an event it cannot decode starts (a new member,
  or a field left out): read-only up to there, its file unchanged.
- A migration accepts at least everything the reader of its version accepted:
  it may not refuse a field that reader ignored.
- `tests/fixtures/v<N>/` holds session files version `N` wrote, and how every
  reader projected them (`projections.json`: per leaf, the model history's
  digest; per `request` event, the rebuilt request's). `tests/formats.test.ts`
  reads each one back the same.
- `pnpm sim --fixtures <dir>` writes a new version's corpus once. A version's
  corpus is never regenerated, so a change that reads an old session
  differently fails the test.

A `request` event's `contributions` are logged only when they differ from the
previous request's on its branch; older files have them on every request. A
request without them has the previous request's (`requestState`), which a
reader always has:

- it is an ancestor, and an event's parent is in the file before it;
- a torn tail, damage, and a failed write each lose only the file's end;
- `fork` copies the whole branch to its event.

A sibling branch holds no ancestor, so a request never takes another branch's.
A compaction removes nothing from the log, so a request after it finds the one
before it.

`<Paths.home>/sessions/.index.json` is the listing index. For each file, it
holds its size, mtime, and inode when last read or written, the `SessionInfo` it
described up to those bytes, and a hash of its last line. It is a cache, so
deleting it only costs re-reading the files.

## Behavior

- **Durability.** `append` and `checkout` write through a per-session file
  handle and `fdatasync` before returning. `create` also fsyncs the file's
  directory and that directory's parent, since a new directory's name survives a
  power loss only once its parent is synced. A failed directory sync fails the
  `create` and removes the file; one the platform cannot do at all is skipped. A
  semaphore serializes appends to one session. The cost is one sync per event,
  and the agent appends only settled events, never stream deltas. The first time
  a process opens a session costs one more write and sync (below).
- **Crash tolerance.** A write a crash cut short is a torn write: bytes after
  the last newline, or a last line that is not JSON (a power loss can keep a
  line's newline but not its bytes). Reading ignores it, with a `Notice` when
  the session is opened, and the next append cuts it off.
- **Failed writes.** A write that fails at runtime (full disk, failed sync)
  fails the append. The file is truncated back to the last confirmed line at
  once, or failing that before the next write, when the session is unloaded, or
  when the plugin closes. Every confirmed line was synced when written, so
  retrying never relies on a failed sync.
- **A line a failed cut left.** On a failing disk, a line can outlive a failed
  cut. It stays readable from the page cache but is not durable, and no later
  sync writes it, since Linux marks the pages of a failed writeback clean. Only
  the last line can be one, as each write is one line and cuts a failed one
  first. So the first time a process opens a session, it writes that line again
  and syncs it and the file's directory before serving any event. That costs
  about 2.4 ms a session on a btrfs SSD; macOS, whose sync flushes the drive's
  cache, is not measured. A session whose line cannot be made durable is not
  served (`Io`, "Cannot make … durable"). One whose file cannot be opened to
  write (read-only) is served as it is. `list` and `get` skip this, so a summary
  (its `lastSeq`, leaf, title) can describe a line a power loss then takes back.
- **Damage.** Any other complete line that does not decode, an unknown parent, a
  seq gap, a duplicate id, or a checkout to nowhere damages the log from there.
  Reading on past it would silently change what the model saw, and refusing the
  whole session would lose what came before. So the session is what came before
  the damage, listed with `damaged` (the line, and why). It takes no writes
  (`ReadOnly`), as an append past the damage would bury it, and the file is
  never cut to drop it. A `Notice` says so once, and the empty-session sweep
  never deletes a damaged session.
- **Going on after damage.** `fork` copies a branch, from any event that reads,
  into a new session that takes writes; the web app's composer offers it. A
  file whose header does not read is `Corrupt`, as nothing of it is known to be
  a session. The listing sees a seq gap at once, and other damage once the
  session is opened, which `SessionChanged` then announces.
- **Validation.** `append` decodes the event's JSON against the schema first, so
  a line that could not be read back is never written, and memory holds the
  event exactly as a reload will. A field the schema lacks is refused, as
  reading would drop it. So is a value JSON cannot carry where the schema needs
  it (`NaN` becomes `null`). `parent` must exist (`InvalidParent`).
- **Listing.** `list` reads directory entries and `stat`s each file. A file
  whose size, mtime, and inode match the listing index is not read. One that
  grew is read from where the last read stopped, since sessions are only
  appended to, once the line read last is found unchanged; otherwise, as a
  failed write's line may have been replaced, the whole file is read.
- **Reading heads.** The listing reads each event line from its head, the first
  bytes the store writes (`seq`, `id`, `parent`, `at`, the data's `type`), and
  checks only that `seq` runs on without a gap. It parses titles, checkout and
  marks records, a line another writer laid out otherwise, and the file's last
  line, which a power loss can leave torn. Reading a head costs a few times less
  than parsing a short line, and a long one (a tool's output) no more. A host
  whose index is gone lists 500 sessions (3.7 GB) in 0.7 to 1.1 s.
- **The index** is written when a session is created, read, or unloaded, and
  when the plugin stops, those last two from memory, so a restarted host reads
  only what changed since. Sessions this process has opened are served from
  memory. A file that cannot be read is left out with a `Notice` warning, rather
  than failing the listing.
- **Memory.** A session opened for `events`, `branch`, `append`, `checkout`, or
  `mark` stays in memory, its file open, until nothing but `list` has used it
  for `unloadAfter` seconds. A sweep, every `unloadAfter / 2` and at least once
  a minute, then closes the file and drops the events, skipping a session in the
  middle of an operation. `list` keeps its info without re-reading the file, and
  the next use reloads it. A loaded session takes about 1.1× its file size in
  heap; requests whose contributions repeat the last one's share one array.
  Reloading 10,000 events (20 MB) takes about 40 to 45 ms, and 100,000 (207 MB)
  about 0.42 s. Without unloading, a long-running host's heap and open files
  grow with every session it touches.
- **Moving an empty session** (`relocate`) writes its new directory to its file
  first, then renames the file into that directory's folder. A `list` or `get`
  meanwhile finds it where it is. A rename that fails leaves the file where it
  was, still read as moved. A failed sync of its new name is warned of, and the
  next load makes it good.
- **Search** (`search`) reads the sessions with something in them, the most
  recently updated first, eight at a time, until enough have matched. A session
  in memory is read there. Any other is read from its file and let go, not
  counted as a use, so searching neither loads sessions nor keeps them. From a
  file it reads the branch from line heads, as the listing does. It parses only
  the prompts and replies whose line holds every word sought; a word with a
  character JSON escapes, or a sigma, has every one parsed. A search that
  matches nothing in 500 sessions (3.7 GB) takes about 1.4 s. It stops where
  opening stops, but for a line that is JSON yet no event, which only opening
  checks. A session known to be damaged is read as opening reads it.
- **Empty sessions** nothing has gone into for `emptyAfter` seconds since they
  were made are deleted, as the store starts and every hour after. They are new
  threads a client made and left, as when its tab closed. A session kept
  (`SessionMarks.kept`: a client holds something for one), pinned, archived, or
  in use stays.
- **One process per directory.** The store holds `<Paths.home>/sessions/.lock`
  (`{ pid, hostname, token, startedAt }`) while it runs, and touches it every 10
  seconds. So a second host on the same directory fails to activate this plugin,
  instead of interleaving appends with the first and resuming its turns twice.
  The error names the holder and the file: stop that host, or delete the file if
  it is not running.
- **Stale locks.** A lock is taken over when its holder, on this machine, is no
  longer running. It is also taken over when its holder started before the
  machine last booted and has not touched it for 30 seconds: its pid may be
  another process's now, and a host restarted at boot must not refuse to start.
  A clock set after the holder started makes it look older than the boot, but it
  still touches the lock. A lock from another hostname cannot be checked, so it
  holds until it goes 30 seconds untouched: another machine sharing the
  directory, or this one under an old name (a Mac's follows its network). A lock
  that names nobody is taken over once it is ten seconds old, as a crash came
  while it was written. Only the process that creates `.lock.takeover` takes a
  stale lock over, so two starting at once cannot both have it.
- **Losing the lock.** A store that finds the lock held by another process (one
  that took it over after this host was frozen, say) fails, stopping the plugins
  that write through it. The plugin is `exclusive`: a reload closes the old
  instance, which removes the lock, before the new one takes it, so two never
  write one log.
- **Other programs.** The lock keeps out other Lemma processes, not other
  programs. Before each write, the file must still be linked and its size what
  this process left. A file is opened for writing only while it is the size it
  was read at. So a program that writes to, deletes, or replaces a file makes
  the write fail (`Io`), rather than interleave with it or go to a deleted file.
  The session is read again on its next use. A deleted session is not recreated.
- **Reading.** Files are read a chunk at a time, so a session larger than the
  longest string Node allows still opens; each line must still fit in one.
  Opening validates every line. Listing and search read lines from their heads.
- **Removal.** Holds (`hold`) are counted per session, in memory. The store
  starts with none, as the plugins that held sessions through it restart with
  it. `remove` holds the session's lock, checks that nothing holds the session,
  and marks it as being deleted, in one step. It then deletes and closes the
  file, and fsyncs its directory so a power loss does not bring the session
  back. That is best effort: on a failing disk the session may come back,
  whole. Only then does the mark go, and the session, gone from memory and
  listings, is announced with `SessionRemoved`. A hold that waited on the mark
  so waits on the disk alone, never on an observer of that event.
- **Events.** `SessionAppended` and `SessionChanged` are published after each
  write. They are losable: the file is the source of truth, from which
  `sessions.log` reads what its client missed.

## Testing

`tests/simulation.test.ts` runs random operations on a simulated disk
(`SimDisk` from `@lemma/testing`). The plugin takes it through
`makeSessionsPlugin({ fs, ids, claimant })`, beside the source of its ids'
random bytes and the process the lock names. The disk crashes, including
part-way through an append, and keeps or tears what was not synced. It fails
writes, syncs, truncations, and opens at rates drawn per run, and other programs
write to it. The test checks that:

- every acknowledged event survives as returned;
- a crash leaves at most one failed append;
- no session nothing else wrote to is ever `Corrupt`, and `list` agrees;
- every session takes an append once the disk is healthy.

Time comes from Effect's `Clock`, and ids from the `IdSource` (`secureIds`, from
`@lemma/contracts`, unless a test seeds one), so one seed fixes a run.
`LEMMA_SIM_RUNS` (default 100), `LEMMA_SIM_SEED`, and `LEMMA_SIM_PATH` (printed
by a failure) control it. A failing seed becomes a regression test. The test
also counts the situations runs reach: torn tails, failed appends kept and
dropped, sessions read again after an unload, removals undone by a crash, and a
long line listed before a file's last. It fails if one is never reached, so the
generator cannot quietly stop covering them.

`pnpm sessions:bench` (`bench/store.ts`) measures appends on the real disk, a
listing with and without the index, and a long session an agent might leave
(10,000 events, tool output up to 50 KB): opening it, the heap it holds an
event, its trajectory, a search that matches nothing in it, and listing it
without the index. Its budgets are in `packages/core/bench/budgets.ts`.
