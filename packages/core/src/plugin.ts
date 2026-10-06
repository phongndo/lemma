import { Context, Effect, Layer } from "effect";
import type { Duration, Schedule, Schema, Scope } from "effect";
import { toConfigSchema } from "./config.ts";
import type { ConfigInput, ConfigOf } from "./config.ts";
import type { PluginFault } from "./errors.ts";
import type { Events } from "./events.ts";
import { PluginContext } from "./hooks.ts";
import type { Hooks } from "./hooks.ts";
import type { Registries } from "./registries.ts";

// Tags are existential here; their concrete identifiers are retained by definePlugin.
export type Capability = Context.Key<any, any>;
export type Identifiers<Tags extends readonly Capability[]> = Context.Service.Identifier<Tags[number]>;

/** Capabilities by the name a plugin uses for each: `{ store: Store }`. */
export type Capabilities = Readonly<Record<string, Capability>>;
/** The services behind named capabilities, by the same names. */
export type Services<C extends Capabilities> = { readonly [K in keyof C]: Context.Service.Shape<C[K]> };
/** What every plugin's setup may use without declaring it. */
export type BuiltIns = PluginContext | Hooks | Events | Registries | Scope.Scope;

/** Time limits for lifecycle steps. Exceeding one produces a `PluginFault` with `deadline: true`. */
export interface Deadlines {
  readonly activate?: Duration.Input;
  readonly dispose?: Duration.Input;
}

export interface Plugin<Provides extends readonly Capability[] = readonly Capability[]> {
  readonly id: string;
  readonly version?: string;
  /** Validates the config supplied for this plugin, and encodes it back (a settings form shows defaults). Absent: the plugin takes none. */
  readonly config?: Schema.Codec<any, any>;
  readonly provides: Provides;
  readonly requires: readonly Capability[];
  /** Owns something that cannot exist twice (a port, a lock). Reload stops it before starting its replacement. */
  readonly exclusive: boolean;
  /** Retry activation after a runtime failure. Absent: stay failed until restarted explicitly. */
  readonly restart?: Schedule.Schedule<unknown, PluginFault>;
  readonly deadlines?: Deadlines;
  /** Erased only for storage in a heterogeneous composition. Receives decoded config. */
  readonly layer: (config: unknown) => Layer.Layer<never, unknown, unknown>;
}

export type PluginLayer<Provides extends readonly Capability[], Requires extends readonly Capability[], Error> = Layer.Layer<
  NoInfer<Identifiers<Provides>>,
  Error,
  NoInfer<Identifiers<Requires>> | PluginContext | Hooks | Events | Registries
>;

/** What `setup` receives besides its services: the `PluginContext` operations, its config, and its stop signal. */
export interface PluginSetup<Config> extends Context.Service.Shape<typeof PluginContext> {
  /** Decoded from the plugin's `config`. */
  readonly config: Config;
  /** Aborted when the plugin stops, before its own finalizers run: hand it to promise-based work it starts. */
  readonly signal: AbortSignal;
}

/** What `setup` returns: the services it provides, by name (nothing when it provides none). */
export type Provided<P extends Capabilities> = keyof P extends never ? void | undefined : Services<P>;

/**
 * A setup is an Effect, or a generator function yielding Effects (as
 * `Effect.gen` takes). It may use the services it declares and the built-ins.
 */
export type SetupResult<Out, R> = Effect.Effect<Out, unknown, R> | Generator<Effect.Effect<unknown, unknown, R>, Out, any>;

/** The manifest fields every way of writing a plugin shares. */
export interface PluginManifest {
  readonly id: string;
  readonly version?: string;
  readonly exclusive?: boolean;
  readonly restart?: Schedule.Schedule<unknown, PluginFault>;
  readonly deadlines?: Deadlines;
}

export interface SetupDefinition<Requires extends Capabilities, Provides extends Capabilities, C extends ConfigInput | undefined> extends PluginManifest {
  /** A Schema, or the defaults one is derived from (`{ limit: 3 }`; see `configSchema`). */
  readonly config?: C;
  /** Capabilities it uses, by the names `setup` receives them under. */
  readonly requires?: Requires;
  /** Capabilities it provides, by the names `setup` returns them under. */
  readonly provides?: Provides;
  /**
   * Runs once when the plugin activates, in the plugin's scope: resources it
   * acquires are released, and handlers it registers removed, when the plugin
   * stops. Returns the services it provides. A failure or defect fails the
   * plugin's activation, attributed to it.
   */
  readonly setup: (
    services: Services<NoInfer<Requires>>,
    plugin: PluginSetup<ConfigOf<NoInfer<C>>>,
  ) => SetupResult<Provided<NoInfer<Provides>>, Context.Service.Identifier<NoInfer<Requires>[keyof Requires]> | BuiltIns>;
}

/**
 * The manifest describes runtime wiring; the Layer owns construction and resources.
 * Requirements not listed here (or provided inside the Layer) are a type error.
 * The core also checks actual exports at activation, including undeclared exports.
 */
export function definePlugin<
  const Provides extends readonly Capability[] = readonly [],
  const Requires extends readonly Capability[] = readonly [],
  Error = never,
  Config = void,
