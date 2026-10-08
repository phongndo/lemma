import { Cause, Effect, Stream } from "effect";
import type { Context } from "effect";
import { awaitable, definePlugin, Events, PluginContext, Registries, Registry } from "@lemma/core";
import { Channels, CommandError, Commands, CommandsChanged, Inspectors, InteractionError, Paths, serveCommands, withContribution } from "@lemma/contracts";
import type { Command, CommandInfo } from "@lemma/contracts";

type Service = Context.Service.Shape<typeof Commands>;

/**
 * What plugins register, in the core's registry: each command belongs to its
 * plugin and leaves with it, and the plugin's replacement takes over its ids at
 * the swap. Private to this plugin: contributors go through `Commands.register`.
 */
const Entries = Registry.make<Command>("lemma/commands", { key: (command) => command.id, unique: true });

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
    message: `"${id}" was withdrawn while it ran: ${pluginId}, which registered it, removed it, stopped, or was replaced`,
    ...(cause === undefined ? {} : { cause }),
  });

const makeRegistry: Effect.Effect<Service, never, Events | PluginContext | Registries> = Effect.gen(function* () {
  const events = yield* Events;
  const owner = yield* PluginContext;
  const registries = yield* Registries;
  const snapshot = Effect.map(registries.items(Entries), infoOf);

  // Clients hear of every change once it is live, after a contributor is published and after it leaves: `commands.changes` follows this.
  yield* owner
    .background(
      "commands.changed",
      Stream.runForEach(Stream.drop(registries.changes(Entries), 1), (items) => events.publish(CommandsChanged, { commands: infoOf(items) })),
    )
    .pipe(Effect.orDie);

  const register: Service["register"] = (command) =>
    Effect.gen(function* () {
      const contributor = yield* PluginContext;
      const remove = yield* contributor.add(Entries, command).pipe(
        Effect.catchTag("RegistryError", (error) =>
          Effect.fail(
            new CommandError({
              command: command.id,
              reason: "Failed",
              message: error.reason === "Conflict" ? `Command "${command.id}" is already registered by ${error.holder}` : error.message,
              cause: error,
            }),
          ),
        ),
        Effect.catchTag("CoreClosed", (error) =>
          Effect.fail(new CommandError({ command: command.id, reason: "Failed", message: "The core has closed", cause: error })),
        ),
      );
      // Gone when the registering scope closes, or with the plugin, whichever is first.
      yield* Effect.addFinalizer(() => remove);
    });

  // Within the lifetime of the plugin that registered the command, found again if a reload replaced it first.
  const run: Service["run"] = (id, context) =>
    owner.trace(
      `commands.run ${id}`,
      withContribution(
        registries,
        () => Effect.map(registries.items(Entries), (items) => items.find((contribution) => contribution.item.id === id)),
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

  return { register, list: snapshot, run } satisfies Service;
});

/**
 * Provides `Commands`, the registry every client lists and runs commands
 * through, and serves it to them as channels. Command plugins require
 * `Commands` and register during activation.
 */
export default definePlugin({
  id: "commands",
  version: "0.1.0",
  provides: { commands: Commands },
  requires: { paths: Paths },
  setup: function* ({ paths }, owner) {
    const commands = yield* makeRegistry;
    yield* Effect.forEach(serveCommands(commands, yield* Events, paths), (channel) => owner.add(Channels, channel));
    return { commands };
  },
});
