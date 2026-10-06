import { Cause, Context, Effect, Layer } from "effect";
import type { Schema } from "effect";
import { catchError, createRoot } from "solid-js";
import { definePlugin, PluginContext } from "@lemma/core";
import type { Capability, Plugin } from "@lemma/core";
import type { AnyRoute } from "@lemma/router";
import { Slots, UiApi } from "./contracts.ts";
import type { SlotsService } from "./slots.ts";

/** Named capabilities: a plugin's `requires` or `provides`. */
export type Capabilities = Readonly<Record<string, Capability>>;
/** The services behind named capabilities. */
export type Services<C extends Capabilities> = { readonly [K in keyof C]: Context.Service.Shape<C[K]> };

export interface UiPluginContext<Config> {
  readonly id: string;
  /** Decoded from the plugin's `config` Schema; the `ui` row in config.jsonc sets it. */
  readonly config: Config;
  /** Runs when the plugin stops: turned off, replaced, or restarted with a dependency. */
  readonly onCleanup: (fn: () => void) => void;
}

export interface UiPluginDefinition<Requires extends Capabilities, Provides extends Capabilities, Config> {
  readonly id: string;
  readonly version?: string;
  readonly config?: Schema.Codec<Config, any>;
  /**
   * Its stylesheet: applied while it runs (in the `plugins` cascade layer,
   * above the foundation and under stylesheets from `~/.lemma/ui`) and removed
   * when it stops, so a replacement never inherits it.
   */
  readonly styles?: string;
  readonly requires?: Requires;
  readonly provides?: Provides;
  /**
   * The version of the web app's contracts it is written for (`UI_API`). An
   * app that does not provide it leaves the plugin out, saying which version
   * it needs, rather than run it against contracts it was not written for.
   */
  readonly api?: number;
  /**
   * The routes it shows pages at (its `Pages` items' routes). The app knows
   * them while the plugin is off or failed, so a link to one says the plugin
   * is off, and names it, rather than that nothing lives there.
   */
  readonly routes?: readonly AnyRoute[];
  /**
   * Runs once when the plugin starts, inside its own Solid root: signals,
   * memos, and effects created here live until the plugin stops. Returns the
   * services it provides, by the names in `provides`. Throwing fails this
   * plugin (and halts what requires it) without touching the others, and so
   * does a computation made here throwing later: its state may be half
   * updated, so it stops rather than run on, and the rest of the page keeps
   * updating.
   */
  readonly setup: (use: Services<Requires>, plugin: UiPluginContext<Config>) => keyof Provides extends never ? void : Services<Provides>;
}

/** Each UI plugin's definition, for `extendUiPlugin` and `routesOf`. */
const definitions = new WeakMap<Plugin, UiPluginDefinition<any, any, any>>();

/** The routes `plugin` declares (`UiPluginDefinition.routes`); none for a plugin not made with `defineUiPlugin`. */
export const routesOf = (plugin: Plugin): readonly AnyRoute[] => definitions.get(plugin)?.routes ?? [];

/**
 * A plugin made from another's definition: `change` receives it and returns
 * the new one, typically with the same id and a `setup` that calls the
 * original's. A replacement made this way keeps what the original gains in
 * later versions instead of a copy of it.
 *
 *   extendUiPlugin(api.bundled.toasts, (base) => ({ ...base, setup: (use, plugin) => { const made = base.setup(use, plugin); … return made; } }))
 */
export function extendUiPlugin(
  plugin: Plugin,
  change: (definition: UiPluginDefinition<Capabilities, Capabilities, any>) => UiPluginDefinition<Capabilities, Capabilities, any>,
): Plugin {
  const definition = definitions.get(plugin);
  if (definition === undefined) throw new Error(`"${plugin.id}" was not made with defineUiPlugin, so it has no definition to extend`);
  return defineUiPlugin(change(definition));
}

/**
 * A web app plugin, written as plain TypeScript over the kernel's
 * `definePlugin`: dependencies and exports are named records of capability
 * tags, and resources are released through `onCleanup` rather than Effect
 * scopes. The kernel still plans, orders, replaces, and supervises it like
 * any host plugin.
 */
export function defineUiPlugin<const Requires extends Capabilities = {}, const Provides extends Capabilities = {}, Config = void>(
  definition: UiPluginDefinition<Requires, Provides, Config>,
): Plugin {
  const requires = Object.entries(definition.requires ?? {});
  const provides = Object.entries(definition.provides ?? {});
  const layer = (config: Config) =>
    Layer.effectContext(
      Effect.gen(function* () {
        const use: Record<string, unknown> = {};
        const owner = yield* PluginContext;
        for (const [name, tag] of requires) {
          const service: unknown = yield* tag;
          // Its own view of the slots, so what it adds is its own: attributed to it, and gone when it stops.
          use[name] = tag.key === Slots.key && typeof (service as Partial<SlotsService>).as === "function" ? (service as SlotsService).as(owner) : service;
        }
        const cleanups: (() => void)[] = [];
        const stop = () => {
          for (const fn of cleanups.splice(0).reverse()) {
            try {
              fn();
            } catch (error) {
              console.error(`${definition.id}: cleanup failed`, error);
            }
          }
        };
        if (definition.styles !== undefined) {
          const styles = definition.styles;
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              const element = document.createElement("style");
              element.dataset.plugin = definition.id;
              element.textContent = `@layer plugins {\n${styles}\n}`;
              document.head.append(element);
              return element;
            }),
            (element) => Effect.sync(() => element.remove()),
          );
        }
        const services = yield* Effect.acquireRelease(
          Effect.sync(() => {
            let started = false;
            let failed: { readonly error: unknown } | undefined;
            // Once is enough: the plugin is stopping, and a computation may throw again before it has.
            let faulted = false;
            try {
              const made = createRoot((dispose) => {
                cleanups.push(dispose);
                // Errors from here on reach the plugin, not the page: uncaught, one would leave other plugins' views unupdated.
                return catchError(
                  () => definition.setup(use as Services<Requires>, { id: definition.id, config, onCleanup: (fn) => void cleanups.push(fn) }),
                  (error) => {
                    if (!started) failed ??= { error };
                    else if (!faulted) {
                      faulted = true;
                      Effect.runSync(owner.fault("effects", Cause.die(error), { fatal: true }));
                    }
                  },
                );
              });
              if (failed !== undefined) throw failed.error;
              started = true;
              return made;
            } catch (error) {
              stop();
              throw error;
            }
          }),
          () => Effect.sync(stop),
        );
        let context = Context.empty() as Context.Context<unknown>;
        for (const [name, tag] of provides) context = Context.add(context, tag, (services as Record<string, unknown>)[name]);
        return context;
      }),
    );
  const plugin = definePlugin({
    id: definition.id,
    ...(definition.version === undefined ? {} : { version: definition.version }),
    ...(definition.config === undefined ? {} : { config: definition.config }),
    provides: provides.map(([, tag]) => tag),
    // The API version is a requirement like any other, so the planner leaves out a plugin written for one nobody provides.
    requires: [...requires.map(([, tag]) => tag), ...(definition.api === undefined ? [] : [UiApi(definition.api)])],
    // The capability tuple is dynamic here, so the typed Layer check of definePlugin cannot apply; the core checks exports at activation.
    layer: layer as never,
  });
  definitions.set(plugin, definition);
  return plugin;
}
