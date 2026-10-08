import * as path from "node:path";
import { Clock, Duration, Effect, Option, Result, Schedule, Schema, SchemaIssue, Semaphore } from "effect";
import type { Context, Scope } from "effect";
import { Events, Hooks, PluginContext } from "@lemma/core";
import type { CoreClosed } from "@lemma/core";
import { Notice, Paths, SessionAppended, SessionChanged, SessionError, SessionEvent, SessionRemoved, SessionRemoveHook } from "@lemma/contracts";
import type { SessionInfo, Sessions } from "@lemma/contracts";
import { errorCode } from "@lemma/contracts/fs";
import type { FileSystem } from "@lemma/contracts/fs";
import { applyMarks, CHANGED_ON_DISK, createFile, infoOf, io, lineHash, load, openFile, scan, syncDirectory, unfiled } from "./file.ts";
import type { FiledAs, LastLine, Scanned, Writer } from "./file.ts";
import { encodeCwd, encodeLine, eventId, idFromFileName, sessionFile, sessionId as newSessionId } from "./format.ts";
import type { Header, Line } from "./format.ts";
import { readIndex, writeIndex } from "./listing.ts";
import { acquireLock, REFRESH_MS, refreshLock, releaseLock } from "./lock.ts";

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
}

/** Every session file seen. `info` is cached for `list`; `scanned` is the file as last read, or as memory knew it when unloaded. */
interface Entry {
  readonly id: string;
  readonly file: string;
  /** Serializes loading, appends, checkouts, and unloading. */
  readonly lock: Semaphore.Semaphore;
  info: SessionInfo;
  scanned?: Scanned;
  open?: Open;
  /** Epoch milliseconds of the last operation on the session; `list` does not count. */
  lastUsed: number;
}

const decodeEvent = Schema.decodeUnknownResult(SessionEvent, { onExcessProperty: "error" });
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
  infoOf(open.header, { leaf: open.leaf, title: open.title, marks: open.marks, updatedAt: open.updatedAt, lastSeq: open.events.length });

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
  /** Where the files are: the real file system, or a simulated disk in tests. Time comes from Effect's `Clock`. */
  readonly fs: FileSystem;
}

export const make = ({ unloadAfter, fs }: Options): Effect.Effect<Service, SessionError | CoreClosed, Paths | Events | Hooks | PluginContext | Scope.Scope> =>
  Effect.gen(function* () {
    const paths = yield* Paths;
    const events = yield* Events;
    const hooks = yield* Hooks;
    const owner = yield* PluginContext;
    const root = path.join(paths.home, "sessions");
    // Taken first, so it is released last, after every file is closed.
    const holder = yield* Effect.acquireRelease(acquireLock(root, undefined, fs), (holder) => releaseLock(root, holder, fs));
    // Kept fresh while the store runs, so another process sees it live; one that took it over stops this store.
    yield* owner.background("keep the sessions lock", Effect.repeat(refreshLock(root, holder, fs), Schedule.spaced(Duration.millis(REFRESH_MS))), {
      required: true,
    });
    const entries = new Map<string, Entry>();
    /** The listing index: each file's `Scanned`, by path under `root`. */
    const index = yield* readIndex(fs, root);
    let indexChanged = false;
    const keyOf = (file: string) => path.relative(root, file);
    const record = (entry: Entry, scanned: Scanned) => {
      entry.scanned = scanned;
      index.set(keyOf(entry.file), scanned);
      indexChanged = true;
    };
    const saveIndex = Effect.suspend(() => {
      if (!indexChanged) return Effect.void;
      indexChanged = false;
      return writeIndex(fs, root, index);
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

    const warn = (message: string) => events.publish(Notice, { level: "warning", message, source: "sessions" });
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
      Effect.gen(function* () {
        const known = entries.get(id);
        if (known?.open !== undefined) return known;
        const at = known?.file ?? file;
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
        if (loaded.size > loaded.validBytes) {
          const ignored = loaded.size - loaded.validBytes;
          yield* warn(`Session ${entry.id}: ignored the last ${ignored} bytes of ${entry.file}, a write a crash cut short; they are cut before the next write`);
        }
        const { validBytes, lines, lastStart, lastHash } = scanned;
        const open: Open = { ...loaded, tail: { validBytes, lines, lastStart, lastHash } };
        entry.open = open;
        entry.info = infoOfOpen(open);
        record(entry, scanned);
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
        let id = yield* newSessionId;
        while (entries.has(id)) id = yield* newSessionId;
        const header: Header = { type: "session", version: 1, id, cwd, createdAt };
        const file = sessionFile(root, cwd, createdAt, id);
        const line = encodeLine(header);
        const bytes = Buffer.byteLength(line);
        // Uninterruptible until the entry holds the writer, so its file is always closed.
        const entry = yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const writer = yield* createFile(fs, file, header);
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
            let id = yield* eventId;
            while (open.byId.has(id)) id = yield* eventId;
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
              },
              events.publish(SessionAppended, { sessionId, event }),
            );
            return event;
          }),
        );
      });

    const checkout: Service["checkout"] = (sessionId, target) =>
      Effect.gen(function* () {
        const entry = yield* locate(sessionId);
        return yield* entry.lock.withPermits(1)(
          Effect.gen(function* () {
            const open = yield* openLocked(entry);
            if (!open.byId.has(target)) return yield* notFound(sessionId, `Event ${target} does not exist in session ${sessionId}`);
            const at = yield* Clock.currentTimeMillis;
            yield* commit(entry, open, { type: "checkout", leaf: target, at }, () => {
              open.leaf = target;
              open.updatedAt = Math.max(open.updatedAt, at);
            });
            return entry.info;
          }),
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

    /** What `remove` does once every `SessionRemoveHook` handler let it. */
    const removeNow = (sessionId: string) =>
      Effect.gen(function* () {
        const entry = yield* locate(sessionId);
        yield* entry.lock.withPermits(1)(
          // Uninterruptible, so memory matches whether the file went, and its removal is announced.
          Effect.uninterruptible(
            Effect.gen(function* () {
              if (entries.get(sessionId) !== entry) return yield* notFound(sessionId, `Session ${sessionId} does not exist`);
              // Delete before closing: a failed delete leaves the session exactly as it was, writer included.
              yield* Effect.tryPromise({ try: () => fs.rm(entry.file), catch: io(sessionId, `Cannot delete ${entry.file}`) });
              // So a crash does not bring it back. Best effort: the file is gone either way, and a session that
              // returns after a crash on a failing disk is whole.
              yield* Effect.promise(() => syncDirectory(fs, path.dirname(entry.file)).catch(() => undefined));
              entries.delete(sessionId);
              indexChanged = index.delete(keyOf(entry.file)) || indexChanged;
              yield* entry.open?.writer?.close ?? Effect.void;
              yield* events.publish(SessionRemoved, { sessionId });
            }),
          ),
        );
      });

    const remove: Service["remove"] = (sessionId) =>
      hooks
        .invoke(SessionRemoveHook, { sessionId }, (input) => removeNow(input.sessionId))
        .pipe(
          // Hook misuse and a closing core are defects here: the contract's error channel is SessionError.
          Effect.catch((error) => (error._tag === "SessionError" ? Effect.fail(error) : Effect.die(error))),
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
      remove,
    } satisfies Service;
  });
