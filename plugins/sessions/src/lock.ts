import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effect, Option, Schema } from "effect";
import { SessionError } from "@lemma/contracts";
import { errorCode, isAlive, writeFileAtomic } from "@lemma/contracts/fs";
import { io } from "./file.ts";

/**
 * One process writes a sessions directory: two appending to one session would
 * interleave, and two agents would resume the same turns. A store holds
 * `<sessions>/.lock` for its lifetime. This is a convention between Lemma
 * processes, not protection against other programs.
 */
export const lockFile = (root: string): string => path.join(root, ".lock");
/** Created by the one process taking a stale lock over, while it does. */
const guardFile = (root: string): string => `${lockFile(root)}.takeover`;

/** How often the holder refreshes the lock's modification time, so a process that cannot check it otherwise sees it live. */
export const REFRESH_MS = 10_000;
/** How long a lock may go unrefreshed before a process that cannot check its holder otherwise takes it over. */
const LEASE_MS = 30_000;
/** Slack for `bootedAt`, which uptime gives to the second, and for a clock set at boot. */
const BOOT_SLACK_MS = 10_000;
/** How old a lock that names nobody, or a takeover guard, must be before it is taken over: writing one takes far less. */
const UNREADABLE_GRACE_MS = 10_000;

/** The lock's contents. `token` is per store, so a store releases only a lock it still holds. */
const Holder = Schema.Struct({ pid: Schema.Number, hostname: Schema.String, token: Schema.String, startedAt: Schema.Number });
type Holder = typeof Holder.Type;

const decodeHolder = Schema.decodeUnknownOption(Schema.parseJson(Holder));

/** The process taking the lock. Tests stand in for other processes. */
export interface Claimant {
  readonly pid: number;
  readonly hostname: string;
  /** Whether a process on this host is running. */
  readonly isAlive: (pid: number) => boolean;
  /** Epoch ms this host booted: a lock taken before then is another process's, whatever has its pid now. */
  readonly bootedAt: number;
}

export const thisProcess: Claimant = {
  pid: process.pid,
  hostname: os.hostname(),
  bootedAt: Date.now() - os.uptime() * 1000,
  isAlive,
};

/** Creates `file` holding `text`; false when it exists. Synced: a lock emptied by a power loss would name nobody. */
const writeNew = (file: string, text: string) =>
  Effect.tryPromise({ try: () => writeFileAtomic(file, text, { exclusive: true, sync: true }), catch: io(undefined, `Cannot create ${file}`) });

/** The file's text and how long ago it was last modified; `undefined` when there is none. */
const inspect = (file: string): Effect.Effect<{ readonly text: string; readonly age: number } | undefined, SessionError> =>
  Effect.tryPromise({
    try: async () => {
      try {
        const { mtimeMs } = await fs.stat(file);
        return { text: await fs.readFile(file, "utf8"), age: Date.now() - mtimeMs };
      } catch (cause) {
        if (errorCode(cause) === "ENOENT") return undefined;
        throw cause;
      }
    },
    catch: io(undefined, `Cannot read ${file}`),
  });

const remove = (file: string) => Effect.tryPromise({ try: () => fs.rm(file, { force: true }), catch: io(undefined, `Cannot remove ${file}`) });

const inUse = (file: string, holder: Option.Option<Holder>) => {
  const who = Option.match(holder, {
    onNone: () => "an unknown process",
    onSome: ({ pid, hostname, startedAt }) => {
      const since = new Date(startedAt);
      return `process ${pid} on ${hostname}${Number.isNaN(since.getTime()) ? "" : ` (since ${since.toISOString()})`}`;
    },
  });
  return new SessionError({
    reason: "Io",
    message: `${file} is held by ${who}: another Lemma host is using these sessions. Stop that host first, or delete ${file} if it is not running.`,
  });
};

