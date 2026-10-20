import * as path from "node:path";
import { Clock, Deferred, Duration, Effect, Exit, Option, Result, Schedule, Schema, SchemaIssue, Semaphore } from "effect";
import type { Context, Scope } from "effect";
import { assert, Events, Hooks, PluginContext } from "@lemma/core";
import type { CoreClosed } from "@lemma/core";
import { Notice, Paths, randomId } from "@lemma/contracts";
import type { IdSource } from "@lemma/contracts";
import {
  SessionAppended,
  SessionChanged,
  SessionCheckedOut,
  SessionCheckoutHook,
  SessionError,
  SessionEvent,
  SessionRemoved,
  SessionRemoveHook,
  branchOf,
  searchLog,
  searchWords,
} from "@lemma/sessions";
import type { SessionInfo, SessionSearchMatch, Sessions } from "@lemma/sessions";
import { errorCode, syncDirectory, syncParents, writeFileAtomic } from "@lemma/contracts/fs";
import type { FileSystem } from "@lemma/contracts/fs";
import { applyMarks, CHANGED_ON_DISK, confirmLast, createFile, infoOf, io, lineHash, load, openFile, scan, unfiled } from "./file.ts";
import type { Damage, FiledAs, LastLine, Scanned, Writer } from "./file.ts";
import { encodeCwd, encodeLine, EVENT_ID_BYTES, FORMAT_VERSION, idFromFileName, SESSION_ID_BYTES, sessionFile } from "./format.ts";
import type { Header, Line } from "./format.ts";
import { readIndex, writeIndex } from "./listing.ts";
import { acquireLock, REFRESH_MS, refreshLock, releaseLock } from "./lock.ts";
import type { Claimant } from "./lock.ts";

type Service = Context.Service.Shape<typeof Sessions>;

/** A session opened for reading or writing: the whole tree in memory, authoritative for this process. */
interface Open {
  readonly header: Header;
  readonly events: SessionEvent[];
  readonly byId: Map<string, SessionEvent>;
  leaf: string | undefined;
  title: string | undefined;
  marks: FiledAs;
  updatedAt: number;
  /** What reading the file saw: the first write cuts a torn tail past `validBytes`, unless the file is no longer `size`. */
  readonly validBytes: number;
  readonly size: number;
  /** The file through the last line read or written: what `list` knows of it once the session is unloaded. */
  tail: { readonly validBytes: number; readonly lines: number } & LastLine;
  writer?: Writer;
  /** Where its log stops reading: it serves what came before, and refuses every write (`ReadOnly`). */
  readonly damage?: Damage;
}

/** Every session file seen. `info` is cached for `list`; `scanned` is the file as last read, or as memory knew it when unloaded. */
interface Entry {
  readonly id: string;
  /** Where it is: `relocate` moves it to its new directory's. */
  file: string;
  /** Serializes loading, appends, checkouts, and unloading. */
  readonly lock: Semaphore.Semaphore;
  info: SessionInfo;
  scanned?: Scanned;
  open?: Open;
  /** Epoch milliseconds of the last operation on the session; `list` does not count. */
  lastUsed: number;
}

const decodeEvent = Schema.decodeUnknownResult(SessionEvent, { onExcessProperty: "error" });

/** What `search` finds at most when not told, and how many logs it reads at once. */
const SEARCH_LIMIT = 20;
const SEARCH_READS = 8;
const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();

/**
 * The event as reading its line back will give it, or why it cannot be written. JSON
 * drops what it cannot carry (`NaN` becomes `null`, `undefined` disappears), and a field
 * the schema lacks would be dropped on reading: either way memory and a reload would
 * disagree, or the line would not read back at all.
 */
const asRead = (event: SessionEvent): Result.Result<SessionEvent, string> => {
  let json: unknown;
  try {
    json = JSON.parse(JSON.stringify(event));
  } catch (cause) {
    return Result.fail(cause instanceof Error ? cause.message : String(cause));
  }
  return Result.mapError(decodeEvent(json), (error) => {
    const [issue] = formatIssues(error.issue).issues;
    return issue === undefined ? (error.message.split("\n")[0] ?? error.message) : `${issue.path?.join(".") ?? ""}: ${issue.message}`;
  });
};

const notFound = (sessionId: string, message: string) => new SessionError({ sessionId, reason: "NotFound", message });

const infoOfOpen = (open: Open): SessionInfo =>
  infoOf(open.header, {
    leaf: open.leaf,
    title: open.title,
    marks: open.marks,
    updatedAt: open.updatedAt,
    lastSeq: open.events.length,
    ...(open.damage === undefined ? {} : { damage: open.damage }),
  });

