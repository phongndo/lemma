import { Cause, Effect, Stream } from "effect";
import type { Context } from "effect";
import { awaitable, definePlugin, Events, PluginContext, Registries, Registry } from "@lemma/core";
import { Channels, CommandError, Commands, CommandsChanged, Inspectors, InteractionError, Paths, serveCommands } from "@lemma/contracts";
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

  const run: Service["run"] = (id, context) =>
    owner.trace(
      `commands.run ${id}`,
      Effect.gen(function* () {
        const entry = (yield* registries.items(Entries)).find((contribution) => contribution.item.id === id)?.item;
        if (entry === undefined) {
          return yield* new CommandError({ command: id, reason: "NotFound", message: `No command "${id}"` });
        }
        const result = yield* awaitable(() => entry.run(context)).pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause as Cause.Cause<never>);
            const error = Cause.squash(cause);
            const dismissed = error instanceof InteractionError && error.reason === "Dismissed";
            return Effect.fail(
              new CommandError({
                command: id,
                reason: dismissed ? "Cancelled" : "Failed",
                message: dismissed ? `${entry.title} was cancelled` : message(error),
                cause: error,
              }),
            );
          }),
        );
        return result ?? {};
      }),
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
