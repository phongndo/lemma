import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm, utimes } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { Duration, Effect, Either, Schedule, Schema } from "effect";
import { Credential, CredentialError } from "@lemma/contracts";
import { writeFileAtomic } from "@lemma/contracts/fs";

/** The raw file: provider id → entry. Entries are decoded on use so unknown ones survive a write untouched. */
export type RawStore = Readonly<Record<string, unknown>>;

export interface LockOptions {
  /** Give up with `Locked` after waiting this long for another holder. Default 10s. */
  readonly waitMs?: number;
  /** A lock whose file has not been touched for this long is abandoned. Holders touch it at a third of this. Default 30s. */
  readonly staleMs?: number;
}

const DEFAULT_WAIT = 10_000;
const DEFAULT_STALE = 30_000;

const errno = (cause: unknown): string | undefined => (cause as NodeJS.ErrnoException | undefined)?.code;
const describe = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));
const io = (message: string, cause: unknown, provider?: string) =>
  new CredentialError({ ...(provider === undefined ? {} : { provider }), reason: "Io", message: `${message}: ${describe(cause)}`, cause });

/** Missing or blank file: empty store. Anything that is not a JSON object is `Corrupt`, never silently replaced. */
export function readStore(path: string): Effect.Effect<RawStore, CredentialError> {
  return Effect.tryPromise({ try: () => readFile(path, "utf8"), catch: (cause) => cause }).pipe(
    Effect.matchEffect({
      onFailure: (cause) => (errno(cause) === "ENOENT" ? Effect.succeed({}) : Effect.fail(io(`Cannot read ${path}`, cause))),
      onSuccess: (text) => {
        if (text.trim() === "") return Effect.succeed({});
        const parsed = Either.try(() => JSON.parse(text) as unknown);
        if (Either.isRight(parsed) && typeof parsed.right === "object" && parsed.right !== null && !Array.isArray(parsed.right)) {
          return Effect.succeed(parsed.right as RawStore);
        }
        return Effect.fail(
          new CredentialError({
            reason: "Corrupt",
            message: `${path} is not a JSON object of credentials; fix or remove it`,
            ...(Either.isLeft(parsed) ? { cause: parsed.left } : {}),
          }),
        );
      },
    }),
  );
}

const decodeCredential = Schema.decodeUnknownEither(Credential);

export function decodeEntry(path: string, store: RawStore, provider: string): Effect.Effect<Credential | undefined, CredentialError> {
  if (!Object.hasOwn(store, provider)) return Effect.succeed(undefined);
  const decoded = decodeCredential(store[provider]);
  return Either.isRight(decoded)
    ? Effect.succeed(decoded.right)
    : Effect.fail(
        new CredentialError({
          provider,
          reason: "Corrupt",
          message: `${path}: invalid credential for "${provider}": ${decoded.left.message}`,
          cause: decoded.left,
        }),
      );
}

/** Written whole and synced, so readers never see a partial file; mode 0600, directory 0700. */
export function writeStore(path: string, store: RawStore): Effect.Effect<void, CredentialError> {
  return Effect.tryPromise({
    try: () => writeFileAtomic(path, `${JSON.stringify(store, null, 2)}\n`, { sync: true }),
    catch: (cause) => io(`Cannot write ${path}`, cause),
  }).pipe(Effect.asVoid);
}

interface LockOwner {
  readonly pid: number;
  readonly host: string;
  readonly nonce: string;
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return errno(cause) === "EPERM";
  }
};

/**
 * Serializes read-modify-write across processes with `<path>.lock`, created
 * with O_EXCL and holding `{ pid, host, nonce }`. The holder touches it
 * periodically, so a lock is abandoned when its process is gone (same host) or
 * it has not been touched within `staleMs`. Waiting polls with jitter and fails
 * `Locked` after `waitMs`. Takeover only removes the exact lock judged stale
 * (by nonce); two waiters racing to take over one stale lock leave a narrow
 * window this cooperation convention accepts. It does not guard against
 * programs that ignore the lock.
 */
export function withFileLock<A, E>(path: string, body: Effect.Effect<A, E>, options: LockOptions = {}): Effect.Effect<A, E | CredentialError> {
  const lock = `${path}.lock`;
  const waitMs = options.waitMs ?? DEFAULT_WAIT;
  const staleMs = options.staleMs ?? DEFAULT_STALE;
  const owner: LockOwner = { pid: process.pid, host: hostname(), nonce: randomUUID() };

  const tryCreate = Effect.tryPromise({
    try: async () => {
      const handle = await open(lock, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(owner));
      } finally {
        await handle.close();
      }
    },
    catch: (cause) => cause,
  }).pipe(Effect.either);

  /**
   * The current holder's text if it is abandoned (stale, or a dead local pid),
   * `vanished` if the lock disappeared meanwhile, else undefined. A crash
   * between creating and writing the lock leaves an empty file; once stale it
   * is abandoned like any other.
   */
  const abandoned = Effect.promise(async (): Promise<{ readonly text: string } | "vanished" | undefined> => {
    try {
      const handle = await open(lock, "r");
      try {
        const [info, text] = await Promise.all([handle.stat(), handle.readFile("utf8")]);
        if (Date.now() - info.mtimeMs > staleMs) return { text };
        const holder = Either.getOrUndefined(Either.try(() => JSON.parse(text) as Partial<LockOwner>));
        if (holder?.host === owner.host && typeof holder.pid === "number" && !alive(holder.pid)) return { text };
        return undefined;
      } finally {
        await handle.close();
      }
    } catch (cause) {
      if (errno(cause) === "ENOENT") return "vanished";
      throw cause;
    }
  });

  const removeIfUnchanged = (text: string) =>
    Effect.promise(async () => {
      const current = await readFile(lock, "utf8").catch(() => undefined);
      if (current !== undefined && current === text) await rm(lock, { force: true });
    });

  const acquire = Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () => mkdir(dirname(path), { recursive: true, mode: 0o700 }),
      catch: (cause) => io(`Cannot create ${dirname(path)}`, cause),
    });
    const deadline = Date.now() + waitMs;
    while (true) {
      const created = yield* tryCreate;
      if (Either.isRight(created)) return;
      if (errno(created.left) !== "EEXIST") return yield* io(`Cannot create ${lock}`, created.left);
      const stale = yield* abandoned;
      if (stale === "vanished") continue;
      if (stale !== undefined) yield* removeIfUnchanged(stale.text);
      // Also bounds retries when an abandoned lock cannot be removed.
      if (Date.now() >= deadline) {
        return yield* new CredentialError({ reason: "Locked", message: `${lock} is held by another process; gave up after ${waitMs}ms` });
      }
      if (stale === undefined) yield* Effect.sleep(Duration.millis(20 + Math.random() * 60));
    }
  });

  const release = Effect.promise(async () => {
    const current = await readFile(lock, "utf8").catch(() => undefined);
    if (current === JSON.stringify(owner)) await rm(lock, { force: true });
  });

  const heartbeat = Effect.promise(() => {
    const now = new Date();
    return utimes(lock, now, now).catch(() => undefined);
  }).pipe(Effect.repeat(Schedule.spaced(Duration.millis(staleMs / 3))));

  return Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.acquireRelease(acquire, () => release);
      yield* Effect.forkScoped(heartbeat);
      return yield* body;
    }),
  );
}