/** What `list` knows of an open session's file, from memory and its `stat`: nothing is read. */
const scannedOf = (open: Open, stat: { readonly size: number; readonly mtimeMs: number; readonly ino: number }): Scanned => ({
  size: stat.size,
  mtimeMs: stat.mtimeMs,
  ino: stat.ino,
  ...open.tail,
  info: infoOfOpen(open),
});

interface Options {
  /** Seconds an open session may go unused before it is unloaded; 0 keeps it loaded. */
  readonly unloadAfter: number;
  /** Seconds a session may stay empty since it was made, and not kept, before it is deleted; 0 keeps them all. */
  readonly emptyAfter: number;
  /** Where the files are: the real file system, or a simulated disk in tests. Time comes from Effect's `Clock`. */
  readonly fs: FileSystem;
  /** Where session and event ids' random bytes come from. */
  readonly ids: IdSource;
  /** The process taking the sessions lock. */
  readonly claimant: Claimant;
}

export const make = ({
  unloadAfter,
  emptyAfter,
  fs,
  ids,
  claimant,
}: Options): Effect.Effect<Service, SessionError | CoreClosed, Paths | Events | Hooks | PluginContext | Scope.Scope> =>
  Effect.gen(function* () {
    const paths = yield* Paths;
    const events = yield* Events;
    const hooks = yield* Hooks;
    const owner = yield* PluginContext;
    const root = path.join(paths.home, "sessions");
    // Taken first, so it is released last, after every file is closed.
    const holder = yield* Effect.acquireRelease(acquireLock(root, claimant, fs), (holder) => releaseLock(root, holder, fs));
    // Kept fresh while the store runs, so another process sees it live; one that took it over stops this store.
    yield* owner.background("keep the sessions lock", Effect.repeat(refreshLock(root, holder, fs), Schedule.spaced(Duration.millis(REFRESH_MS))), {
      required: true,
    });
    const entries = new Map<string, Entry>();
    /**
     * The files this process has made durable before serving them (`confirmLast`), or created, and the directories
     * whose names it has synced: once each, as only an earlier process can have left them unsynced.
     */
    const confirmed = new Set<string>();
    const syncedDirectories = new Map<string, Promise<void>>();
    const syncOnce = (dir: string) => {
      const synced = syncedDirectories.get(dir) ?? syncDirectory(fs, dir);
      syncedDirectories.set(dir, synced);
      // A failure is tried again by the next load.
      return synced.catch((cause) => {
        syncedDirectories.delete(dir);
        throw cause;
      });
    };
    /** The listing index: each file's `Scanned`, by path under `root`. */
    const index = yield* readIndex(fs, root);
    let indexChanged = false;
    const keyOf = (file: string) => path.relative(root, file);
    const record = (entry: Entry, scanned: Scanned) => {
      entry.scanned = scanned;
      index.set(keyOf(entry.file), scanned);
      indexChanged = true;
    };
    // Whole or not begun: a write the store's close cut off would go on regardless (a promise is not stopped by
    // interrupting what awaits it), and land after the close, over what the next start wrote.
    const saveIndex = Effect.suspend(() => {
      if (!indexChanged) return Effect.void;
      indexChanged = false;
      return Effect.uninterruptible(writeIndex(fs, root, index));
    });
    // A failed write's leftover bytes are cut first: the next start would read them as appended. Each open
    // session is then indexed from memory, so the next start reads none of them.
    yield* Effect.addFinalizer(() =>
      Effect.andThen(
        Effect.forEach(
          entries.values(),
          (entry) => {
            const open = entry.open;
            if (open === undefined) return Effect.void;
            const indexed = Effect.gen(function* () {
              if (open.writer !== undefined) yield* open.writer.settle;
              record(entry, scannedOf(open, yield* stat(entry.file)));
            });
            return Effect.andThen(Effect.ignore(indexed), open.writer?.close ?? Effect.void);
          },
          { discard: true },
        ),
        saveIndex,
      ),
    );

    const warn = (message: string) => events.publish(Notice, { level: "warning", message, source: "sessions.files" });
    /** Damaged files this process has said so of once. */
    const damageTold = new Set<string>();
    const changed = (entry: Entry) => events.publish(SessionChanged, { info: entry.info });

    const remember = (id: string, file: string, info: SessionInfo, scanned?: Scanned) =>
      Effect.gen(function* () {
        const lock = yield* Semaphore.make(1);
        const lastUsed = yield* Clock.currentTimeMillis;
        const existing = entries.get(id);
        if (existing !== undefined) return existing;
        const entry: Entry = { id, file, lock, info, ...(scanned === undefined ? {} : { scanned }), lastUsed };
        entries.set(id, entry);
        return entry;
      });

    const readdir = (dir: string) =>
      Effect.tryPromise({ try: () => fs.readdir(dir), catch: io(undefined, `Cannot list ${dir}`) }).pipe(
        Effect.catchIf(
          (error) => errorCode(error.cause) === "ENOENT" || errorCode(error.cause) === "ENOTDIR",
          () => Effect.succeed([] as string[]),
        ),
      );

    /** Session files under one project directory, or all of them. */
    const files = (cwd?: string) =>
      Effect.gen(function* () {
        const dirs = cwd === undefined ? yield* readdir(root) : [encodeCwd(cwd)];
        const found: { readonly id: string; readonly file: string }[] = [];
        for (const dir of dirs) {
          for (const name of yield* readdir(path.join(root, dir))) {
            const id = idFromFileName(name);
            if (id !== undefined) found.push({ id, file: path.join(root, dir, name) });
          }
        }
        return found;
      });

    const stat = (file: string) => Effect.tryPromise({ try: () => fs.stat(file), catch: io(undefined, `Cannot stat ${file}`) });

    /**
     * Current info for a file, from memory or the index while its size, mtime, and inode are unchanged.
     * A file appended to since is read on from where the last read stopped. Open sessions are authoritative.
     */
    const refresh = (id: string, file: string): Effect.Effect<Entry, SessionError> =>
      Effect.suspend(() => {
        const at = entries.get(id)?.file ?? file;
        return refreshAt(id, at).pipe(
          // Moved meanwhile (`relocate` renames it without the lock this takes none of): read where it now is.
          Effect.catch((error) => {
            const moved = entries.get(id)?.file;
            return moved !== undefined && moved !== at ? refreshAt(id, moved) : Effect.fail(error);
          }),
        );
      });
    const refreshAt = (id: string, at: string): Effect.Effect<Entry, SessionError> =>
      Effect.gen(function* () {
        const known = entries.get(id);
        if (known?.open !== undefined) return known;
        const { mtimeMs, size, ino } = yield* stat(at);
        const prior = known?.scanned ?? index.get(keyOf(at));
        if (prior !== undefined && prior.size === size && prior.mtimeMs === mtimeMs && prior.ino === ino) {
          return known ?? (yield* remember(id, at, prior.info, prior));
        }
        const scanned = yield* scan(fs, at, id, prior !== undefined && prior.ino === ino && size >= prior.validBytes ? prior : undefined);
        const entry = known ?? (yield* remember(id, at, scanned.info));
        entry.info = scanned.info;
        record(entry, scanned);
        return entry;
      });

    /** The session an operation is on, which counts as using it now. */
    const locate = (id: string): Effect.Effect<Entry, SessionError> =>
      Effect.gen(function* () {
        let entry = entries.get(id);
        if (entry === undefined) {
          const found = (yield* files()).find((candidate) => candidate.id === id);
          if (found === undefined) return yield* notFound(id, `Session ${id} does not exist`);
          entry = yield* refresh(id, found.file);
        }
        entry.lastUsed = yield* Clock.currentTimeMillis;
        return entry;
      });

    /**
     * Loads the whole session, the first time and again after an unload; later calls reuse it. Callers hold
     * `entry.lock`, and every write goes through here: one queued behind a `remove` fails instead of recreating
     * the file, and none can write through an `Open` that was unloaded.
     */
    const openLocked = (entry: Entry): Effect.Effect<Open, SessionError> =>
      Effect.gen(function* () {
        if (entries.get(entry.id) !== entry) return yield* notFound(entry.id, `Session ${entry.id} does not exist`);
        if (entry.open !== undefined) return entry.open;
        const { scanned, ...loaded } = yield* load(fs, entry.file, entry.id);
        // A damaged log is served as it reads, and never written: confirming its last line would write.
        if (loaded.damage !== undefined && !damageTold.has(entry.file)) {
          damageTold.add(entry.file);
          yield* warn(
            `Session ${entry.id}: ${entry.file} is damaged at line ${loaded.damage.line} (${loaded.damage.reason}): it reads up to there, takes no writes, and can be forked from its last event`,
          );
        }
        // Served only once a crash cannot take it back: its last line and its name, which an earlier process may have
        // left unsynced on a failing disk.
        if (loaded.damage === undefined && !confirmed.has(entry.file)) {
          yield* Effect.tryPromise({
            try: async () => {
              await confirmLast(fs, entry.file, scanned);
              await syncOnce(path.dirname(entry.file));
            },
            catch: io(entry.id, `Cannot make ${entry.file} durable`),
          });
          confirmed.add(entry.file);
        }
        if (loaded.damage === undefined && loaded.size > loaded.validBytes) {
          const ignored = loaded.size - loaded.validBytes;
          yield* warn(`Session ${entry.id}: ignored the last ${ignored} bytes of ${entry.file}, a write a crash cut short; they are cut before the next write`);
        }
        const { validBytes, lines, lastStart, lastHash } = scanned;
        const open: Open = { ...loaded, tail: { validBytes, lines, lastStart, lastHash } };
        const wasDamaged = entry.info.damaged !== undefined;
        entry.open = open;
        entry.info = infoOfOpen(open);
        record(entry, scanned);
        // Damage the listing's cheap read did not see (a parent, an id): clients following sessions hear of it.
        if (open.damage !== undefined && !wasDamaged) yield* changed(entry);
        return open;
      });

    const opened = (sessionId: string) =>
      Effect.flatMap(locate(sessionId), (entry) => (entry.open !== undefined ? Effect.succeed(entry.open) : entry.lock.withPermits(1)(openLocked(entry))));

    const writerOf = (entry: Entry, open: Open) =>
      open.writer !== undefined
        ? Effect.succeed(open.writer)
        : Effect.tap(openFile(fs, entry.file, entry.id, open), (writer) =>
            Effect.sync(() => {
              open.writer = writer;
            }),
          );

    /** Drops the session from memory and closes its file: the next use reads it again. */
    const forget = (entry: Entry) =>
      Effect.suspend(() => {
        const writer = entry.open?.writer;
        delete entry.open;
        return writer?.close ?? Effect.void;
      });

    /**
     * Writes `line`, applies `update` to the in-memory session, and announces the change,
     * uninterruptibly: an interrupted write can still reach disk, memory that missed it would
     * reuse its `seq`, and a change made but never announced would leave a client following
     * the session waiting. A file another program changed no longer matches memory, which is
     * dropped. Callers hold `entry.lock`.
     */
    const commit = (entry: Entry, open: Open, line: Line, update: () => void, announce: Effect.Effect<void> = Effect.void) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          if (open.damage !== undefined) {
            return yield* new SessionError({
              sessionId: entry.id,
              reason: "ReadOnly",
              message: `Session ${entry.id} is damaged at line ${open.damage.line} (${open.damage.reason}): it takes no writes; fork it to go on`,
            });
          }
          const writer = yield* writerOf(entry, open);
          const text = encodeLine(line);
          yield* writer.write(text);
          const start = open.tail.validBytes;
          open.tail = { validBytes: start + Buffer.byteLength(text), lines: open.tail.lines + 1, lastStart: start, lastHash: lineHash(text.slice(0, -1)) };
          update();
          entry.info = infoOfOpen(open);
          yield* announce;
          yield* changed(entry);
        }).pipe(Effect.tapError((error) => (error.cause === CHANGED_ON_DISK ? forget(entry) : Effect.void))),
      );

    const create: Service["create"] = (options) =>
      Effect.gen(function* () {
        const cwd = path.resolve(options?.cwd ?? paths.cwd);
        const createdAt = yield* Clock.currentTimeMillis;
        let id = randomId(ids, SESSION_ID_BYTES);
        while (entries.has(id)) id = randomId(ids, SESSION_ID_BYTES);
        const header: Header = { type: "session", version: FORMAT_VERSION, id, cwd, createdAt };
        const file = sessionFile(root, cwd, createdAt, id);
        const line = encodeLine(header);
        const bytes = Buffer.byteLength(line);
        // Uninterruptible until the entry holds the writer, so its file is always closed.
        const entry = yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const writer = yield* createFile(fs, file, header);
            // Created and synced here: nothing of it is an earlier process's.
            confirmed.add(file);
            const open: Open = {
              header,
              events: [],
              byId: new Map(),
              leaf: undefined,
              title: undefined,
              marks: unfiled,
              updatedAt: createdAt,
              validBytes: bytes,
              size: bytes,
              tail: { validBytes: bytes, lines: 1, lastStart: 0, lastHash: lineHash(line.slice(0, -1)) },
              writer,
            };
            const entry = yield* remember(id, file, infoOfOpen(open));
            entry.open = open;
            return entry;
          }),
        );
        // Indexed as created, so a restarted host reads only what was appended since.
        const created = yield* Effect.option(stat(file));
        if (Option.isSome(created) && entry.open !== undefined) record(entry, scannedOf(entry.open, created.value));
        yield* changed(entry);
        return entry.info;
      });

    const append: Service["append"] = (sessionId, data, options) =>
      Effect.gen(function* () {
        const entry = yield* locate(sessionId);
        return yield* entry.lock.withPermits(1)(
          Effect.gen(function* () {
            const open = yield* openLocked(entry);
            const parent = options?.parent ?? open.leaf ?? null;
            if (parent !== null && !open.byId.has(parent)) {
              return yield* new SessionError({ sessionId, reason: "InvalidParent", message: `Event ${parent} does not exist in session ${sessionId}` });
            }
            let id = randomId(ids, EVENT_ID_BYTES);
            while (open.byId.has(id)) id = randomId(ids, EVENT_ID_BYTES);
            // A line that does not read back as it was written would make memory and a reload disagree, or the session unreadable.
            const read = asRead({ seq: open.events.length + 1, id, parent, at: yield* Clock.currentTimeMillis, data });
            if (Result.isFailure(read)) {
              return yield* new SessionError({ sessionId, reason: "Corrupt", message: `Refusing to append an invalid event: ${read.failure}` });
            }
            const event = read.success;
            yield* commit(
              entry,
              open,
              event,
              () => {
                open.events.push(event);
                open.byId.set(id, event);
                open.leaf = id;
                open.updatedAt = Math.max(open.updatedAt, event.at);
                if (event.data.type === "title") open.title = event.data.title;
                // As `load` checks each line it reads back: seqs count from 1 without a gap, and every id is new.
                assert(open.events.length === event.seq, `session ${sessionId}: event ${id} has seq ${event.seq} at ${open.events.length}`);
                assert(open.byId.size === open.events.length, `session ${sessionId}: ${open.byId.size} ids for ${open.events.length} events`);
              },
              events.publish(SessionAppended, { sessionId, event }),
            );
            return event;
          }),
        );
      });

    /** What `checkout` does once every `SessionCheckoutHook` handler let it. */
    const checkoutNow = (sessionId: string, target: string) =>
      Effect.gen(function* () {
        const entry = yield* locate(sessionId);
        return yield* entry.lock.withPermits(1)(
          Effect.gen(function* () {
            const open = yield* openLocked(entry);
            if (!open.byId.has(target)) return yield* notFound(sessionId, `Event ${target} does not exist in session ${sessionId}`);
            const from = open.leaf;
            const at = yield* Clock.currentTimeMillis;
            yield* commit(
              entry,
              open,
              { type: "checkout", leaf: target, at },
              () => {
                open.leaf = target;
                open.updatedAt = Math.max(open.updatedAt, at);
              },
              events.publish(SessionCheckedOut, { sessionId, from, to: target }),
            );
            return entry.info;
          }),
        );
      });

    const checkout: Service["checkout"] = (sessionId, target) =>
      Effect.gen(function* () {
        const from = (yield* locate(sessionId)).info.leaf;
        return yield* hooks
          .invoke(SessionCheckoutHook, { sessionId, eventId: target, from }, (input) => checkoutNow(input.sessionId, input.eventId))
          .pipe(
            // Hook misuse and a closing core are defects here: the contract's error channel is SessionError.
            Effect.catch((error) => (error._tag === "SessionError" ? Effect.fail(error) : Effect.die(error))),
          );
      });

    const mark: Service["mark"] = (sessionId, marks) =>
      Effect.gen(function* () {
        const entry = yield* locate(sessionId);
        return yield* entry.lock.withPermits(1)(
          Effect.gen(function* () {
            const open = yield* openLocked(entry);
            const line = { type: "marks" as const, ...marks, at: yield* Clock.currentTimeMillis };
            yield* commit(entry, open, line, () => {
              open.marks = applyMarks(open.marks, marks);
            });
            return entry.info;
          }),
        );
      });

    /** How many holds each held session has (`hold`). */
    const holds = new Map<string, number>();
    /**
     * The sessions whose file `removeNow` is deleting, each with what completes once it has, or has failed to. It
     * checks for holds and marks the session in one step, and calls nothing outside the store until the mark goes,
     * so a hold asked for meanwhile waits on the disk alone.
     */
    const deleting = new Map<string, Deferred.Deferred<void>>();
    const busy = (sessionId: string) =>
      new SessionError({ sessionId, reason: "Busy", message: "This session is in use, by a running turn or other work; stop it before deleting" });

    const hold: Service["hold"] = (sessionId) =>
      Effect.flatMap(locate(sessionId), (entry) =>
        Effect.acquireRelease(
          // Counted in the step that finds it is not being deleted.
          Effect.suspend(() => {
            if (entries.get(sessionId) !== entry) return Effect.fail(notFound(sessionId, `Session ${sessionId} does not exist`));
            const deletion = deleting.get(sessionId);
            if (deletion === undefined) holds.set(sessionId, (holds.get(sessionId) ?? 0) + 1);
            return Effect.succeed(deletion);
          }),
          (deletion) =>
            deletion !== undefined
              ? Effect.void
              : Effect.sync(() => {
                  const left = (holds.get(sessionId) ?? 1) - 1;
                  if (left === 0) holds.delete(sessionId);
                  else holds.set(sessionId, left);
                }),
        ).pipe(
          // Being deleted: whether it is gone is known once the deletion has ended.
          Effect.flatMap((deletion) => (deletion === undefined ? Effect.void : Effect.andThen(Deferred.await(deletion), hold(sessionId)))),
        ),
      );

    /**
     * Moves an empty session: the new directory is written to its file first (a marks record), so wherever a crash
     * leaves the file it reads as moved; then the file is renamed into that directory's folder, best effort, as the
     * folder only groups files and `list` by directory looks there.
     */
    const relocate: Service["relocate"] = (sessionId, to) =>
      Effect.gen(function* () {
        const cwd = path.resolve(to);
        const entry = yield* locate(sessionId);
        return yield* entry.lock.withPermits(1)(
          Effect.uninterruptible(
            Effect.gen(function* () {
              const open = yield* openLocked(entry);
              if (open.events.length > 0) {
                return yield* new SessionError({ sessionId, reason: "NotEmpty", message: `Session ${sessionId} has events: only an empty session moves` });
              }
              if (holds.has(sessionId) || deleting.has(sessionId)) return yield* busy(sessionId);
              if (entry.info.cwd === cwd) return entry.info;
              yield* commit(entry, open, { type: "marks", cwd, at: yield* Clock.currentTimeMillis }, () => {
                open.marks = applyMarks(open.marks, { cwd });
              });
              const file = sessionFile(root, cwd, open.header.createdAt, sessionId);
              if (file === entry.file) return entry.info;
              const from = entry.file;
              // Closed before the rename, and the session dropped from memory as an unload drops it: the next use reads
              // it again where it now is.
              if (open.writer !== undefined) yield* open.writer.settle;
              yield* forget(entry);
              let created: unknown;
              const moved = yield* Effect.exit(
                Effect.tryPromise({
                  try: async () => {
                    created = await fs.mkdir(path.dirname(file), { recursive: true });
                    await fs.rename(from, file);
                    // Where it is from the moment it is there: a `list` or `get` meanwhile looks for it there.
                    entry.file = file;
                  },
                  catch: io(sessionId, `Cannot move ${from} to ${file}`),
                }),
              );
              if (Exit.isFailure(moved)) {
                yield* warn(`Session ${sessionId} moved to ${cwd}, but its file stays in ${path.dirname(from)}`);
                return entry.info;
              }
              indexChanged = index.delete(keyOf(from)) || indexChanged;
              // Its new name made durable: until it is, a crash may leave the file in the old folder, where it still
              // reads as moved (its marks say so), and the next load makes it durable.
              const synced = yield* Effect.exit(
                Effect.tryPromise({
                  try: async () => {
                    await syncDirectory(fs, path.dirname(file));
                    await syncParents(fs, path.dirname(file), created);
                    await syncDirectory(fs, path.dirname(from)).catch(() => undefined);
                  },
                  catch: io(sessionId, `Cannot make ${file} durable`),
                }),
              );
              if (Exit.isSuccess(synced)) confirmed.add(file);
              else yield* warn(`Session ${sessionId} moved to ${cwd}, but its new name may not survive a crash yet`);
              const at = yield* Effect.option(stat(file));
              if (Option.isSome(at)) record(entry, scannedOf(open, at.value));
              return entry.info;
            }),
          ),
        );
      });

    /**
     * `Sessions.fork`: the branch ending at `eventId`, written whole into a new file at once (a temporary file, synced,
     * then linked into place), so a crash leaves the new session complete or absent, never part of it.
     */
    const fork: Service["fork"] = (sessionId, eventId) =>
      Effect.gen(function* () {
        const source = yield* opened(sessionId);
        if (!source.byId.has(eventId)) return yield* notFound(sessionId, `Event ${eventId} is not in session ${sessionId}`);
        const branch = branchOf(source.events, eventId).map((event, index) => ({ ...event, seq: index + 1 }));
        const cwd = source.marks.cwd ?? source.header.cwd;
        const createdAt = yield* Clock.currentTimeMillis;
        let id = randomId(ids, SESSION_ID_BYTES);
        while (entries.has(id)) id = randomId(ids, SESSION_ID_BYTES);
        const header: Header = { type: "session", version: FORMAT_VERSION, id, cwd, createdAt };
        const file = sessionFile(root, cwd, createdAt, id);
        const text = [header, ...branch].map(encodeLine).join("");
        const written = yield* Effect.tryPromise({
          try: () => writeFileAtomic(file, text, { fs, mode: 0o644, dirMode: 0o755, sync: true, exclusive: true }),
          catch: io(id, `Cannot write ${file}`),
        });
        if (!written) return yield* new SessionError({ sessionId: id, reason: "Io", message: `Cannot write ${file}: it exists` });
        confirmed.add(file);
        let title: string | undefined;
        let updatedAt = createdAt;
        for (const event of branch) {
          if (event.data.type === "title") title = event.data.title;
          updatedAt = Math.max(updatedAt, event.at);
        }
        const info = infoOf(header, {
          leaf: eventId,
          title,
          marks: unfiled,
          updatedAt,
          lastSeq: branch.length,
        });
        const entry = yield* remember(id, file, info);
        yield* changed(entry);
        return entry.info;
      });

    /**
     * `Sessions.search`: the sessions with something in them, the most recently updated first, read a few at a time
     * until `limit` have matched. One loaded is read in memory; any other from its file, let go after, without counting
     * as a use or being made durable; one unreadable is passed over.
     */
    const search: Service["search"] = (query, options) =>
      Effect.gen(function* () {
        const words = searchWords(query);
        const limit = options?.limit ?? SEARCH_LIMIT;
        if (words.length === 0) return [];
        const said = (yield* list()).filter((info) => info.lastSeq > 0);
        const found: SessionSearchMatch[] = [];
        for (let at = 0; at < said.length && found.length < limit; at += SEARCH_READS) {
          const matches = yield* Effect.forEach(
            said.slice(at, at + SEARCH_READS),
            (info) =>
              Effect.orElseSucceed(
                Effect.map(readBranch(info.id), (events) => searchLog(info.id, events, words)),
                () => undefined,
              ),
            { concurrency: SEARCH_READS },
          );
          for (const match of matches) if (match !== undefined) found.push(match);
        }
        return found.slice(0, limit);
      });
    /** A session's current branch, from memory when it is loaded, else read from its file and not kept. */
    const readBranch = (sessionId: string): Effect.Effect<readonly SessionEvent[], SessionError> =>
      Effect.suspend(() => {
        const entry = entries.get(sessionId);
        if (entry === undefined) return Effect.succeed([]);
        if (entry.open !== undefined) return Effect.succeed(branchOf(entry.open.events, entry.open.leaf));
        return Effect.map(load(fs, entry.file, sessionId), (loaded) => branchOf(loaded.events, loaded.leaf));
      });

    /**
     * Deletes the sessions nothing has gone into for `emptyAfter` seconds since they were made, unless kept (a client
     * holds something for them), filed (pinned, archived), or held: new threads a client made and left. Run as the
     * store starts and every hour after.
     */
    const sweepEmpty = (emptyAfter: number) =>
      Effect.gen(function* () {
        const cutoff = (yield* Clock.currentTimeMillis) - emptyAfter * 1000;
        for (const info of yield* list()) {
          // A damaged one may hold events past where it stops reading: never thrown away for looking empty.
          if (info.lastSeq > 0 || info.damaged !== undefined || info.kept === true || info.pinned === true || info.archived === true || info.createdAt > cutoff)
            continue;
          // One in use, or refused by a hook, stays.
          yield* Effect.ignore(remove(info.id));
        }
      });

    /** What `remove` does once every `SessionRemoveHook` handler let it. */
    const removeNow = (sessionId: string) =>
      Effect.gen(function* () {
        const entry = yield* locate(sessionId);
        yield* entry.lock.withPermits(1)(
          // Uninterruptible, so memory matches whether the file went, and its removal is announced.
          Effect.uninterruptible(
            Effect.gen(function* () {
              const deletion = yield* Effect.suspend(() => {
                if (entries.get(sessionId) !== entry) return Effect.fail(notFound(sessionId, `Session ${sessionId} does not exist`));
                if (holds.has(sessionId)) return Effect.fail(busy(sessionId));
                const deletion = Deferred.makeUnsafe<void>();
                deleting.set(sessionId, deletion);
                return Effect.succeed(deletion);
              });
              const deleted = yield* Effect.exit(
                Effect.gen(function* () {
                  // Delete before closing: a failed delete leaves the session exactly as it was, writer included.
                  yield* Effect.tryPromise({ try: () => fs.rm(entry.file), catch: io(sessionId, `Cannot delete ${entry.file}`) });
                  // So a crash does not bring it back. Best effort: the file is gone either way, and a session that
                  // returns after a crash on a failing disk is whole.
                  yield* Effect.promise(() => syncDirectory(fs, path.dirname(entry.file)).catch(() => undefined));
                  entries.delete(sessionId);
                  indexChanged = index.delete(keyOf(entry.file)) || indexChanged;
                  yield* entry.open?.writer?.close ?? Effect.void;
                }),
              );
              deleting.delete(sessionId);
              yield* Deferred.succeed(deletion, undefined);
              if (Exit.isFailure(deleted)) return yield* Effect.failCause(deleted.cause);
              yield* events.publish(SessionRemoved, { sessionId });
            }),
          ),
        );
      });

    const remove: Service["remove"] = (sessionId) =>
      Effect.suspend(() =>
        // Refused before its handlers run, too, so they see no removal a hold refuses.
        holds.has(sessionId)
          ? Effect.fail(busy(sessionId))
          : hooks
              .invoke(SessionRemoveHook, { sessionId }, (input) => removeNow(input.sessionId))
              .pipe(
                // Hook misuse and a closing core are defects here: the contract's error channel is SessionError.
                Effect.catch((error) => (error._tag === "SessionError" ? Effect.fail(error) : Effect.die(error))),
              ),
      );

    const branch: Service["branch"] = (sessionId, options) =>
      Effect.flatMap(opened(sessionId), (open) => {
        const leaf = options?.leaf ?? open.leaf;
        if (options?.leaf !== undefined && !open.byId.has(options.leaf)) {
          return Effect.fail(notFound(sessionId, `Event ${options.leaf} does not exist in session ${sessionId}`));
        }
        const path: SessionEvent[] = [];
        for (let at = leaf === undefined ? undefined : open.byId.get(leaf); at !== undefined; at = at.parent === null ? undefined : open.byId.get(at.parent)) {
          path.push(at);
        }
        return Effect.succeed(path.reverse());
      });

    const list: Service["list"] = (options) =>
      Effect.gen(function* () {
        const cwd = options?.cwd === undefined ? undefined : path.resolve(options.cwd);
        const found = yield* files(cwd);
        const infos = yield* Effect.forEach(
          found,
          ({ id, file }) =>
            refresh(id, file).pipe(
              Effect.map((entry) => Option.some(entry.info)),
              // One unreadable file is reported, not fatal to the listing.
              Effect.catch((error) => Effect.as(warn(error.message), Option.none<SessionInfo>())),
            ),
          { concurrency: 16 },
        );
        if (cwd === undefined) {
          // Every file was listed, so the index forgets the ones that are gone.
          const present = new Set(found.map(({ file }) => keyOf(file)));
          for (const key of index.keys()) if (!present.has(key)) indexChanged = index.delete(key) || indexChanged;
        }
        yield* saveIndex;
        return infos
          .flatMap((info) => (Option.isSome(info) && (cwd === undefined || info.value.cwd === cwd) ? [info.value] : []))
          .sort((a, b) => b.updatedAt - a.updatedAt);
      });

    /**
     * Closes a session unused since `cutoff` and drops its events; `info` stays for `list`, indexed from
     * memory so the file is not re-read, and the next operation reloads it through `openLocked`. Callers hold
     * `entry.lock`. A failed write's leftover bytes are cut first, or the session stays: a reload would read them.
     */
    const unload = (entry: Entry, cutoff: number) =>
      Effect.gen(function* () {
        const open = entry.open;
        if (open === undefined || entry.lastUsed > cutoff || entries.get(entry.id) !== entry) return;
        if (open.writer !== undefined) yield* open.writer.settle;
        const stamp = yield* Effect.option(stat(entry.file));
        delete entry.open;
        if (Option.isSome(stamp)) record(entry, scannedOf(open, stamp.value));
        yield* open.writer?.close ?? Effect.void;
      });

    if (unloadAfter > 0) {
      const idleMs = unloadAfter * 1000;
      // A session busy with an operation is in use: skipped, not waited for.
      const sweep = Effect.flatMap(Clock.currentTimeMillis, (now) => {
        const cutoff = now - idleMs;
        return Effect.forEach(
          [...entries.values()].filter((entry) => entry.open !== undefined && entry.lastUsed <= cutoff),
          (entry) => Effect.ignore(entry.lock.withPermitsIfAvailable(1)(Effect.uninterruptible(unload(entry, cutoff)))),
          { discard: true },
        );
      });
      yield* owner.background("unload idle sessions", Effect.repeat(sweep, Schedule.spaced(Duration.millis(Math.min(idleMs / 2, 60_000)))));
    }
    if (emptyAfter > 0) {
      // A failed sweep (a disk error listing) is tried again at the next.
      yield* owner.background("delete abandoned empty sessions", Effect.repeat(Effect.ignore(sweepEmpty(emptyAfter)), Schedule.spaced(Duration.hours(1))));
    }

    return {
      create,
      list,
      get: (sessionId) =>
        Effect.flatMap(locate(sessionId), (entry) =>
          entry.open !== undefined ? Effect.succeed(entry.info) : Effect.map(refresh(entry.id, entry.file), (fresh) => fresh.info),
        ),
      append,
      events: (sessionId, options) => Effect.map(opened(sessionId), (open) => open.events.slice(Math.max(0, options?.after ?? 0))),
      branch,
      checkout,
      mark,
      relocate,
      fork,
      search,
      hold,
      remove,
    } satisfies Service;
  });
