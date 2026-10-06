import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Data, Effect, Result, Schema } from "effect";
import { writeFileAtomic } from "@lemma/contracts/fs";
import { discoveryPath, readDiscovery } from "./discovery.ts";

/*
 * Which host a client goes to (docs/remote.md), the same for the CLI and the
 * desktop app: `LEMMA_URL` with `LEMMA_TOKEN`, else `<home>/remote.json`
 * (`lemma remote set` writes it), else the local host's transport.json.
 */

/** A host a client goes to. */
export interface Target {
  /** Base URL, e.g. `http://127.0.0.1:7433` or `https://box.example.ts.net`. */
  readonly url: string;
  readonly token: string;
  readonly source: "env" | "remote" | "local";
  /** Where it was set, for messages: `LEMMA_URL`, or the file's path. */
  readonly from: string;
  /** The local host's process; a remote one is known only by its URL. */
  readonly pid?: number;
  readonly startedAt?: number;
}

/**
 * The target is set but cannot be used. Falling back to the local host would
 * act on the wrong machine, so this is an error, not a reason to.
 * `Environment`: `LEMMA_URL` is not a base URL, or `LEMMA_TOKEN` is missing;
 * `File`: remote.json cannot be read or is not `{ url, token }`.
 */
class TargetError extends Data.TaggedError("TargetError")<{
  readonly reason: "Environment" | "File";
  readonly message: string;
}> {}

const Remote = Schema.Struct({ url: Schema.String, token: Schema.String });
type Remote = typeof Remote.Type;
const decode = Schema.decodeUnknownResult(Schema.fromJsonString(Remote));

export const remotePath = (home: string): string => join(home, "remote.json");

/** A host's base URL: http(s) with nothing after the origin but `/` (no credentials, path, query, or fragment). Its origin, or undefined. */
export const normalizeUrl = (text: string): string | undefined => {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "") return undefined;
  return url.origin;
};

const unusable = (path: string, why: string) =>
  new TargetError({
    reason: "File",
    message: `Cannot use ${path}: ${why}. Write it again with \`lemma remote set\`, or remove it with \`lemma remote clear\` to use the local host.`,
  });

/** remote.json's entry, or undefined without the file. */
const readRemote = (home: string): Effect.Effect<Remote | undefined, TargetError> => {
  const path = remotePath(home);
  return Effect.tryPromise({
    try: () => readFile(path, "utf8").catch((cause: NodeJS.ErrnoException) => (cause.code === "ENOENT" ? undefined : Promise.reject(cause))),
    catch: (cause) => unusable(path, cause instanceof Error ? cause.message : String(cause)),
  }).pipe(
    Effect.flatMap((text) => {
      if (text === undefined) return Effect.succeed(undefined);
      const entry = Result.getOrUndefined(decode(text));
      const url = entry === undefined ? undefined : normalizeUrl(entry.url);
      const token = entry?.token.trim() ?? "";
      return url === undefined || token === "" ? Effect.fail(unusable(path, 'it is not {"url": "http(s)://…", "token": "…"}')) : Effect.succeed({ url, token });
    }),
  );
};

/** Writes remote.json whole, readable only by this user. */
export const writeRemote = (home: string, entry: Remote): Promise<boolean> => writeFileAtomic(remotePath(home), `${JSON.stringify(entry, null, 2)}\n`);

/** Removes remote.json; false when there was none. */
export const clearRemote = (home: string): Promise<boolean> =>
  rm(remotePath(home)).then(
    () => true,
    (cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT") return false;
      throw cause;
    },
  );

/** The host a client in `home` goes to, or undefined when none is set and no local host runs. */
export const findTarget = (env: Readonly<Record<string, string | undefined>>, home: string): Effect.Effect<Target | undefined, TargetError> =>
  Effect.gen(function* () {
    const fromEnv = env.LEMMA_URL?.trim();
    if (fromEnv) {
      const url = normalizeUrl(fromEnv);
      if (url === undefined) {
        return yield* new TargetError({
          reason: "Environment",
          message: `LEMMA_URL must be a host's base URL such as https://box.example.ts.net, not "${fromEnv}"`,
        });
      }
      const token = env.LEMMA_TOKEN?.trim();
      if (!token)
        return yield* new TargetError({ reason: "Environment", message: "LEMMA_URL needs LEMMA_TOKEN, that host's token (`lemma token` prints it there)" });
      return { url, token, source: "env", from: "LEMMA_URL" };
    }
    const remote = yield* readRemote(home);
    if (remote !== undefined) return { ...remote, source: "remote", from: remotePath(home) };
    const local = yield* readDiscovery(home);
    if (local === undefined) return undefined;
    return { url: local.url, token: local.token, source: "local", from: discoveryPath(home), pid: local.pid, startedAt: local.startedAt };
  });
