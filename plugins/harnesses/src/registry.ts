import { Effect, Stream } from "effect";
import type { Context } from "effect";
import { Events, PluginContext, Registries, Registry } from "@lemma/core";
import type { Contribution } from "@lemma/core";
import { HarnessError, Harnesses, HarnessesChanged, Inspectors, NATIVE_HARNESS } from "@lemma/contracts";
import type { Harness, HarnessInfo, HarnessStatus } from "@lemma/contracts";

type Service = Context.Tag.Service<typeof Harnesses>;

/**
 * What plugins register, in the core's registry: each harness belongs to its
 * plugin and leaves with it, and the plugin's replacement takes over its id at
 * the swap. Private to this plugin: contributors go through `Harnesses.register`.
 */
const Entries = Registry.make<Harness>("lemma/harnesses", { key: (harness) => harness.id, unique: true });

/** How long a harness may take to say whether it can run turns. */
const STATUS_TIMEOUT = "5 seconds";

const message = (cause: unknown): string => (cause instanceof Error ? cause.message : typeof cause === "string" ? cause : String(cause));

/** The native harness first, then by title. */
const order = (a: HarnessInfo, b: HarnessInfo): number =>
  Number(b.id === NATIVE_HARNESS) - Number(a.id === NATIVE_HARNESS) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id);

export const makeRegistry: Effect.Effect<Service, never, Events | PluginContext | Registries> = Effect.gen(function* () {
  const events = yield* Events;
  const owner = yield* PluginContext;
  const registries = yield* Registries;
  /** Each harness's last answer: asked once, then again on `refresh`. */
  const statuses = new Map<Harness, HarnessStatus>();

  const statusOf = (harness: Harness, ask: boolean): Effect.Effect<HarnessStatus> => {
    const known = statuses.get(harness);
    if (known !== undefined && !ask) return Effect.succeed(known);
    return harness.status.pipe(
      Effect.timeoutFail({ duration: STATUS_TIMEOUT, onTimeout: () => new Error(`did not answer within ${STATUS_TIMEOUT}`) }),
      Effect.catchAllCause((cause) => Effect.succeed<HarnessStatus>({ state: "unavailable", detail: `Its status check failed: ${message(cause)}` })),
      Effect.tap((status) => Effect.sync(() => statuses.set(harness, status))),
    );
  };

  const infoOf = (items: readonly Contribution<Harness>[], ask: boolean): Effect.Effect<HarnessInfo[]> =>
    Effect.map(
      Effect.forEach(
        items,
        ({ item, pluginId }) =>
          Effect.map(statusOf(item, ask), (status): HarnessInfo => ({
            id: item.id,
            title: item.title,
            ...(item.description === undefined ? {} : { description: item.description }),
            source: pluginId,
            capabilities: item.capabilities,
            status,
          })),
        { concurrency: "unbounded" },
      ),
      (infos) => infos.sort(order),
    );

  // Clients hear of every change once it is live: after a contributor is published, and after it leaves.
  yield* owner
    .background(
      "harnesses.changed",
      Stream.runForEach(Stream.drop(registries.changes(Entries), 1), (items) =>
        Effect.flatMap(infoOf(items, false), (harnesses) => events.publish(HarnessesChanged, { harnesses })),
      ),
    )
    .pipe(Effect.orDie);

  const register: Service["register"] = (harness) =>
    Effect.gen(function* () {
      const contributor = yield* PluginContext;
      const remove = yield* contributor.add(Entries, harness).pipe(
        Effect.catchTag("RegistryError", (error) =>
          Effect.fail(
            new HarnessError({
              harness: harness.id,
              reason: error.reason === "Conflict" ? "Duplicate" : "Failed",
              message: error.reason === "Conflict" ? `Harness "${harness.id}" is already registered by ${error.holder}` : error.message,
              cause: error,
            }),
          ),
        ),
        Effect.catchTag("CoreClosed", (error) =>
          Effect.fail(new HarnessError({ harness: harness.id, reason: "Failed", message: "The core has closed", cause: error })),
        ),
      );
      // Gone when the registering scope closes, or with the plugin, whichever is first.
      yield* Effect.addFinalizer(() =>
        Effect.zipRight(
          remove,
          Effect.sync(() => statuses.delete(harness)),
        ),
      );
    });

  const list: Service["list"] = Effect.flatMap(registries.items(Entries), (items) => infoOf(items, false));

  const refresh: Service["refresh"] = Effect.gen(function* () {
    const harnesses = yield* Effect.flatMap(registries.items(Entries), (items) => infoOf(items, true));
    yield* events.publish(HarnessesChanged, { harnesses });
    return harnesses;
  });

  const get: Service["get"] = (id) => Effect.map(registries.items(Entries), (items) => items.find((contribution) => contribution.item.id === id)?.item);

  // What the devtools and `lemma inspect` show of it. Only a view: failing to add it never stops the registry.
  yield* owner
    .add(Inspectors, {
      id: "harnesses.registered",
      title: "Harnesses",
      description: "Every harness that can run turns, the plugin that registered it, what it can do, and whether it is ready",
      snapshot: Effect.map(list, (harnesses) =>
        harnesses.map((harness) => ({
          id: harness.id,
          plugin: harness.source,
          status: harness.status.state,
          ...(harness.status.detail === undefined ? {} : { detail: harness.status.detail }),
          capabilities: Object.entries(harness.capabilities)
            .filter(([, value]) => value)
            .map(([name]) => name)
            .join(", "),
        })),
      ),
    })
    .pipe(Effect.ignore);

  return { register, list, get, refresh };
});
