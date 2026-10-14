import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Data, Effect, Result, Schema } from "effect";
import { isAlive, readJsonFile, writeFileAtomic } from "./fs.ts";

/*
 * Node only: `@lemma/contracts/discovery`. How a client finds a host. A
 * transport writes `<home>/transport.json` (any replacement must write the
 * same file); the host, the CLI, and the desktop app read it.
 */

/** `<home>/transport.json`: how local clients find a running host. */
export const Discovery = Schema.Struct({
  /** Base URL, e.g. `http://127.0.0.1:7433`; the WebSocket endpoint is `<url>/rpc` with `ws:`. */
  url: Schema.String,
  token: Schema.String,
  pid: Schema.Number,
  /** Epoch milliseconds. */
  startedAt: Schema.Number,
});
export type Discovery = typeof Discovery.Type;

export const discoveryPath = (home: string): string => join(home, "transport.json");

/** The running host's entry, or undefined when absent, unreadable, or left behind by a process that is gone. */
export const readDiscovery = (home: string): Effect.Effect<Discovery | undefined> =>
  Effect.promise(() => readJsonFile(discoveryPath(home), Discovery)).pipe(
    Effect.map((entry) => (entry !== undefined && isAlive(entry.pid) ? entry : undefined)),
  );

/*
 * Which host a client goes to (docs/remote.md), the same for the CLI and the
 * desktop app: an environment the command names (`--env`), else `LEMMA_URL`
 * with `LEMMA_TOKEN`, else the environment `LEMMA_ENV` names, else the default
 * of `<home>/environments.json` (`lemma env use` sets it), else the local host
 * its transport.json names. A saved environment never takes the local host's
 * place unless it is made the default. A remote.json an older CLI wrote
 * stands for environments.json until that exists (`readEnvironments`).
 */

/** The name of the host on this machine, which is never saved: the one whose transport.json is in the home. */
export const LOCAL = "local";

/** A host a client goes to. */
export interface Target {
  /** Base URL, e.g. `http://127.0.0.1:7433` or `https://box.example.ts.net`. */
  readonly url: string;
  readonly token: string;
  /** `env` from `LEMMA_URL`; `saved` an environment in environments.json; `local` this machine's host. */
  readonly source: "env" | "saved" | "local";
  /** The environment's name: `local`, a saved one's, or `LEMMA_URL`. */
  readonly name: string;
  /** Where it was set, for messages: `LEMMA_URL`, `--env`, `LEMMA_ENV`, environments.json, or transport.json. */
  readonly from: string;
  /** The local host's process; a remote one is known only by its URL. */
  readonly pid?: number;
  readonly startedAt?: number;
}

/**
 * The target is set but cannot be used. Falling back to the local host would
 * act on the wrong machine, so this is an error, not a reason to.
 * `Environment`: `LEMMA_URL` is not a base URL, or `LEMMA_TOKEN` is missing;
 * `File`: environments.json cannot be read or is malformed;
 * `Unknown`: no saved environment has the name asked for.
 */
export class TargetError extends Data.TaggedError("TargetError")<{
  readonly reason: "Environment" | "File" | "Unknown";
  readonly message: string;
}> {}

/** A saved host: its base URL and token. */
export const SavedEnvironment = Schema.Struct({ url: Schema.String, token: Schema.String });
export type SavedEnvironment = typeof SavedEnvironment.Type;

/** `<home>/environments.json`: the hosts this client knows by name, and which one commands go to by default. */
export const Environments = Schema.Struct({
  /** A saved environment's name; absent (or `local`) is the local host. */
  default: Schema.optional(Schema.String),
  environments: Schema.Record(Schema.String, SavedEnvironment),
});
export type Environments = typeof Environments.Type;

const decode = Schema.decodeUnknownResult(Schema.fromJsonString(Environments));

export const environmentsPath = (home: string): string => join(home, "environments.json");

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

/** A saved environment's name: a lowercase word (`box`, `work-laptop`), never `local`. */
export const environmentNameProblem = (name: string): string | undefined =>
  name === LOCAL
    ? '"local" is this machine\'s host, which is never saved'
    : /^[a-z0-9][a-z0-9_-]*$/.test(name)
      ? undefined
      : `"${name}" is no name: use lowercase letters, digits, - and _`;

const unusable = (path: string, why: string) =>
  new TargetError({
    reason: "File",
    message: `Cannot use ${path}: ${why}. Fix it, or remove it to use the local host.`,
  });

