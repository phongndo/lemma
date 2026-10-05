import { Data } from "effect";
import type { Effect, Scope } from "effect";
import type { RpcClientError } from "@effect/rpc";
import type { HostError } from "@lemma/contracts";
import type { HostRpcClient } from "@lemma/client";
import type { Target } from "@lemma/plugin-transport";

/** Exit codes a calling script or agent can branch on; `--json` errors also carry a `code`. */
export const ExitCode = { ok: 0, failed: 1, usage: 2, unavailable: 3 } as const;

export class CliError extends Data.TaggedError("CliError")<{
  readonly code: string;
  readonly message: string;
  readonly subject?: string;
  readonly exit: number;
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
  readonly err: (text: string) => void;
  /** Asks the person at the terminal; absent when stdin is not one. Aborting `signal` withdraws the prompt. */
  readonly ask?: (question: string, secret: boolean, signal?: AbortSignal) => Promise<string>;
  /** Standard input, read whole (`mcp add -`). */
  readonly input?: () => Promise<string>;
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
  readonly thinking?: string | undefined;
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
  readonly whenBusy?: "steer" | "follow-up" | "reject" | undefined;
  /** `mcp add`: the server's id, in place of the one its URL or command suggests. */
  readonly name?: string | undefined;
}

/** The host commands go to: `LEMMA_URL`, else `<home>/remote.json`, else the local host's transport.json. */
export type { Target } from "@lemma/plugin-transport";

export interface Connection {
  readonly target: Target;
  /** One-shot HTTP calls: never subscribes to events, so never answers questions. */
  readonly rpc: HostRpcClient;
  /** A WebSocket client for `Host.Events`, opened on first use and closed with the command. */
  readonly live: Effect.Effect<HostRpcClient, never, Scope.Scope>;
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
