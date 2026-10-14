import { Data } from "effect";
import type { Effect, Scope } from "effect";
import type { RpcClientError } from "effect/rpc";
import type { HostError, RuntimeEvent } from "@lemma/contracts";
import type { ArgSpec, ArgsOf, CommandSpec, FlagSpec, FlagsOf } from "@lemma/cli";
import type { Host, HostRpcClient } from "@lemma/client";
import type { Target } from "@lemma/contracts/discovery";

/** Exit codes a calling script or agent can branch on; `--json` errors also carry a `code`. */
export const ExitCode = { ok: 0, failed: 1, usage: 2, unavailable: 3, interrupted: 130 } as const;

export class CliError extends Data.TaggedError("CliError")<{
  readonly code: string;
  readonly message: string;
  readonly subject?: string;
  readonly exit: number;
  /** Arguments that make running the command again safe (a run's `--request-id`), when it may have taken effect. */
  readonly rerun?: readonly string[];
}> {}

export const usage = (message: string) => new CliError({ code: "Usage", message: `${message}\nRun \`lemma --help\` for usage.`, exit: ExitCode.usage });

export interface Io {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Directory the user invoked the command from. */
  readonly cwd: string;
  /** One line of output. */
  readonly out: (text: string) => void;
  /** Output without a line break, for streamed text. */
  readonly write?: (text: string) => void;
  /**
   * Resolves once what was written has room to go (stdout's `drain`), or is
   * undefined when it has room now. A command printing a channel's stream
   * waits on it after each write, so what it prints goes out at its reader's
   * pace (an unread pipe, a paused `less`), and what the host sends meanwhile
   * waits in the command's own queue, never holding back the connection. It
   * resolves too when stdout closes or fails, or `signal` aborts.
   */
  readonly drained?: (signal: AbortSignal) => Promise<void> | undefined;
  readonly err: (text: string) => void;
  /** stderr without a line break. */
  readonly errWrite?: (text: string) => void;
  /** Asks the person at the terminal; absent when stdin is not one. Aborting `signal` withdraws the prompt. */
  readonly ask?: (question: string, secret: boolean, signal?: AbortSignal) => Promise<string>;
  /** Opens a link in this machine's browser; absent where there is none to open (no display, or over SSH). */
  readonly open?: (url: string) => void;
  /** Aborted when the person interrupts (Ctrl+C): the command stops, running its cleanup (a login cancels). */
  readonly interrupt?: AbortSignal;
  /** The terminal's width, when stdout is one. */
  readonly columns?: number;
  /** Runs the host in this process (`lemma serve` in the foreground); absent in tests. Resolves when it stops. */
  readonly serve?: (argv: readonly string[]) => Promise<void>;
  /** The command that runs this CLI again, `[node, ...flags, main.ts]`: what `serve --detach` and `service install` start. */
  readonly self?: readonly string[];
}

/** What to do with a question the host asks while a command is attached. */
export type QuestionPolicy = "ask" | "ignore" | "dismiss";

/** The flags every command takes (`GLOBAL_FLAGS` in `@lemma/cli`), read before the command's own. */
export interface Globals {
  readonly json: boolean;
  readonly quiet: boolean;
  readonly env?: string | undefined;
  readonly fields?: readonly string[] | undefined;
  readonly questions?: QuestionPolicy | undefined;
  readonly answers: readonly string[];
  readonly help: boolean;
}

/** The host commands go to: `--env`, `LEMMA_URL`, `LEMMA_ENV`, the default environment, else the local host. */
export type { Target } from "@lemma/contracts/discovery";

export interface Connection {
  readonly target: Target;
  /** One-shot HTTP calls: never subscribes to events, so never answers questions. */
  readonly rpc: HostRpcClient;
  /**
   * `@lemma/client`'s `Host`, the reconnecting WebSocket the web app has, for
   * a command that watches the host (its events and questions, its
   * domains' streams) and the calls it makes meanwhile: opened once
   * connected (`openHost`), and closed with the command; a command opens one.
   * `answers` says whether the command answers the host's questions: the host
   * holds a question only for clients that do (`ConnectOptions.answers`).
   * `onEvent` hears the host's own events from the first subscription on
   * (`ConnectOptions.onEvent`), for a command that hears them (`hearing`).
   */
  readonly host: (options: { readonly answers: boolean; readonly onEvent?: (event: RuntimeEvent) => void }) => Effect.Effect<Host, Failure, Scope.Scope>;
}

/** `json` is printed with `--json`, `text` otherwise; a command that streamed its output returns undefined. */
export interface Output {
  readonly json: unknown;
  readonly text: string;
  /** Set when the command succeeded at its job but the outcome is a failure (a turn that errored). */
  readonly exit?: number;
  /** Print the JSON on one line: the last line of an NDJSON stream. */
  readonly compact?: boolean;
  /** What `--quiet` prints, one per line. */
  readonly ids?: readonly string[];
}

export type Failure = HostError | RpcClientError.RpcClientError | CliError;

/** What a command of the `lemma` command's own runs with. */
export interface Invocation {
  readonly args: Readonly<Record<string, unknown>>;
  readonly flags: Readonly<Record<string, unknown>>;
  readonly io: Io;
  readonly globals: Globals;
  /** The host commands go to, connected on first use and closed with the command: a command that needs none never asks. */
  readonly connect: Effect.Effect<Connection, Failure, Scope.Scope>;
  /** Runs the `lemma` command again in this process with other words: `plugins check` reads a host's answers as JSON. */
  readonly rerun: (argv: readonly string[], io: Io) => Promise<number>;
}

/**
 * A command of the `lemma` command itself: one that needs no host plugin,
 * either because it runs without a host (`serve`, `env`, `config`) or reads
 * what the runtime serves (`status`, `plugins`). Plugins' commands come from
 * the host (`CliCommands`); these come first, so no plugin shadows one.
 */
export interface Builtin extends CommandSpec {
  /** Where `lemma help` lists it. */
  readonly group: string;
  readonly run: (invocation: Invocation) => Effect.Effect<Output | undefined, Failure, Scope.Scope>;
}

/** A builtin typed by its spec, as `defineCliCommand` types a plugin's: `args` and `flags` arrive as it declares them. */
export const defineBuiltin = <const Args extends readonly ArgSpec[] = readonly [], const Flags extends Readonly<Record<string, FlagSpec>> = {}>(
  command: Omit<CommandSpec, "args" | "flags"> & {
    readonly group: string;
    readonly args?: Args;
    readonly flags?: Flags;
    readonly run: (
      invocation: Omit<Invocation, "args" | "flags"> & { readonly args: ArgsOf<Args>; readonly flags: FlagsOf<Flags> },
    ) => Effect.Effect<Output | undefined, Failure, Scope.Scope>;
  },
): Builtin => command as unknown as Builtin;