/**
 * Takes the lock, or fails naming its holder. A lock on this host is taken
 * over when its holder is this process (its own, left by a store that could
 * not remove it) or a process no longer running, or when it was taken before
 * the host last booted (its pid may be another process's now) and has not
 * been refreshed since. One from another hostname (another machine sharing
 * the directory, or this one under an old name) cannot be checked: it holds
 * while its holder refreshes it (every `REFRESH_MS`), and is taken over once
 * it has gone `LEASE_MS` without. One that names nobody is taken over once it
 * is too old to be still being written. A process takes a stale lock over
 * only while it holds the guard file beside it, so two cannot both take one
 * over; a guard left by a crash is cleared once it is old, and two processes
 * clearing one at the same instant could both go on, a window this
 * convention accepts.
 */
export function acquireLock(root: string, claimant: Claimant = thisProcess): Effect.Effect<Holder, SessionError> {
  const file = lockFile(root);
  const guard = guardFile(root);
  const self: Holder = { pid: claimant.pid, hostname: claimant.hostname, token: randomUUID(), startedAt: Date.now() };
  const text = JSON.stringify(self);
  const replace = Effect.tryPromise({ try: () => writeFileAtomic(file, text, { sync: true }), catch: io(undefined, `Cannot replace ${file}`) });
  const stale = (holder: Option.Option<Holder>, age: number) => {
    if (Option.isNone(holder)) return age > UNREADABLE_GRACE_MS || Date.now() - age < claimant.bootedAt - BOOT_SLACK_MS;
    const { pid, hostname, startedAt } = holder.value;
    if (hostname !== claimant.hostname) return age > LEASE_MS;
    if (pid === claimant.pid || !claimant.isAlive(pid)) return true;
    return startedAt < claimant.bootedAt - BOOT_SLACK_MS && age > LEASE_MS;
  };

  return Effect.gen(function* () {
    yield* Effect.tryPromise({ try: () => fs.mkdir(root, { recursive: true }), catch: io(undefined, `Cannot create ${root}`) });
    for (;;) {
      if (yield* writeNew(file, text)) return self;
      const found = yield* inspect(file);
      // Released meanwhile.
      if (found === undefined) continue;
      const holder = decodeHolder(found.text);
      if (!stale(holder, found.age)) return yield* inUse(file, holder);
      if (!(yield* writeNew(guard, text))) {
        // Another process is taking it over; or one crashed doing so, and its guard is old.
        const other = yield* inspect(guard);
        if (other !== undefined && other.age > UNREADABLE_GRACE_MS) yield* remove(guard);
        else yield* Effect.sleep(50);
        continue;
      }
      // Replaced only if it is still the lock found stale: another process may have taken it over meanwhile.
      const taken = yield* Effect.gen(function* () {
        const now = yield* inspect(file);
        if (now?.text !== found.text) return false;
        yield* replace;
        return true;
      }).pipe(Effect.ensuring(Effect.ignore(remove(guard))));
      if (taken) return self;
    }
  });
}

/**
 * Keeps the lock: touches it, so other processes see its holder live, or
 * writes it again if it was deleted. Fails when another process holds it now
 * (it took the lock over, or a user deleted it and another host started):
 * this store must stop writing. Other failures to reach the file wait for the
 * next refresh.
 */
export function refreshLock(root: string, holder: Holder): Effect.Effect<void, SessionError> {
  const file = lockFile(root);
  return Effect.gen(function* () {
    const found = yield* Effect.option(inspect(file));
    if (Option.isNone(found)) return;
    // Deleted: written again (or, if another process wrote it first, found held by that one next time).
    if (found.value === undefined) return yield* Effect.ignore(writeNew(file, JSON.stringify(holder)));
    const current = decodeHolder(found.value.text);
    if (Option.isSome(current) && current.value.token === holder.token) {
      const now = new Date();
      return yield* Effect.ignore(Effect.tryPromise(() => fs.utimes(file, now, now)));
    }
    return yield* new SessionError({ reason: "Io", message: `This host no longer holds the sessions lock: ${inUse(file, current).message}` });
  });
}

/** Removes the lock if `holder` still holds it. Best effort: a lock left behind is taken over. */
export function releaseLock(root: string, holder: Holder): Effect.Effect<void> {
  const file = lockFile(root);
  return inspect(file).pipe(
    Effect.flatMap((found) => {
      const current = found === undefined ? Option.none() : decodeHolder(found.text);
      return Option.isSome(current) && current.value.token === holder.token ? remove(file) : Effect.void;
    }),
    Effect.ignore,
  );
}
