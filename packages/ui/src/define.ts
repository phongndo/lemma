import type { Schema } from "effect";
import { catchError, createRoot } from "solid-js";
import type { Capabilities, Plugin, Services } from "@lemma/core";
import { definePlugin as definePlainPlugin } from "@lemma/core/plain";
import type { AnyRoute } from "@lemma/router";
import { Slots, UiApi } from "./runtime.ts";
import type { SlotsService } from "./slots.ts";

/** Named capabilities (a plugin's `requires` or `provides`), and the services behind them: the kernel's. */
export type { Capabilities, Services };

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
  plugin: Plugin | undefined,
  change: (definition: UiPluginDefinition<Capabilities, Capabilities, any>) => UiPluginDefinition<Capabilities, Capabilities, any>,
): Plugin {
  // `api.bundled.notify`, say: the runtime's services are the app's own, not plugins to extend.
  if (plugin === undefined) {
    throw new Error("No bundled plugin there: Client, Slots, Router, Notify, HostPlugins, Interactions, and UiPlugins are the web app's runtime, not plugins");
  }
  const definition = definitions.get(plugin);
  if (definition === undefined) throw new Error(`"${plugin.id}" was not made with defineUiPlugin, so it has no definition to extend`);
  return defineUiPlugin(change(definition));
}

/** Where a plugin's API-version requirement sits among its named capabilities; no plugin names one so. */
const API = "~api";

/**
 * A web app plugin, written as plain TypeScript: the kernel's promise-based
 * `definePlugin` (`@lemma/core/plain`) with the page's own conventions.
 * Dependencies and exports are named records of capability tags, handed over
 * as they are (the web app's contracts are promise-based already), except
 * `Slots`, which each plugin receives as its own, so what it adds is
 * attributed to it. `setup` runs in its own Solid root, inside an error
 * boundary, and its stylesheet applies while it runs. The kernel still plans,
 * orders, replaces, and supervises it like any host plugin.
 */
export function defineUiPlugin<const Requires extends Capabilities = {}, const Provides extends Capabilities = {}, Config = void>(
  definition: UiPluginDefinition<Requires, Provides, Config>,
): Plugin {
  const requires: Capabilities = { ...definition.requires, ...(definition.api === undefined ? {} : { [API]: UiApi(definition.api) }) };
  const plugin = definePlainPlugin(
    {
      id: definition.id,
      ...(definition.version === undefined ? {} : { version: definition.version }),
      ...(definition.config === undefined ? {} : { config: definition.config }),
      requires,
      ...(definition.provides === undefined ? {} : { provides: definition.provides }),
      setup: (use, plugin) =>
        definition.setup(use as unknown as Services<Requires>, { id: plugin.id, config: plugin.config as Config, onCleanup: plugin.onCleanup }) as never,
    },
    {
      services: (raw, owner) => {
        const use: Record<string, unknown> = {};
        for (const [name, service] of Object.entries(raw)) {
          if (name === API) continue;
          // Its own view of the slots, so what it adds is its own: attributed to it, and gone when it stops.
          use[name] =
            requires[name]?.key === Slots.key && typeof (service as Partial<SlotsService>).as === "function" ? (service as SlotsService).as(owner) : service;
        }
        return use;
      },
      run: (setup, plugin) => {
        if (definition.styles !== undefined) {
          const element = document.createElement("style");
          element.dataset.plugin = definition.id;
          element.textContent = `@layer plugins {\n${definition.styles}\n}`;
          document.head.append(element);
          plugin.onCleanup(() => element.remove());
        }
        let started = false;
        let failed: { readonly error: unknown } | undefined;
        // Once is enough: the plugin is stopping, and a computation may throw again before it has.
        let faulted = false;
        const made = createRoot((dispose) => {
          plugin.onCleanup(dispose);
          // Errors from here on reach the plugin, not the page: uncaught, one would leave other plugins' views unupdated.
          return catchError(setup, (error) => {
            if (!started) failed ??= { error };
            else if (!faulted) {
              faulted = true;
              plugin.fault("effects", error, { fatal: true });
            }
          });
        });
        if (failed !== undefined) throw failed.error;
        started = true;
        return made as ReturnType<typeof setup>;
      },
    },
  );
  definitions.set(plugin, definition);
  return plugin;
}
