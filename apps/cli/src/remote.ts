import { Duration, Effect } from "effect";
import type { RpcClientError } from "@effect/rpc";
import { makeHostRpcHttp } from "@lemma/client";
import { resolvePaths } from "@lemma/plugin-host";
import { clearRemote, discoveryPath, findTarget as resolveTarget, normalizeUrl, readDiscovery, remotePath, writeRemote } from "@lemma/plugin-transport";
import type { Target } from "@lemma/plugin-transport";
import { CliError, ExitCode, usage } from "./command.ts";
import type { Io, Options, Unattached } from "./command.ts";

/*
 * `lemma remote` and `lemma token`: which host commands go to, as
 * `findTarget` in the transport plugin resolves it for the CLI and the
 * desktop app alike (docs/remote.md).
 */

const homeOf = (io: Io): string => resolvePaths({ env: io.env, cwd: io.cwd }).home;
const envUrl = (io: Io): string | undefined => io.env.LEMMA_URL?.trim() || undefined;
const SET_TIMEOUT = Duration.seconds(10);

/** The HTTP status behind a failed call, when there was a response: `filterStatusOk` turns a `401` into a failed send. */
export const statusOf = (error: RpcClientError.RpcClientError): unknown =>
  (error.cause as { readonly response?: { readonly status?: unknown } } | undefined)?.response?.status;

/** Why a call failed: the innermost cause (`getaddrinfo ENOTFOUND …`, `connect ECONNREFUSED …`), not `Failed to send HTTP request`. */
export const reasonOf = (error: Error): string => {
  let inner: unknown = error;
  while (inner instanceof Error && inner.cause instanceof Error) inner = inner.cause;
  return inner instanceof Error ? inner.message : error.message;
};

export const noLocalHost = (home: string) =>
  new CliError({ code: "NoHost", message: `No running Lemma host for ${home}. Start one with \`lemma serve\`.`, exit: ExitCode.unavailable });

const failedWrite = (path: string, cause: unknown) =>
  new CliError({ code: "WriteFailed", message: `Cannot write ${path}: ${cause instanceof Error ? cause.message : String(cause)}`, exit: ExitCode.failed });

/**
 * The host commands go to, or undefined when none is set and no local host
 * runs. A bad `LEMMA_URL` is a usage error; a remote.json that cannot be used,
 * no host (falling back would act on the wrong machine).
 */
export const findTarget = (io: Io): Effect.Effect<Target | undefined, CliError> =>
  resolveTarget(io.env, homeOf(io)).pipe(
    Effect.catchTag("TargetError", (error) =>
      Effect.fail(error.reason === "Environment" ? usage(error.message) : new CliError({ code: "NoHost", message: error.message, exit: ExitCode.unavailable })),
    ),
  );

/** `LEMMA_URL` wins over remote.json and the local host; a message about either says so. */
const envNote = (io: Io) => (envUrl(io) === undefined ? "" : ` (LEMMA_URL is set, so commands go to ${envUrl(io)} while it is)`);

/** Calls `Host.Info` at `url` with `token`: proof that the pair works, before it is saved. */
const verify = (url: string, token: string) =>
  Effect.flatMap(makeHostRpcHttp(url, token), (rpc) => rpc.Host.Info()).pipe(
    Effect.timeoutFail({
      duration: SET_TIMEOUT,
      onTimeout: () =>
        new CliError({
          code: "Unreachable",
          message: `${url} did not answer within ${Duration.toSeconds(SET_TIMEOUT)}s; nothing was written`,
          exit: ExitCode.unavailable,
        }),
    }),
    Effect.catchTag("RpcClientError", (error) =>
      Effect.fail(
        statusOf(error) === 401
          ? new CliError({
              code: "Unauthorized",
              message: `The host at ${url} rejected the token; nothing was written. \`lemma token\` on that machine prints the right one.`,
              exit: ExitCode.unavailable,
            })
          : new CliError({
              code: "Unreachable",
              message: `Cannot reach a Lemma host at ${url}: ${reasonOf(error)}; nothing was written`,
              exit: ExitCode.unavailable,
            }),
      ),
    ),
  );

const show = (io: Io): Unattached => ({
  unattached: Effect.gen(function* () {
    const target = yield* findTarget(io);
    if (target === undefined) {
      const home = homeOf(io);
      return {
        json: { source: "local", from: discoveryPath(home), tokenSet: false },
        text: `No remote host is set and no local host runs for ${home}: start one with \`lemma serve\`, or use one elsewhere with \`lemma remote set\`.`,
      };
    }
    const where = target.source === "local" ? `the local host, pid ${target.pid}` : `from ${target.from}`;
    // Never the token: this output is for reading, and pasting.
    return { json: { source: target.source, url: target.url, from: target.from, tokenSet: true }, text: `${target.url} (${where})` };
  }),
});

const set = (input: string, io: Io, options: Options): Unattached | CliError => {
  const url = normalizeUrl(input);
  if (url === undefined) return usage(`"${input}" is not a host's base URL: use http(s)://<host>[:<port>], with no path or query`);
  return {
    unattached: Effect.gen(function* () {
      const given = options.token?.trim() || io.env.LEMMA_TOKEN?.trim();
      const ask = io.ask;
      const token = given || (ask === undefined ? "" : (yield* Effect.promise(() => ask(`Token for ${url} (\`lemma token\` there prints it): `, true))).trim());
      if (token === "") return yield* usage("remote set needs the host's token: --token <token>, or LEMMA_TOKEN");
      const info = yield* verify(url, token);
      const home = homeOf(io);
      const path = remotePath(home);
      yield* Effect.tryPromise({ try: () => writeRemote(home, { url, token }), catch: (cause) => failedWrite(path, cause) });
      return {
        json: { url, from: path, info },
        text: `Commands now go to ${url} (its home is ${info.home}); saved in ${path}${envNote(io)}`,
      };
    }),
  };
};

const clear = (io: Io): Unattached => ({
  unattached: Effect.gen(function* () {
    const home = homeOf(io);
    const path = remotePath(home);
    const removed = yield* Effect.tryPromise({ try: () => clearRemote(home), catch: (cause) => failedWrite(path, cause) });
    return {
      json: { removed, from: path },
      text: `${removed ? `Removed ${path}` : `No ${path} to remove`}; commands go to the local host${envNote(io)}`,
    };
  }),
});

/** `lemma remote [set <url> | clear]`. */
export const remoteCommand = (sub: string | undefined, arg: string | undefined, rest: readonly string[], io: Io, options: Options): Unattached | CliError => {
  const unexpected = (value: string | undefined) => (value === undefined ? undefined : usage(`Unexpected argument "${value}"`));
  switch (sub) {
    case undefined:
      return show(io);
    case "set":
      if (arg === undefined) return usage("remote set needs the host's URL, such as https://box.example.ts.net");
      return unexpected(rest[0]) ?? set(arg, io, options);
    case "clear":
      return unexpected(arg) ?? clear(io);
    default:
      return usage(`Unknown remote command "${sub}"`);
  }
};

/** `lemma token`: the local host's token, to give a client on another machine. */
export const tokenCommand = (io: Io): Unattached => ({
  unattached: Effect.gen(function* () {
    const home = homeOf(io);
    const local = yield* readDiscovery(home);
    if (local === undefined) return yield* noLocalHost(home);
    return { json: { url: local.url, token: local.token }, text: local.token };
  }),
});