>(
  definition: PluginManifest & {
    readonly config?: Schema.Codec<Config, any>;
    readonly provides?: Provides;
    readonly requires?: Requires;
    readonly layer: PluginLayer<Provides, Requires, Error> | ((config: Config) => PluginLayer<Provides, Requires, Error>);
  },
): Plugin<NoInfer<Provides>>;
/**
 * A plugin written as a setup: named dependencies and exports, and a `setup`
 * that receives the services it requires and returns those it provides. The
 * same plugin as one with a `layer`, planned, ordered, supervised, and
 * replaced alike; a shorter way to write one.
 *
 *   definePlugin({
 *     id: "greeter",
 *     config: { greeting: "Hello" },
 *     requires: { names: Names },
 *     provides: { greeter: Greeter },
 *     setup: function* ({ names }, { config }) {
 *       const known = yield* names.list;
 *       return { greeter: { greet: (name: string) => `${config.greeting}, ${known.includes(name) ? name : "stranger"}` } };
 *     },
 *   });
 */
export function definePlugin<const Requires extends Capabilities = {}, const Provides extends Capabilities = {}, C extends ConfigInput | undefined = undefined>(
  definition: SetupDefinition<Requires, Provides, C>,
): Plugin<readonly Provides[keyof Provides][]>;
export function definePlugin(
  definition: PluginManifest & {
    readonly config?: ConfigInput;
    readonly provides?: unknown;
    readonly requires?: unknown;
    readonly layer?: unknown;
    readonly setup?: unknown;
  },
): Plugin {
  const isSetup = "setup" in definition && typeof definition.setup === "function";
  if (isSetup === ("layer" in definition && definition.layer !== undefined)) {
    throw new TypeError(`Plugin "${definition.id}": define either a layer or a setup`);
  }
  const named = isSetup ? namedCapabilities(definition.id, definition.requires, definition.provides) : undefined;
  const provides = named?.provides.map(([, tag]) => tag) ?? (definition.provides as readonly Capability[] | undefined) ?? [];
  const requires = named?.requires.map(([, tag]) => tag) ?? (definition.requires as readonly Capability[] | undefined) ?? [];
  const config = definition.config === undefined ? undefined : isSetup ? toConfigSchema(definition.config) : (definition.config as Schema.Codec<any, any>);
  const layer = isSetup ? setupLayer(definition.setup as SetupFunction, named!) : (definition.layer as Plugin["layer"] | Layer.Layer<never, unknown, unknown>);
  return Object.freeze({
    id: definition.id,
    ...(definition.version === undefined ? {} : { version: definition.version }),
    ...(config === undefined ? {} : { config }),
    provides: Object.freeze([...provides]),
    requires: Object.freeze([...requires]),
    exclusive: definition.exclusive ?? false,
    ...(definition.restart === undefined ? {} : { restart: definition.restart }),
    ...(definition.deadlines === undefined ? {} : { deadlines: definition.deadlines }),
    layer: (Layer.isLayer(layer) ? () => layer : layer) as Plugin["layer"],
  });
}

type SetupFunction = (services: Record<string, unknown>, plugin: PluginSetup<unknown>) => unknown;
interface Named {
  readonly requires: readonly (readonly [string, Capability])[];
  readonly provides: readonly (readonly [string, Capability])[];
}

const namedCapabilities = (id: string, requires: unknown, provides: unknown): Named => {
  const entries = (value: unknown, field: string) => {
    if (value === undefined) return [];
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TypeError(`Plugin "${id}": a setup names its ${field} (\`{ name: Tag }\`); a list of tags goes with a layer`);
    }
    return Object.entries(value).map(([name, tag]) => {
      if (!Context.isKey(tag)) throw new TypeError(`Plugin "${id}": ${field}.${name} is not a capability tag`);
      return [name, tag as Capability] as const;
    });
  };
  return { requires: entries(requires, "requires"), provides: entries(provides, "provides") };
};

/** A setup as the Layer the runtime builds: its services in, its exports out, its stop signal tied to its scope. */
const setupLayer =
  (setup: SetupFunction, named: Named) =>
  (config: unknown): Layer.Layer<never, unknown, unknown> =>
    Layer.effectContext(
      Effect.gen(function* () {
        const services: Record<string, unknown> = {};
        for (const [name, tag] of named.requires) services[name] = yield* tag;
        const owner = yield* PluginContext;
        // Aborted last if setup fails (its first finalizer), and first once it succeeds (its last): see below.
        const controller = yield* Effect.acquireRelease(
          Effect.sync(() => new AbortController()),
          (controller) => Effect.sync(() => controller.abort()),
        );
        // A setup that fails (or throws before returning its Effect) aborts its signal at once, before its finalizers
        // run: one waiting on work it started would otherwise wait for an abort that comes only after it.
        const out = yield* Effect.suspend(() => {
          const result = setup(services, { ...owner, config, signal: controller.signal });
          return Effect.isEffect(result) ? result : Effect.gen(() => result as Generator<Effect.Effect<unknown, unknown, unknown>, unknown, any>);
        }).pipe(Effect.onError(() => Effect.sync(() => controller.abort())));
        // The newest finalizer runs first: work started for the plugin stops before the resources it uses are released.
        yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()));
        let context = Context.empty() as Context.Context<unknown>;
        if (named.provides.length > 0) {
          const exports = (out ?? {}) as Record<string, unknown>;
          for (const [name, tag] of named.provides) if (name in exports) context = Context.add(context, tag, exports[name]);
        }
        return context;
      }),
    ) as Layer.Layer<never, unknown, unknown>;
