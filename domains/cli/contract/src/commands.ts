import { Context, Data, Schema } from "effect";
import type { Effect, Stream } from "effect";
import { Registry } from "@lemma/core";
import type { Awaitable } from "@lemma/core";
import { defineChannel, HostError, optionalPayload, serveChannel } from "@lemma/contracts";
import type { Channel } from "@lemma/contracts";
import { CliFile, CliInput, CommandSpec, specProblem } from "./spec.ts";
import type { ArgSpec, FlagSpec } from "./spec.ts";

// ------------------------------------------------------------------ what a command runs with

/**
 * What a command prints while it runs, before its result: the client shows
 * it as it comes. A command that only answers returns a `CliResult` instead.
 */
export interface CliOutput {
  /** Text as it is, with no line break added: a stream of an answer. `err` writes it to stderr, as notes about the work are. */
  readonly text: (text: string, options?: { readonly err?: boolean }) => void;
  /** One line. */
  readonly line: (text: string, options?: { readonly err?: boolean }) => void;
  /** One JSON value, printed on a line of its own: what a command streams when the client asked for JSON. */
  readonly json: (value: unknown) => void;
  /**
   * A page for the person: a `url` anywhere (a sign-in), or a `path` of the
   * web app (`/threads/<id>`), which the client opens at the host it reaches
   * it by. The client opens it where it can (a display, not over SSH),
   * after asking `prompt` when it has one and a terminal to ask at, and
   * otherwise prints it.
   */
  readonly open: (target: { readonly url: string } | { readonly path: string }, prompt?: string) => void;
  /**
   * The client answers questions carrying `origin` too, besides those its
   * own invocation asks (`CliContext.origin`): a run's tools ask as their
   * session (`session:<id>`), a login as its provider.
   */
  readonly answer: (origin: string) => void;
  /**
   * The command line, after `lemma`, that runs the command again safely, said
   * once known: a run's, naming its session and `--request-id`, which rejoins
   * its turn instead of placing its prompt twice. A client that loses the
   * command says to run that line.
   */
  readonly rerun: (args: readonly string[]) => void;
}

/** A command's input, by the names its spec gives, typed by `defineCliCommand`. */
export interface CliContext<Args = Readonly<Record<string, unknown>>, Flags = Readonly<Record<string, unknown>>> {
  readonly args: Args;
  readonly flags: Flags;
  /** The client's working directory: a path on the client's machine, which is the host's only when they are one machine. */
  readonly cwd: string;
  /** The client prints JSON: return `json`, and stream with `out.json`, rather than text. */
  readonly json: boolean;
  /** The client terminal's width, when it has one. */
  readonly columns: number | undefined;
  /** What the questions this command asks carry (`InteractionOrigin` is set to it): the client answers those. */
  readonly origin: string;
  readonly out: CliOutput;
}

/**
 * How a command ended. `json` is printed with `--json`, `text` otherwise
 * (either may be absent: nothing is printed); `ids` are what `--quiet`
 * prints, one per line; `failed` exits 1 though the command did its job (a
 * turn that errored).
 */
export interface CliResult {
  readonly json?: unknown;
  readonly text?: string;
  readonly ids?: readonly string[];
  readonly failed?: boolean;
}

/**
 * A command's refusal, as the client reports it: `reason` is the error's code
 * (`Usage` exits 2, as a bad command line does; anything else exits 1), and
 * `subject` what it concerns (a session, a path).
 */
export class CliCommandError extends Data.TaggedError("CliCommandError")<{
  readonly reason: string;
  readonly message: string;
  readonly subject?: string;
}> {}

/** A usage error from a command's own checks: what its flags or arguments cannot mean together. */
export const usageError = (message: string) => new CliCommandError({ reason: "Usage", message });

// ------------------------------------------------------------------ commands

type One<F extends FlagSpec> = F["type"] extends "number" ? number : F["type"] extends "file" ? CliFile : F["values"] extends readonly (infer V)[] ? V : string;
type FlagValue<F extends FlagSpec> = F["type"] extends "boolean" ? boolean : F["multiple"] extends true ? readonly One<F>[] : One<F> | undefined;
type ArgValue<A extends ArgSpec> = A["variadic"] extends true ? readonly string[] : A["required"] extends true ? string : string | undefined;

