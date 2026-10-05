import { promises as fs } from "node:fs";
import * as path from "node:path";
import { Duration, Effect, Option, Schedule, Schema } from "effect";
import type { Context, Scope } from "effect";
import { Events, PluginContext } from "@lemma/core";
import type { CoreClosed } from "@lemma/core";
import { Notice, Paths, SessionAppended, SessionChanged, SessionError, SessionEvent, SessionRemoved } from "@lemma/contracts";
import type { SessionInfo, Sessions } from "@lemma/contracts";
import { applyMarks, createFile, errorCode, infoOf, io, load, openFile, scan, unfiled } from "./file.ts";
import type { FiledAs, Writer } from "./file.ts";
import { encodeCwd, eventId, idFromFileName, sessionFile, sessionId as newSessionId } from "./format.ts";
import type { Header, Line } from "./format.ts";
import { acquireLock, REFRESH_MS, refreshLock, releaseLock } from "./lock.ts";

type Service = Context.Tag.Service<typeof Sessions>;

/** A session opened for reading or writing: the whole tree in memory, authoritative for this process. */
interface Open {
  readonly header: Header;
  readonly events: SessionEvent[];
  readonly byId: Map<string, SessionEvent>;
  leaf: string | undefined;
  title: string | undefined;
  marks: FiledAs;
  updatedAt: number;
  readonly validBytes: number;
  writer?: Writer;
}

/** Every session file seen. `info` is cached for `list`; `stamp` says when it was read from disk. */
interface Entry {
  readonly id: string;
  readonly file: string;
  /** Serializes loading, appends, checkouts, and unloading. */
  readonly lock: Effect.Semaphore;
  info: SessionInfo;
  stamp?: { readonly mtimeMs: number; readonly size: number };
  open?: Open;
  /** Epoch milliseconds of the last operation on the session; `list` does not count. */
  lastUsed: number;
}

const validateEvent = Schema.validateEither(SessionEvent);

const notFound = (sessionId: string, message: string) => new SessionError({ sessionId, reason: "NotFound", message });

const infoOfOpen = (open: Open): SessionInfo =>
  infoOf(open.header, { leaf: open.leaf, title: open.title, marks: open.marks, updatedAt: open.updatedAt, lastSeq: open.events.length });

export interface Options {
  /** Seconds an open session may go unused before it is unloaded; 0 keeps it loaded. */
  readonly unloadAfter: number;
}

