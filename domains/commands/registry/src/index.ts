import { Cause, Effect, Stream } from "effect";
import type { Context } from "effect";
import { awaitable, definePlugin, Events, PluginContext, Registries } from "@lemma/core";
import { Channels, Inspectors, InteractionError, Paths, withContribution } from "@lemma/contracts";
import { CommandError, CommandRunner, Commands, CommandsChanged, serveCommands } from "@lemma/commands";
import type { Command, CommandInfo } from "@lemma/commands";

type Service = Context.Service.Shape<typeof CommandRunner>;

const byCategoryThenTitle = (a: CommandInfo, b: CommandInfo): number =>
  (a.category ?? "").localeCompare(b.category ?? "") || a.title.localeCompare(b.title) || a.id.localeCompare(b.id);

const message = (cause: unknown): string => (cause instanceof Error ? cause.message : typeof cause === "string" ? cause : String(cause));

const infoOf = (items: readonly { readonly item: Command; readonly pluginId: string }[]): CommandInfo[] =>
  items.map(({ item: { run: _run, ...fields }, pluginId }) => ({ ...fields, source: pluginId })).sort(byCategoryThenTitle);

/** A run of `id` stopped because its command was removed while it ran. */
const withdrawn = (id: string, pluginId: string, cause?: unknown) =>
  new CommandError({
    command: id,
    reason: "Withdrawn",
    message: `"${id}" was withdrawn while it ran: ${pluginId}, which added it, removed it, stopped, or was replaced`,
    ...(cause === undefined ? {} : { cause }),
  });

const makeRegistry: Effect.Effect<Service, never, Events | PluginContext | Registries> = Effect.gen(function* () {
  const events = yield* Events;
  const owner = yield* PluginContext;
  const registries = yield* Registries;
  const snapshot = Effect.map(registries.items(Commands), infoOf);

  // Clients hear of every change once it is live, after a contributor is published and after it leaves: `commands.changes` follows this.
  yield* owner
    .background(
      "commands.changed",
      Stream.runForEach(Stream.drop(registries.changes(Commands), 1), (items) => events.publish(CommandsChanged, { commands: infoOf(items) })),
    )
    .pipe(Effect.orDie);

  // Within the lifetime of the plugin that added the command, found again if a reload replaced it first.
  const run: Service["run"] = (id, context) =>
    owner.trace(
      `commands.run ${id}`,
      withContribution(
        registries,
        () => Effect.map(registries.items(Commands), (items) => items.find((contribution) => contribution.item.id === id)),
        ({ item: command, pluginId }, left) => {
          const ran = awaitable(() => command.run(context)).pipe(
            Effect.map((result) => result ?? {}),
            Effect.catchCause((cause) => {
              if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause as Cause.Cause<never>);
              const error = Cause.squash(cause);
              const dismissed = error instanceof InteractionError && error.reason === "Dismissed";
              return Effect.fail(
                new CommandError({
                  command: id,
                  reason: dismissed ? "Cancelled" : "Failed",
                  message: dismissed ? `${command.title} was cancelled` : message(error),
                  cause: error,
                }),
              );
            }),
          );
          // A command can wait on a question for good: it stops when it is removed rather than hold up its plugin's stop.
          return Effect.raceFirst(
            ran,
            Effect.andThen(left, () => Effect.fail(withdrawn(id, pluginId))),
          );
        },
        {
          missing: () => new CommandError({ command: id, reason: "NotFound", message: `No command "${id}"` }),
          expired: ({ pluginId }, error) => withdrawn(id, pluginId, error),
        },
      ),
    );

  // What the devtools and `lemma inspect` show of it. Only a view: failing to add it never stops the commands.
  yield* owner
    .add(Inspectors, {
      id: "commands.registered",
      title: "Commands",
      description: "Every command clients can run, by category, and the plugin that added it",
      snapshot: Effect.map(snapshot, (commands) =>
        commands.map(({ id, title, category, source }) => ({ id, title, category: category ?? "", plugin: source })),
      ),
    })
    .pipe(Effect.ignore);

  return { list: snapshot, run } satisfies Service;
});

/**
 * Provides `CommandRunner`, which lists and runs what plugins add to
 * `Commands`, and serves it to clients as channels.
 */
export default definePlugin({
  id: "commands.registry",
  version: "0.1.0",
  provides: { commands: CommandRunner },
  requires: { paths: Paths },
  setup: function* ({ paths }, owner) {
    const commands = yield* makeRegistry;
    yield* Effect.forEach(serveCommands(commands, yield* Events, paths), (channel) => owner.add(Channels, channel));
    return { commands };
  },
});
