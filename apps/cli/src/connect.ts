import { Effect } from "effect";
import type { Scope } from "effect";
import type { RpcClientError } from "effect/rpc";
import { makeHostRpcHttp, tooLarge } from "@lemma/client";
import { HOST_PROTOCOL, HostError } from "@lemma/contracts";
import { findTarget as resolveTarget } from "@lemma/contracts/discovery";
import type { Target } from "@lemma/contracts/discovery";
import { resolvePaths } from "@lemma/host/paths";
import { openHost } from "./channels.ts";
import { CliError, ExitCode, usage } from "./command.ts";
import type { Connection, Failure, Globals, Io } from "./command.ts";

/*
 * Which host a command goes to, as `findTarget` in `@lemma/contracts/discovery`
 * resolves it for the CLI and the desktop app alike (docs/remote.md), and
 * what a failure to reach it says.
 */

export const homeOf = (io: Pick<Io, "env" | "cwd">): string => resolvePaths({ env: io.env, cwd: io.cwd }).home;

/** The HTTP status behind a failed call, when there was a response: `filterStatusOk` turns a `401` into a failed send. */
export const statusOf = (error: RpcClientError.RpcClientError): unknown =>
  error.reason._tag === "HttpError" ? (error.reason.cause as { readonly response?: { readonly status?: unknown } } | undefined)?.response?.status : undefined;

/**
 * Why a call failed: the innermost cause (`getaddrinfo ENOTFOUND …`, `connect ECONNREFUSED …`), not `HttpError` or
 * `Transport error`. An `RpcClientError` holds it in its `reason`, and that in its `cause`.
 */
export const reasonOf = (error: Error): string => {
  let inner: unknown = error;
  for (;;) {
    const next: unknown =
      (inner as { readonly reason?: unknown }).reason instanceof Error ? (inner as { readonly reason: Error }).reason : (inner as Error).cause;
    if (!(next instanceof Error)) break;
    inner = next;
  }
  return inner instanceof Error && inner.message !== "" ? inner.message : error.message;
};

/** Codes a command line, not the host, is to blame for. */
const USAGE_CODES = new Set(["Usage", "UnknownCommand", "InvalidPayload"]);

/**
 * What a command's failure says and exits with. A remote target that cannot
 * be reached is the remote's "no host"; a local one that was found but did
 * not answer is unreachable.
 */
export const toCliError = (error: Failure, target?: Target): CliError => {
  if (error instanceof CliError) return error;
  if (error instanceof HostError) {
    return new CliError({
      code: error.code,
      message: error.message,
      ...(error.subject === undefined ? {} : { subject: error.subject }),
      // Naming nothing, it is the host still starting (`Channel.List`, `Host.Inspectors`); see `starting`.
      exit: USAGE_CODES.has(error.code) ? ExitCode.usage : error.code === "Unavailable" && error.subject === undefined ? ExitCode.unavailable : ExitCode.failed,
    });
  }
  if (tooLarge(error)) {
    return new CliError({
      code: "TooLarge",
      message: "The host refused a message larger than its limit of 100 MiB (an attached image, say), closing the connection",
      exit: ExitCode.failed,
    });
  }
  const remote = target !== undefined && target.source !== "local" ? target : undefined;
  // `filterStatusOk` turns a rejected token into a failed send; the response status says which it was.
  if (statusOf(error) === 401) {
    const message =
      remote === undefined
        ? "The host rejected the token in transport.json"
        : `The host at ${remote.url} rejected the token from ${remote.from}. \`lemma token\` there prints the current one; ${remote.source === "env" ? "set LEMMA_TOKEN to it" : `save it with \`lemma env add ${remote.name} ${remote.url} --token <token>\``}.`;
    return new CliError({ code: "Unauthorized", message, exit: ExitCode.unavailable });
  }
  if (remote !== undefined) {
    return new CliError({
      code: "NoHost",
      message: `No Lemma host answers at ${remote.url} (${remote.name}, from ${remote.from}): ${reasonOf(error)}. Check that the host runs on that machine and that this one can reach it, or ${remote.source === "env" ? "unset LEMMA_URL" : "use another with --env, or `lemma env use local`"}.`,
      exit: ExitCode.unavailable,
    });
  }
  return new CliError({ code: "Unreachable", message: `Cannot reach the host: ${reasonOf(error)}`, exit: ExitCode.unavailable });
};

export const noLocalHost = (home: string) =>
  new CliError({
    code: "NoHost",
    message: `No running Lemma host for ${home}. Start one with \`lemma serve\` (or the desktop app), or use another with --env.`,
    exit: ExitCode.unavailable,
  });

/**
 * The host commands go to, or undefined when it is the local one and none
 * runs. A bad `LEMMA_URL` is a usage error; an environments.json that cannot
 * be used, or an environment it does not have, no host (falling back would act
 * on the wrong machine).
 */
export const findTarget = (io: Pick<Io, "env" | "cwd">, name?: string): Effect.Effect<Target | undefined, CliError> =>
  resolveTarget(io.env, homeOf(io), name).pipe(
    Effect.catchTag("TargetError", (error) =>
      Effect.fail(
        error.reason === "Environment"
          ? usage(error.message)
          : new CliError({ code: error.reason === "Unknown" ? "UnknownEnvironment" : "NoHost", message: error.message, exit: ExitCode.unavailable }),
      ),
    ),
  );

/**
 * Whether the host speaks another RPC protocol (`HOST_PROTOCOL`): a host from another version of Lemma fails every
 * call in ways that name nothing useful (one from before Effect 4 rejects even the request ids), and its health check
 * says why. Undefined when it speaks this one, or cannot say.
 */
export const otherProtocol = (target: Target): Effect.Effect<CliError | undefined> =>
  Effect.promise(async () => {
    try {
      const response = await fetch(new URL("/api/health", target.url), {
        headers: { authorization: `Bearer ${target.token}` },
        signal: AbortSignal.timeout(2_000),
      });
      if (!response.ok) return undefined;
      const protocol = ((await response.json()) as { readonly protocol?: unknown }).protocol ?? 1;
      if (protocol === HOST_PROTOCOL) return undefined;
      const where = target.source === "local" ? "The local host" : `The host at ${target.url}`;
      return new CliError({
        code: "OtherVersion",
        message: `${where} runs another version of Lemma: it speaks RPC protocol ${String(protocol)}, this command ${HOST_PROTOCOL}. Restart it from this version: ${
          target.source === "local"
            ? "`lemma restart` (or reopen the desktop app)"
            : "there, `lemma update` to the release this one is (`lemma version` says which), then `lemma restart`"
        }.`,
        exit: ExitCode.unavailable,
      });
    } catch {
      return undefined;
    }
  });

/**
 * The host commands go to (see `findTarget`): one-shot HTTP calls for most
 * commands, and `@lemma/client`'s reconnecting `Host` (opened only by a
 * command that watches the host) for its events, questions, and streams, as
 * the web app has it.
 */
export const connect = (io: Io, globals: Pick<Globals, "env">): Effect.Effect<Connection, Failure, Scope.Scope> =>
  Effect.gen(function* () {
    const target = yield* findTarget(io, globals.env);
    if (target === undefined) return yield* noLocalHost(homeOf(io));
    return yield* connectTo(target);
  });

/** A connection to a target already found. */
export const connectTo = (target: Target): Effect.Effect<Connection, never, Scope.Scope> =>
  Effect.map(makeHostRpcHttp(target.url, target.token), (rpc) => ({
    target,
    rpc,
    host: (options) => openHost({ url: target.url, token: target.token, client: "cli", ...options }, rpc),
  }));