/** The arguments `Args` declares, by name. */
export type ArgsOf<Args extends readonly ArgSpec[]> = { readonly [A in Args[number] as A["name"]]: ArgValue<A> };
/** The flags `Flags` declares, by name: a boolean false unless given, a repeatable one an array, any other absent unless given. */
export type FlagsOf<Flags extends Readonly<Record<string, FlagSpec>>> = { readonly [K in keyof Flags]: FlagValue<Flags[K]> };

/**
 * A command of the `lemma` command, served by a host plugin: its spec, which
 * the client parses its words with and prints its help from, and what it
 * runs on the host. It returns its result, a promise of it, or an Effect
 * (`Awaitable`), and prints along the way through `out`. It asks the person
 * for more with `Interaction`, as any plugin does: the client that ran it
 * answers.
 */
export interface CliCommand extends CommandSpec {
  readonly run: (context: CliContext<any, any>) => Awaitable<CliResult | void, unknown>;
}

/** A command typed by its spec: `args` and `flags` arrive as it declares them. */
export const defineCliCommand = <const Args extends readonly ArgSpec[] = readonly [], const Flags extends Readonly<Record<string, FlagSpec>> = {}>(
  command: Omit<CommandSpec, "args" | "flags"> & {
    readonly args?: Args;
    readonly flags?: Flags;
    readonly run: (context: CliContext<ArgsOf<Args>, FlagsOf<Flags>>) => Awaitable<CliResult | void, unknown>;
  },
): CliCommand => command as unknown as CliCommand;

/**
 * The commands host plugins add to the `lemma` command:
 * `PluginContext.add(CliCommands, command)`. A command belongs to the plugin
 * that added it and leaves with it; a path is one plugin's at a time (another
 * adding it fails `Conflict`), and a plugin's replacement takes over its
 * paths. The `lemma` command's own commands come first: a plugin's command
 * with the same path is never reached. `CliRunner` lists and runs them.
 *
 * @composition all commands, one per path (another plugin adding a path fails `Conflict`); the `lemma` command's own
 * come first. A command whose `run` fails reports its failure as the command's result.
 */
export const CliCommands = Registry.make<CliCommand>("lemma/cli-commands", {
  key: (command) => command.path.join(" "),
  unique: true,
  check: (value) => specProblem(value) ?? (typeof (value as Partial<CliCommand>).run === "function" ? undefined : "a command needs a run function"),
});

/** A command as clients list it: its spec, and `source`, the plugin that added it. */
export const CliCommandInfo = Schema.Struct({ ...CommandSpec.fields, source: Schema.String });
export type CliCommandInfo = typeof CliCommandInfo.Type;

// ------------------------------------------------------------------ checks

/** What a check found: `fail` exits `lemma doctor` 1; `fix` says what to do about it. */
export const CheckOutcome = Schema.Struct({
  status: Schema.Literals(["ok", "warn", "fail"]),
  message: Schema.String,
  fix: Schema.optional(Schema.String),
});
export type CheckOutcome = typeof CheckOutcome.Type;

/**
 * A check of a plugin's setup that `lemma doctor` runs once a host is up (a
 * provider is configured, a server answers): `PluginContext.add(CliChecks,
 * check)`. It returns what it found, a promise of it, or an Effect; a check
 * that fails or throws reports `fail` with why.
 */
export interface CliCheck {
  /** Unique across plugins by convention: `<plugin>.<what>`. */
  readonly id: string;
  readonly title: string;
  readonly run: () => Awaitable<CheckOutcome, unknown>;
}

/**
 * The checks `lemma doctor` runs: `PluginContext.add(CliChecks, check)`.
 *
 * @composition every check runs, at once; one that fails, throws, or takes longer than its timeout reports `fail`
 * with why, and the rest still report.
 */
export const CliChecks = Registry.make<CliCheck>("lemma/cli-checks", {
  key: (check) => check.id,
  check: (value) => {
    const check = value as Partial<CliCheck> | null;
    if (typeof check !== "object" || check === null || typeof check.id !== "string" || check.id === "") return "a check needs an id";
    if (typeof check.title !== "string") return `check "${check.id}" needs a title`;
    return typeof check.run === "function" ? undefined : `check "${check.id}" needs a run function`;
  },
});