const readText = (path: string) =>
  Effect.tryPromise({
    try: () => readFile(path, "utf8").catch((cause: NodeJS.ErrnoException) => (cause.code === "ENOENT" ? undefined : Promise.reject(cause))),
    catch: (cause) => unusable(path, cause instanceof Error ? cause.message : String(cause)),
  });

/** The name `<home>/remote.json`'s host (from `lemma remote set`, before environments) is saved under. */
export const LEGACY_REMOTE = "remote";

const decodeLegacy = Schema.decodeUnknownResult(Schema.fromJsonString(SavedEnvironment));

/**
 * environments.json as it is, or empty without the file. Without one, a
 * `<home>/remote.json` that an older `lemma remote set` wrote is read as an
 * environment named `remote` and made the default, so a client set up for a
 * remote host goes on using it rather than this machine's; the first change
 * (`lemma env …`) writes it into environments.json, after which remote.json
 * is not read.
 */
export const readEnvironments = (home: string): Effect.Effect<Environments, TargetError> => {
  const path = environmentsPath(home);
  return readText(path).pipe(
    Effect.flatMap((text) => {
      if (text === undefined) return readLegacy(home);
      const file = Result.getOrUndefined(decode(text));
      if (file === undefined) return Effect.fail(unusable(path, 'it is not {"default"?: "<name>", "environments": {"<name>": {"url", "token"}}}'));
      for (const [name, saved] of Object.entries(file.environments))
        if (normalizeUrl(saved.url) === undefined || saved.token.trim() === "")
          return Effect.fail(unusable(path, `its "${name}" needs a base URL and a token`));
      return Effect.succeed(file);
    }),
  );
};

const readLegacy = (home: string): Effect.Effect<Environments, TargetError> => {
  const path = join(home, "remote.json");
  return Effect.flatMap(readText(path), (text) => {
    if (text === undefined) return Effect.succeed({ environments: {} });
    const saved = Result.getOrUndefined(decodeLegacy(text));
    if (saved === undefined || normalizeUrl(saved.url) === undefined || saved.token.trim() === "")
      return Effect.fail(
        new TargetError({
          reason: "File",
          message: `Cannot use ${path}: it is not {"url", "token"}. Save the host with \`lemma env add\`, or remove it to use the local host.`,
        }),
      );
    return Effect.succeed({ default: LEGACY_REMOTE, environments: { [LEGACY_REMOTE]: saved } });
  });
};

/** Writes environments.json whole, readable only by this user. */
export const writeEnvironments = (home: string, file: Environments): Promise<boolean> =>
  writeFileAtomic(environmentsPath(home), `${JSON.stringify(file, null, 2)}\n`);

/** The local host, or undefined when none runs for `home`. */
export const localTarget = (home: string): Effect.Effect<Target | undefined> =>
  Effect.map(readDiscovery(home), (local) =>
    local === undefined
      ? undefined
      : { url: local.url, token: local.token, source: "local", name: LOCAL, from: discoveryPath(home), pid: local.pid, startedAt: local.startedAt },
  );

/**
 * The host a client in `home` goes to, or undefined when it is the local one
 * and none runs. `name` is the environment a command named (`--env`), which
 * wins over everything; `local` names the local host whatever else is set.
 */
export const findTarget = (env: Readonly<Record<string, string | undefined>>, home: string, name?: string): Effect.Effect<Target | undefined, TargetError> =>
  Effect.gen(function* () {
    const fromEnv = env.LEMMA_URL?.trim();
    if (name === undefined && fromEnv) {
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
      return { url, token, source: "env", name: "LEMMA_URL", from: "LEMMA_URL" };
    }
    const file = yield* readEnvironments(home);
    const envName = env.LEMMA_ENV?.trim() || undefined;
    const chosen = name ?? envName ?? file.default;
    const from = name !== undefined ? "--env" : envName !== undefined ? "LEMMA_ENV" : environmentsPath(home);
    if (chosen === undefined || chosen === LOCAL) return yield* localTarget(home);
    const saved = file.environments[chosen];
    if (saved === undefined)
      return yield* new TargetError({
        reason: "Unknown",
        message: `No environment "${chosen}" (from ${from}); \`lemma env\` lists them`,
      });
    return { url: normalizeUrl(saved.url)!, token: saved.token.trim(), source: "saved", name: chosen, from };
  });
