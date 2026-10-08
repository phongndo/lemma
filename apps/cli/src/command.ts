import { Data } from "effect";
import type { Effect, Scope } from "effect";
import type { RpcClientError } from "effect/rpc";
import type { HostError, ThinkingLevel, WhenBusy } from "@lemma/contracts";
import type { Host, HostRpcClient } from "@lemma/client";
import type { Target } from "@lemma/contracts/discovery";

/** Exit codes a calling script or agent can branch on; `--json` errors also carry a `code`. */
export const ExitCode = { ok: 0, failed: 1, usage: 2, unavailable: 3, interrupted: 130 } as const;

export class CliError extends Data.TaggedError("CliError")<{
  readonly code: string;
  readonly message: string;
  readonly subject?: string;
  readonly exit: number;
  /** The prompt a failed `run` may have placed: running it again with this id rejoins its turn. */
  readonly requestId?: string;
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
  /** Asks the person at the terminal; absent when stdin is not one. Aborting `signal` withdraws the prompt. */
  readonly ask?: (question: string, secret: boolean, signal?: AbortSignal) => Promise<string>;
  /** Opens a link in this machine's browser; absent where there is none to open (no display, or over SSH). */
  readonly open?: (url: string) => void;
  /** Aborted when the person interrupts (Ctrl+C): the command stops, running its cleanup (a login cancels). */
  readonly interrupt?: AbortSignal;
}

/** What to do with a question the host asks while a command is attached. */
export type QuestionPolicy = "ask" | "ignore" | "dismiss";

export interface Options {
  readonly json: boolean;
  readonly all: boolean;
  readonly cwd?: string | undefined;
  readonly step?: string | undefined;
  readonly filter?: string | undefined;
  readonly records: boolean;
  readonly view?: "system" | "tools" | "diff" | "rebuilt" | undefined;
  readonly sort?: string | undefined;
  readonly desc: boolean;
  readonly range?: string | undefined;
  readonly model?: string | undefined;
  readonly thinking?: ThinkingLevel | undefined;
  readonly images: readonly string[];
  readonly follow: boolean;
  readonly questions?: QuestionPolicy | undefined;
  readonly answers: readonly string[];
  readonly method?: string | undefined;
  readonly create: boolean;
  readonly base?: string | undefined;
  readonly path?: string | undefined;
  /** `workspace files`: at most this many entries. */
  readonly limit?: number | undefined;
  readonly session?: string | undefined;
  readonly force: boolean;
  readonly project: boolean;
  readonly unset: boolean;
  readonly token?: string | undefined;
  /** `run`: the submission's id, for exactly-once delivery. */
  readonly requestId?: string | undefined;
  /** `run`: what the prompt does while the session has a turn running. */
  readonly whenBusy?: WhenBusy | undefined;
}

/** The host commands go to: `LEMMA_URL`, else `<home>/remote.json`, else the local host's transport.json. */
export type { Target } from "@lemma/contracts/discovery";

export interface Connection {
  readonly target: Target;
  /** One-shot HTTP calls: never subscribes to events, so never answers questions. */
  readonly rpc: HostRpcClient;
  /**
   * `@lemma/client`'s `Host`, the reconnecting WebSocket the web app has, for
   * a command that watches the host (its events and questions, its
   * subsystems' streams) and the calls it makes meanwhile: opened once
   * connected (`openHost`), and closed with the command; a command opens one.
   * `answers` says whether the command answers the host's questions: the host
   * holds a question only for clients that do (`ConnectOptions.answers`).
   */
  readonly host: (options: { readonly answers: boolean }) => Effect.Effect<Host, Failure, Scope.Scope>;
}

/** `json` is printed with `--json`, `text` otherwise; a command that streamed its output returns undefined. */
export interface Output {
  readonly json: unknown;
  readonly text: string;
  /** Set when the command succeeded at its job but the outcome is a failure (a turn that errored). */
  readonly exit?: number;
  /** Print the JSON on one line: the last line of an NDJSON stream. */
  readonly compact?: boolean;
}

export type Failure = HostError | RpcClientError.RpcClientError | CliError;
export type Command = (connection: Connection, io: Io, options: Options) => Effect.Effect<Output | undefined, Failure, Scope.Scope>;

/** A command about which host the others go to (`remote`, `token`): it runs without connecting to that host. */
export interface Unattached {
  readonly unattached: Effect.Effect<Output, Failure, Scope.Scope>;
}