/**
 * Work stopping the host would cut off, as a plugin knows it (the turns
 * running, the prompts queued): what `lemma stop` and the desktop app's quit
 * show, and ask about, before they stop it, and `lemma status` lists. A
 * plugin adds a reporter with `PluginContext.add(InProgress, reporter)`; it
 * belongs to that plugin and leaves with it.
 */
export interface InProgressReporter {
  /** Unique across plugins by convention: `<plugin>.<what>` (`agent.turns`). */
  readonly id: string;
  /** What its items are, as a heading: `Turns`. */
  readonly title: string;
  /**
   * Each piece of work now, a line each (`a turn running in session 01J…`),
   * none when there is none: an Effect run each time it is read, or a
   * function returning them, a promise of them, or an Effect.
   */
  readonly items: Effect.Effect<readonly string[]> | (() => Awaitable<readonly string[]>);
}

/**
 * Work that stopping the host would cut off, as `lemma stop`, `lemma status`, and the desktop app's quit show it:
 * `PluginContext.add(InProgress, reporter)`.
 *
 * @composition every reporter is asked, at once; one that fails reports nothing, and the rest still report.
 */
export const InProgress = Registry.make<InProgressReporter>("lemma/cli-in-progress", { key: (reporter) => reporter.id });

/** A reporter's work as clients see it (`cli.in-progress`): `source` is the plugin that added it. */
export const InProgressInfo = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  source: Schema.String,
  items: Schema.Array(Schema.String),
});
export type InProgressInfo = typeof InProgressInfo.Type;

/** A check as `lemma doctor` reports it. */
export const CheckResult = Schema.Struct({ id: Schema.String, title: Schema.String, source: Schema.String, ...CheckOutcome.fields });
export type CheckResult = typeof CheckResult.Type;

// ------------------------------------------------------------------ the wire

/**
 * What `cli.run` sends, in order: `started` with the invocation's id, what
 * the command prints (`text`, `json`), asks the client to do (`open`,
 * `answer`, `rerun`), and its `result` last, then it ends; or it fails with
 * the command's error.
 */
export const CliElement = Schema.Union([
  Schema.Struct({ type: Schema.Literal("started"), invocation: Schema.String }),
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String, err: Schema.optional(Schema.Boolean) }),
  Schema.Struct({ type: Schema.Literal("json"), value: Schema.Unknown }),
  Schema.Struct({
    type: Schema.Literal("open"),
    url: Schema.optional(Schema.String),
    path: Schema.optional(Schema.String),
    prompt: Schema.optional(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("answer"), origin: Schema.String }),
  Schema.Struct({ type: Schema.Literal("rerun"), args: Schema.Array(Schema.String) }),
  Schema.Struct({
    type: Schema.Literal("result"),
    json: Schema.optional(Schema.Unknown),
    text: Schema.optional(Schema.String),
    ids: Schema.optional(Schema.Array(Schema.String)),
    failed: Schema.optional(Schema.Boolean),
  }),
]);
export type CliElement = typeof CliElement.Type;

/** A command to run (`path`, `input`), or an invocation to rejoin (`resume`), with how the client prints. */
export const RunRequest = Schema.Struct({
  path: Schema.Array(Schema.String),
  input: CliInput,
  cwd: Schema.String,
  json: Schema.Boolean,
  columns: Schema.optional(Schema.Number),
  /** What its questions carry, so the client answers them; new for each invocation. */
  origin: Schema.String,
  /**
   * Rejoins the invocation `invocation` rather than starting one: its
   * elements from the `received`th on (counting `started`), then the rest as
   * they come. `path` and `input` are not read.
   */
  resume: Schema.optional(Schema.Struct({ invocation: Schema.String, received: Schema.Number })),
});
export type RunRequest = typeof RunRequest.Type;

/**
 * Lists and runs what plugins add to `CliCommands`, and their checks. Its
 * provider serves it to clients as `CliChannels` (`serveCli`).
 */
