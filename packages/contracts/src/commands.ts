import { Context, Data, Effect, Schema, Stream } from "effect";
import type { Scope } from "effect";
import { Event } from "@lemma/core";
import type { Awaitable, Events, PluginContext } from "@lemma/core";
import { defineChannel, eventFeed, serveChannel } from "./channels.ts";
import type { Channel } from "./channels.ts";
import { InteractionOrigin } from "./interaction.ts";

/** Where a command runs: the client's working directory and, when it has one open, its session. */
export const CommandContext = Schema.Struct({
  cwd: Schema.String,
  sessionId: Schema.optional(Schema.String),
});
export type CommandContext = typeof CommandContext.Type;

/** A registered command as clients list it. */
export const CommandInfo = Schema.Struct({
  /** Namespaced by area: `host.reload`, `workspace.checkout`. */
  id: Schema.String,
  /** Imperative, ending in `…` when the command asks for more. */
  title: Schema.String,
  /** Groups commands in a palette: `Host`, `Git`. */
  category: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  /** Extra words a search should match. */
  keywords: Schema.optional(Schema.Array(Schema.String)),
  /** The plugin that registered it. */
  source: Schema.String,
});
export type CommandInfo = typeof CommandInfo.Type;

export const CommandResult = Schema.Struct({
  /** What happened, for the client to show. */
  message: Schema.optional(Schema.String),
});
export type CommandResult = typeof CommandResult.Type;

/**
 * `NotFound`: no command has the id. `Cancelled`: the person dismissed one of
 * its questions. `Failed`: anything else the command failed with.
 */
export class CommandError extends Data.TaggedError("CommandError")<{
  readonly command: string;
  readonly reason: "NotFound" | "Failed" | "Cancelled";
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * An action a person can run from any client: the web app's palette, `lemma do`.
 * A command that needs input asks for it with `Interaction`, so every client
 * that can answer questions can run it.
 */
export interface Command extends Omit<CommandInfo, "source"> {
  /** Returns its result, a promise of it, or an Effect (`Awaitable`), so a plugin written with promises registers one too. */
  readonly run: (context: CommandContext) => Awaitable<CommandResult | void, unknown>;
}

/** Every command (`Commands.list`), published by its provider whenever one is registered or removed, once that is live. */
export const CommandsChanged = Event.make<{ readonly commands: readonly CommandInfo[] }>("lemma/commands.changed");

/**
 * The commands plugins register and clients list and run. Its provider
 * publishes `CommandsChanged`, and serves it to clients as `CommandChannels`
 * (`serveCommands`).
 */
export class Commands extends Context.Service<
  Commands,
  {
    /**
     * Call during activation: the registering plugin's `PluginContext` supplies
     * `source`. Removed when that plugin's scope closes. A duplicate id fails
     * with `Failed`.
     */
    readonly register: (command: Command) => Effect.Effect<void, CommandError, Scope.Scope | PluginContext>;
    /** Sorted by category, then title. */
    readonly list: Effect.Effect<readonly CommandInfo[]>;
    /** Interruption stays interruption; every failure becomes a `CommandError`. */
    readonly run: (id: string, context: CommandContext) => Effect.Effect<CommandResult, CommandError>;
  }
>()("lemma/Commands") {}

/**
 * What clients call on `Commands`, served by its provider (`serveCommands`).
 * A refused run fails with its `CommandError`'s reason as the code
 * (`NotFound`, `Cancelled`, `Failed`) and the command's id as the subject.
 */
export const CommandChannels = {
  list: defineChannel({
    kind: "call",
    id: "commands.list",
    title: "Commands",
    description: "Every command clients can run, by category then title",
    payload: Schema.Void,
    success: Schema.Array(CommandInfo),
  }),
  /**
   * Answers when the command ends, and interrupting the call (a client that
   * leaves) interrupts the command, as does its provider leaving (stopping or
   * reloading): the call then fails `Withdrawn`, and running it again reaches
   * the replacement. It runs in `cwd`, the host's when absent; its questions
   * carry `origin` as their `InteractionOrigin`, so the client that ran it can
   * tell them from others'.
   */
  run: defineChannel({
    kind: "call",
    id: "commands.run",
    title: "Run command",
    description: "Runs a command in `cwd` (default: the host's) and answers when it ends; its questions carry `origin`",
    payload: Schema.Struct({
      id: Schema.String,
      cwd: Schema.optional(Schema.String),
      sessionId: Schema.optional(Schema.String),
      origin: Schema.optional(Schema.String),
    }),
    success: CommandResult,
  }),
  /**
   * Every command now, then the whole list again after each registration or
   * removal (`CommandsChanged`; see `eventFeed`). The first list says the
   * stream is live and resyncs a client that reconnects. Each list is whole,
   * so a client keeps the last it received, which is current once the
   * commands stop changing. Lists are published after the change they
   * report, so one from changes made just as the stream opened can follow the
   * first though older than it, the current list then following. A client
   * that falls behind receives the latest, skipping the ones in between, and
   * never holds back the commands.
   */
  changes: defineChannel({
    kind: "stream",
    id: "commands.changes",
    title: "Command changes",
    description: "Every command now, then the whole list again whenever one is registered or removed",
    payload: Schema.Void,
    success: Schema.Array(CommandInfo),
  }),
};

/** What a client's `commands.changes`, and its source, hold: the latest list (see `eventFeed`). */
const FEED = { buffer: 1 };

/**
 * `CommandChannels` served from `commands`: what a provider of `Commands` adds
 * to `Channels`, each with `PluginContext.add`. A run naming no `cwd` runs in
 * `defaults.cwd`, the host's (`Paths`).
 */
export const serveCommands = (
  commands: Context.Service.Shape<typeof Commands>,
  events: Context.Service.Shape<typeof Events>,
  defaults: { readonly cwd: string },
): readonly Channel[] => [
  serveChannel(CommandChannels.list, () => commands.list),
  // A command can wait on a question for good: it stops when the provider leaves rather than hold that up.
  serveChannel(CommandChannels.run, ({ id, cwd, sessionId, origin }, { left }) => {
    const run = commands.run(id, { cwd: cwd ?? defaults.cwd, ...(sessionId === undefined ? {} : { sessionId }) });
    return Effect.raceFirst(origin === undefined ? run : Effect.provideService(run, InteractionOrigin, origin), left);
  }),
  serveChannel(CommandChannels.changes, () =>
    eventFeed(commands.list, [Stream.map(events.stream(CommandsChanged, FEED), (changed) => changed.commands)], FEED.buffer),
  ),
];
