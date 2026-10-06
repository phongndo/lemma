import { Context, Data, Schema } from "effect";
import type { Effect, Scope } from "effect";
import { Event } from "@lemma/core";
import type { Awaitable, PluginContext } from "@lemma/core";

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

/** Published whenever a command is registered or removed. */
export const CommandsChanged = Event.make<{ readonly commands: readonly CommandInfo[] }>("lemma/commands.changed");

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
