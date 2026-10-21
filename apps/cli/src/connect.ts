import { Effect } from "effect";
import type { Scope } from "effect";
import type { RpcClientError } from "effect/rpc";
import { callChannel, makeHostRpcHttp, tooLarge } from "@lemma/client";
import { HOST_PROTOCOL, HostError } from "@lemma/contracts";
import { findTarget as resolveTarget } from "@lemma/contracts/discovery";
import type { Target } from "@lemma/contracts/discovery";
import { profileOf } from "@lemma/contracts/profiles";
import { isLoopback, ProfileChannels, profileAddress } from "@lemma/profiles";
import { resolvePaths } from "@lemma/host/paths";
import { openHost } from "./channels.ts";
import { CliError, ExitCode, usage } from "./command.ts";
import type { Connection, Failure, Globals, Io } from "./command.ts";

/*
 * Which host a command goes to, as `findTarget` in `@lemma/contracts/discovery`
 * resolves it for the CLI and the desktop app alike (docs/remote.md), and
 * what a failure to reach it says.
 */

/** The home of the profile a command goes to (`--profile`, `LEMMA_PROFILE`): the root's own unless one is named. */
export const homeOf = (io: Pick<Io, "env" | "cwd">): string => resolvePaths({ env: io.env, cwd: io.cwd }).home;

/** `~/.lemma` (or `$LEMMA_HOME`), whatever the profile: where this client's environments and every profile are. */
export const rootOf = (io: Pick<Io, "env" | "cwd">): string => resolvePaths({ env: io.env, cwd: io.cwd }).root;

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

export const noLocalHost = (home: string, profile?: string) =>
  new CliError({
    code: "NoHost",
    message:
      profile === undefined
        ? `No running Lemma host for ${home}. Start one with \`lemma serve\` (or the desktop app), or use another with --env.`
        : `No running Lemma host for the profile "${profile}" (${home}). Start one with \`lemma --profile ${profile} serve\` (or open it in the desktop app).`,
    exit: ExitCode.unavailable,
  });

/**
 * The host commands go to, or undefined when it is the local one and none
 * runs. A bad `LEMMA_URL` is a usage error; an environments.json that cannot
 * be used, or an environment it does not have, no host (falling back would act
 * on the wrong machine). The local host is the one of the profile `io.env`
 * names (`LEMMA_PROFILE`, which `--profile` sets). On another machine,
 * `profile` (`--profile`, named for this command, not inherited) is opened by
 * the host there (`profiles.open`, which starts it), and the command goes to
 * it at that machine's name and the profile's port; without it, to whichever
 * profile that host is.
 */
export const findTarget = (io: Pick<Io, "env" | "cwd">, name?: string, profile?: string): Effect.Effect<Target | undefined, CliError> =>
  resolveTarget(io.env, rootOf(io), name, homeOf(io)).pipe(
    Effect.catchTag("TargetError", (error) =>
      Effect.fail(
        error.reason === "Environment"
          ? usage(error.message)
          : new CliError({ code: error.reason === "Unknown" ? "UnknownEnvironment" : "NoHost", message: error.message, exit: ExitCode.unavailable }),
      ),
    ),
    Effect.flatMap((target) =>
      target === undefined || target.source === "local" || profile === undefined ? Effect.succeed(target) : remoteProfile(target, profile),
    ),
  );

/**
 * The profile `profile` of the machine `target` is on, as its host opens it (starting it when none runs there). Not
 * through a loopback address, which may be a tunnel to that machine (`ssh -L`): it carries one port, and another
 * profile's port on loopback is this machine's, which would be handed the profile's token.
 */
const remoteProfile = (target: Target, profile: string): Effect.Effect<Target, CliError> =>
  isLoopback(target.url)
    ? Effect.fail(
        new CliError({
          code: "Unreachable",
          message: `${target.name} (${target.url}) is a loopback address, which may be a tunnel to another machine: reach the profile "${profile}" at its own address instead (lemma env add, or LEMMA_URL)`,
          exit: ExitCode.unavailable,
        }),
      )
    : Effect.scoped(Effect.flatMap(makeHostRpcHttp(target.url, target.token), (rpc) => callChannel(rpc, ProfileChannels.open, { name: profile }))).pipe(
        Effect.map((opened) => ({
          url: profileAddress(target.url, opened),
          token: opened.token,
          source: target.source,
          name: `${target.name}/${profile}`,
          from: target.from,
        })),
        Effect.mapError((error) => {
          const reason = error instanceof HostError ? error.message : reasonOf(error);
          return new CliError({
            code: error instanceof HostError ? error.code : "NoHost",
            message: `The host at ${target.url} (${target.name}) cannot open the profile "${profile}": ${reason}`,
            exit: ExitCode.unavailable,
          });
        }),
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
export const connect = (io: Io, globals: Pick<Globals, "env" | "profile">): Effect.Effect<Connection, Failure, Scope.Scope> =>
  Effect.gen(function* () {
    const target = yield* findTarget(io, globals.env, globals.profile);
    if (target === undefined) return yield* noLocalHost(homeOf(io), profileOf(io.env));
    return yield* connectTo(target);
  });

/** A connection to a target already found. */
export const connectTo = (target: Target): Effect.Effect<Connection, never, Scope.Scope> =>
  Effect.map(makeHostRpcHttp(target.url, target.token), (rpc) => ({
    target,
    rpc,
    host: (options) => openHost({ url: target.url, token: target.token, client: "cli", ...options }, rpc),
  }));