export const make = ({ unloadAfter }: Options): Effect.Effect<Service, SessionError | CoreClosed, Paths | Events | PluginContext | Scope.Scope> =>
  Effect.gen(function* () {
    const paths = yield* Paths;
    const events = yield* Events;
    const owner = yield* PluginContext;
    const root = paths.sessions;
    // Taken first, so it is released last, after every file is closed.
    const holder = yield* Effect.acquireRelease(acquireLock(root), (holder) => releaseLock(root, holder));
    // Kept fresh while the store runs, so another process sees it live; one that took it over stops this store.
    yield* owner.background("keep the sessions lock", Effect.repeat(refreshLock(root, holder), Schedule.spaced(Duration.millis(REFRESH_MS))), {
      required: true,
    });
    const entries = new Map<string, Entry>();
    // A failed write's leftover bytes are cut first: the next start would read them as appended.
    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        entries.values(),
        (entry) => {
          const writer = entry.open?.writer;
          return writer === undefined ? Effect.void : Effect.zipRight(Effect.ignore(writer.settle), writer.close);
        },
        { discard: true },
      ),
    );

    const warn = (message: string) => events.publish(Notice, { level: "warning", message, source: "sessions" });
    const changed = (entry: Entry) => events.publish(SessionChanged, { info: entry.info });

    const remember = (id: string, file: string, info: SessionInfo, stamp?: Entry["stamp"]) =>
      Effect.map(Effect.makeSemaphore(1), (lock) => {
        const existing = entries.get(id);
        if (existing !== undefined) return existing;
        const entry: Entry = { id, file, lock, info, ...(stamp === undefined ? {} : { stamp }), lastUsed: Date.now() };
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

    /** Current info for a file, re-reading it only when its size or mtime changed. Open sessions are authoritative. */
    const refresh = (id: string, file: string): Effect.Effect<Entry, SessionError> =>
      Effect.gen(function* () {
        const known = entries.get(id);
        if (known?.open !== undefined) return known;
        const { mtimeMs, size } = yield* stat(known?.file ?? file);
        if (known?.stamp !== undefined && known.stamp.mtimeMs === mtimeMs && known.stamp.size === size) return known;
        const info = yield* scan(known?.file ?? file, id);
        if (known === undefined) return yield* remember(id, file, info, { mtimeMs, size });
        known.info = info;
        known.stamp = { mtimeMs, size };
        return known;
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
        entry.lastUsed = Date.now();
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
        const loaded = yield* load(entry.file, entry.id);
        if (loaded.size > loaded.validBytes) {
          const ignored = loaded.size - loaded.validBytes;
          yield* warn(`Session ${entry.id}: ignored the last ${ignored} bytes of ${entry.file}, a write a crash cut short; they are cut before the next write`);
        }
        const open: Open = { ...loaded };
        entry.open = open;
        entry.info = infoOfOpen(open);
        delete entry.stamp;
        return open;
      });

    const opened = (sessionId: string) =>
      Effect.flatMap(locate(sessionId), (entry) => (entry.open !== undefined ? Effect.succeed(entry.open) : entry.lock.withPermits(1)(openLocked(entry))));

    const writerOf = (entry: Entry, open: Open) =>
      open.writer !== undefined
        ? Effect.succeed(open.writer)
        : Effect.tap(openFile(entry.file, entry.id, open.validBytes), (writer) =>
            Effect.sync(() => {
              open.writer = writer;
            }),
          );

    /**
     * Writes `line` and then applies `update` to the in-memory session, uninterruptibly: an
     * interrupted write can still reach disk, and memory that missed it would reuse its `seq`.
     * Callers hold `entry.lock`.
     */
    const commit = (entry: Entry, open: Open, line: Line, update: () => void) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const writer = yield* writerOf(entry, open);
          yield* writer.write(line);
          update();
          entry.info = infoOfOpen(open);
        }),
      );

    const create: Service["create"] = (options) =>
      Effect.gen(function* () {
        const cwd = path.resolve(options?.cwd ?? paths.cwd);
        const createdAt = Date.now();
        let id = newSessionId();
        while (entries.has(id)) id = newSessionId();
        const header: Header = { type: "session", version: 1, id, cwd, createdAt };
        const file = sessionFile(root, cwd, createdAt, id);
        const writer = yield* createFile(file, header);
        const open: Open = {
          header,
          events: [],
          byId: new Map(),
          leaf: undefined,
          title: undefined,
          marks: unfiled,
          updatedAt: createdAt,
          validBytes: 0,
          writer,
        };
        const entry = yield* remember(id, file, infoOfOpen(open));
        entry.open = open;
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
            let id = eventId();
            while (open.byId.has(id)) id = eventId();
            const event: SessionEvent = { seq: open.events.length + 1, id, parent, at: Date.now(), data };
            // A line that does not decode later would make the whole session unreadable, so refuse it now.
            const valid = validateEvent(event);
            if (valid._tag === "Left") {
              return yield* new SessionError({
                sessionId,
                reason: "Corrupt",
                message: `Refusing to append an invalid event: ${valid.left.message.split("\n")[0]}`,
              });
            }
            yield* commit(entry, open, event, () => {
              open.events.push(event);
              open.byId.set(id, event);
              open.leaf = id;
              open.updatedAt = Math.max(open.updatedAt, event.at);
              if (data.type === "title") open.title = data.title;
            });
            yield* events.publish(SessionAppended, { sessionId, event });
            yield* changed(entry);
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
            const at = Date.now();
            yield* commit(entry, open, { type: "checkout", leaf: target, at }, () => {
              open.leaf = target;
              open.updatedAt = Math.max(open.updatedAt, at);
            });
            yield* changed(entry);
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
            const line = { type: "marks" as const, ...marks, at: Date.now() };
            yield* commit(entry, open, line, () => {
              open.marks = applyMarks(open.marks, marks);
            });
            yield* changed(entry);
            return entry.info;
          }),
        );
      });

    const remove: Service["remove"] = (sessionId) =>
      Effect.gen(function* () {
        const entry = yield* locate(sessionId);
        yield* entry.lock.withPermits(1)(
          Effect.gen(function* () {
            if (entries.get(sessionId) !== entry) return yield* notFound(sessionId, `Session ${sessionId} does not exist`);
            // Delete before closing: a failed delete leaves the session exactly as it was, writer included.
            yield* Effect.tryPromise({ try: () => fs.rm(entry.file), catch: io(sessionId, `Cannot delete ${entry.file}`) });
            entries.delete(sessionId);
            yield* entry.open?.writer?.close ?? Effect.void;
          }),
        );
        yield* events.publish(SessionRemoved, { sessionId });
      });

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
              Effect.catchAll((error) => Effect.as(warn(error.message), Option.none<SessionInfo>())),
            ),
          { concurrency: 16 },
        );
        return infos
          .flatMap((info) => (Option.isSome(info) && (cwd === undefined || info.value.cwd === cwd) ? [info.value] : []))
          .sort((a, b) => b.updatedAt - a.updatedAt);
      });

    /**
     * Closes a session unused since `cutoff` and drops its events; `info` stays for `list`, under a fresh
     * `stamp` so it is not re-read, and the next operation reloads it through `openLocked`. Callers hold
     * `entry.lock`. A failed write's leftover bytes are cut first, or the session stays: a reload would read them.
     */
    const unload = (entry: Entry, cutoff: number) =>
      Effect.gen(function* () {
        const open = entry.open;
        if (open === undefined || entry.lastUsed > cutoff || entries.get(entry.id) !== entry) return;
        if (open.writer !== undefined) yield* open.writer.settle;
        const stamp = yield* Effect.option(stat(entry.file));
        delete entry.open;
        if (Option.isSome(stamp)) entry.stamp = { mtimeMs: stamp.value.mtimeMs, size: stamp.value.size };
        yield* open.writer?.close ?? Effect.void;
      });

    if (unloadAfter > 0) {
      const idleMs = unloadAfter * 1000;
      // A session busy with an operation is in use: skipped, not waited for.
      const sweep = Effect.suspend(() => {
        const cutoff = Date.now() - idleMs;
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
