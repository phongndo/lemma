import { readFile } from "node:fs/promises";
import { Effect, Result, Schema } from "effect";
import { Credential, CredentialError } from "@lemma/credentials";
import { errorCode, holdFileLock, writeFileAtomic } from "@lemma/contracts/fs";
import type { FileLockOptions } from "@lemma/contracts/fs";
import { errorMessage } from "@lemma/contracts";

/** The raw file: provider id → entry. Entries are decoded on use so unknown ones survive a write untouched. */
export type RawStore = Readonly<Record<string, unknown>>;

/** How long `withFileLock` waits, and when it judges a lock abandoned. */
export type LockOptions = FileLockOptions;

const io = (message: string, cause: unknown, provider?: string) =>
  new CredentialError({ ...(provider === undefined ? {} : { provider }), reason: "Io", message: `${message}: ${errorMessage(cause)}`, cause });

/** Missing or blank file: empty store. Anything that is not a JSON object is `Corrupt`, never silently replaced. */
export function readStore(path: string): Effect.Effect<RawStore, CredentialError> {
  return Effect.tryPromise({ try: () => readFile(path, "utf8"), catch: (cause) => cause }).pipe(
    Effect.matchEffect({
      onFailure: (cause) => (errorCode(cause) === "ENOENT" ? Effect.succeed({}) : Effect.fail(io(`Cannot read ${path}`, cause))),
      onSuccess: (text) => {
        if (text.trim() === "") return Effect.succeed({});
        const parsed = Result.try(() => JSON.parse(text) as unknown);
        if (Result.isSuccess(parsed) && typeof parsed.success === "object" && parsed.success !== null && !Array.isArray(parsed.success)) {
          return Effect.succeed(parsed.success as RawStore);
        }
        return Effect.fail(
          new CredentialError({
            reason: "Corrupt",
            message: `${path} is not a JSON object of credentials; fix or remove it`,
            ...(Result.isFailure(parsed) ? { cause: parsed.failure } : {}),
          }),
        );
      },
    }),
  );
}

const decodeCredential = Schema.decodeUnknownResult(Credential);

export function decodeEntry(path: string, store: RawStore, provider: string): Effect.Effect<Credential | undefined, CredentialError> {
  if (!Object.hasOwn(store, provider)) return Effect.succeed(undefined);
  const decoded = decodeCredential(store[provider]);
  return Result.isSuccess(decoded)
    ? Effect.succeed(decoded.success)
    : Effect.fail(
        new CredentialError({
          provider,
          reason: "Corrupt",
          message: `${path}: invalid credential for "${provider}": ${decoded.failure.message}`,
          cause: decoded.failure,
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

/**
 * Serializes read-modify-write of the file at `path` across processes with
 * `<path>.lock` (`holdFileLock` in `@lemma/contracts/fs`): the lock is
 * abandoned when its process is gone (same host) or it has not been touched
 * within `staleMs`, and waiting fails `Locked` after `waitMs`.
 */
export function withFileLock<A, E>(path: string, body: Effect.Effect<A, E>, options: LockOptions = {}): Effect.Effect<A, E | CredentialError> {
  return Effect.scoped(
    Effect.andThen(
      holdFileLock(`${path}.lock`, options).pipe(Effect.mapError(({ reason, message, cause }) => new CredentialError({ reason, message, cause }))),
      body,
    ),
  );
}