export class CliRunner extends Context.Service<
  CliRunner,
  {
    /** By path. */
    readonly list: Effect.Effect<readonly CliCommandInfo[]>;
    /**
     * Starts an invocation, or rejoins one (`RunRequest.resume`), and sends
     * its elements (`CliElement`). An invocation outlives the stream that
     * started it for a while, so a client whose connection dropped rejoins
     * it and misses nothing; `cancel` ends one at once. Fails `UnknownCommand`
     * for a path no command has, `Usage` for input its spec rejects,
     * `Expired` for an invocation it no longer has, `Withdrawn` when the
     * command was removed while it ran (its plugin stopped or reloaded), or
     * as the command did.
     */
    readonly run: (request: RunRequest) => Stream.Stream<CliElement, HostError>;
    /** Interrupts an invocation, as Ctrl+C does; false when there was none. */
    readonly cancel: (invocation: string) => Effect.Effect<boolean>;
    readonly checks: Effect.Effect<readonly CheckResult[]>;
    /** What stopping the host would cut off now (`InProgress`): only the reporters with work. */
    readonly inProgress: Effect.Effect<readonly InProgressInfo[]>;
  }
>()("lemma/CliRunner") {}

/** What clients call on `CliRunner`, served by its provider (`serveCli`). */
export const CliChannels = {
  commands: defineChannel({
    kind: "call",
    id: "cli.commands",
    title: "CLI commands",
    description: "The commands host plugins add to the lemma command, with what each takes",
    payload: Schema.Void,
    success: Schema.Array(CliCommandInfo),
    repeatable: true,
  }),
  run: defineChannel({
    kind: "stream",
    id: "cli.run",
    title: "Run a CLI command",
    description: "Runs a command, or rejoins one a dropped connection left, sending what it prints and then its result",
    payload: RunRequest,
    success: CliElement,
  }),
  cancel: defineChannel({
    kind: "call",
    id: "cli.cancel",
    title: "Cancel a CLI command",
    description: "Interrupts an invocation, as Ctrl+C does; false when there was none",
    payload: Schema.Struct({ invocation: Schema.String }),
    success: Schema.Boolean,
  }),
  checks: defineChannel({
    kind: "call",
    id: "cli.checks",
    title: "Checks",
    description: "Runs every check plugins add for lemma doctor",
    payload: optionalPayload({}),
    success: Schema.Array(CheckResult),
    repeatable: true,
  }),
  inProgress: defineChannel({
    kind: "call",
    id: "cli.in-progress",
    title: "In progress",
    description: "What stopping the host would cut off now, by the plugin that reports it",
    payload: optionalPayload({}),
    success: Schema.Array(InProgressInfo),
    repeatable: true,
  }),
};

/** `CliChannels` served from `runner`: what a provider of `CliRunner` adds to `Channels`, each with `PluginContext.add`. */
export const serveCli = (runner: Context.Service.Shape<typeof CliRunner>): readonly Channel[] => [
  serveChannel(CliChannels.commands, () => runner.list),
  serveChannel(CliChannels.run, (request) => runner.run(request)),
  serveChannel(CliChannels.cancel, ({ invocation }) => runner.cancel(invocation)),
  serveChannel(CliChannels.checks, () => runner.checks),
  serveChannel(CliChannels.inProgress, () => runner.inProgress),
];

/** A `HostError` for a command's failure, keeping a domain error's code (its `reason`, else its tag) and subject. */
export const asHostError = (error: unknown, subject?: string): HostError => {
  if (error instanceof HostError) return error;
  if (error instanceof CliCommandError)
    return new HostError({
      code: error.reason,
      message: error.message,
      ...((error.subject ?? subject) === undefined ? {} : { subject: error.subject ?? subject }),
    });
  const tagged = error as {
    readonly _tag?: unknown;
    readonly reason?: unknown;
    readonly message?: unknown;
    readonly sessionId?: unknown;
    readonly path?: unknown;
  };
  const code = typeof tagged?.reason === "string" ? tagged.reason : typeof tagged?._tag === "string" ? tagged._tag : "Failed";
  const message = typeof tagged?.message === "string" && tagged.message !== "" ? tagged.message : error instanceof Error ? error.message : String(error);
  const named = typeof tagged?.sessionId === "string" ? tagged.sessionId : typeof tagged?.path === "string" ? tagged.path : subject;
  return new HostError({ code, message, ...(named === undefined ? {} : { subject: named }) });
};

/** A value as JSON carries it, so what a command returns crosses the wire as the client prints it: no `undefined` fields, dates as strings. */
export const plainJson = (value: unknown): unknown => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

/** Why a check or a command failed, in words. */
export const describeFailure = (cause: unknown): string => (cause instanceof Error ? cause.message : typeof cause === "string" ? cause : String(cause));
