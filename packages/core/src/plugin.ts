import { Layer } from "effect";
import type { Context, Duration, Schedule, Schema } from "effect";
import type { PluginFault } from "./errors.ts";
import type { Events } from "./events.ts";
import type { Hooks, PluginContext } from "./hooks.ts";
import type { Registries } from "./registries.ts";

// Tags are existential here; their concrete identifiers are retained by definePlugin.
export type Capability = Context.Key<any, any>;
export type Identifiers<Tags extends readonly Capability[]> = Context.Service.Identifier<Tags[number]>;

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
>(definition: {
  readonly id: string;
  readonly version?: string;
  readonly config?: Schema.Codec<Config, any>;
  readonly provides?: Provides;
  readonly requires?: Requires;
  readonly exclusive?: boolean;
  readonly restart?: Schedule.Schedule<unknown, PluginFault>;
  readonly deadlines?: Deadlines;
  readonly layer: PluginLayer<Provides, Requires, Error> | ((config: Config) => PluginLayer<Provides, Requires, Error>);
}): Plugin<NoInfer<Provides>> {
  const layer = definition.layer;
  return Object.freeze({
    id: definition.id,
    ...(definition.version === undefined ? {} : { version: definition.version }),
    ...(definition.config === undefined ? {} : { config: definition.config }),
    provides: Object.freeze([...(definition.provides ?? [])]) as unknown as Provides,
    requires: Object.freeze([...(definition.requires ?? [])]),
    exclusive: definition.exclusive ?? false,
    ...(definition.restart === undefined ? {} : { restart: definition.restart }),
    ...(definition.deadlines === undefined ? {} : { deadlines: definition.deadlines }),
    layer: (Layer.isLayer(layer) ? () => layer : layer) as Plugin["layer"],
  });
}
