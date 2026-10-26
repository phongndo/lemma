import type { Schema } from "effect";
import { catchError, createRoot } from "solid-js";
import type { Capabilities, Plugin, Services } from "@lemma/core";
import { definePlugin as definePlainPlugin, PluginStopped } from "@lemma/core/plain";
import type { PlainSetup } from "@lemma/core/plain";
import type { AnyRoute } from "@lemma/router";
import { owners } from "./owner.ts";
import { Client, Slots, WebApi } from "./runtime.ts";
import type { ClientService } from "./runtime.ts";
import type { SlotsService } from "./slots.ts";

/** Named capabilities (a plugin's `requires` or `provides`), and the services behind them: the kernel's. */
export type { Capabilities, Services };

/**
 * What a web plugin's `setup` receives besides its services: the same handle a host plugin written with promises has
 * (`@lemma/core/plain`), but for what only the host has (hooks, events, registries). Everything it starts through
 * it is the plugin's: it ends when the plugin stops, and what fails in it is the plugin's fault, named for it.
 * Components drawn for the plugin's slot items reach it with `usePlugin`.
 */
/** What of the promise-based handle a web plugin's context is (its `config` typed apart): one list, for the type and the value. */
const CONTEXT_KEYS = ["id", "signal", "onCleanup", "background", "task", "after", "every", "listen", "action", "fault", "run", "trace"] as const;

export interface WebPluginContext<Config> extends Pick<PlainSetup<Config>, (typeof CONTEXT_KEYS)[number]> {
  /** Decoded from the plugin's `config` Schema; its row in config.jsonc's `plugins` sets it. */
  readonly config: Config;
}

export interface WebPluginDefinition<Requires extends Capabilities, Provides extends Capabilities, Config> {
  readonly id: string;
  readonly version?: string;
  readonly config?: Schema.Codec<Config, any>;
  /**
   * Its stylesheet: applied while it runs (in the `plugins` cascade layer,
   * above the foundation and under stylesheets from `~/.lemma/plugins`) and removed
   * when it stops, so a replacement never inherits it.
   */
  readonly styles?: string;
  readonly requires?: Requires;
  readonly provides?: Provides;
  /**
   * The version of the web app's contracts it is written for (`WEB_API`). An
   * app that does not provide it leaves the plugin out, saying which version
   * it needs, rather than run it against contracts it was not written for.
   */
  readonly api?: number;
  /** The domain contracts it is written against, and implements, as `name@version` (`ContractVersions` in `@lemma/core`). */
  readonly uses?: readonly string[];
  readonly implements?: readonly string[];
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
  readonly setup: (use: Services<Requires>, plugin: WebPluginContext<Config>) => keyof Provides extends never ? void : Services<Provides>;
}

/** Each UI plugin's definition, for `extendWebPlugin` and `routesOf`. */
const definitions = new WeakMap<Plugin, WebPluginDefinition<any, any, any>>();

/** The routes `plugin` declares (`WebPluginDefinition.routes`); none for a plugin not made with `defineWebPlugin`. */
export const routesOf = (plugin: Plugin): readonly AnyRoute[] => definitions.get(plugin)?.routes ?? [];

/**
 * A plugin made from another's definition: `change` receives it and returns
 * the new one, typically with the same id and a `setup` that calls the
 * original's. A replacement made this way keeps what the original gains in
 * later versions instead of a copy of it.
 *
 *   extendWebPlugin(api.bundled["frame.toasts"], (base) => ({ ...base, setup: (use, plugin) => { const made = base.setup(use, plugin); … return made; } }))
 */
export function extendWebPlugin(
  plugin: Plugin | undefined,
  change: (definition: WebPluginDefinition<Capabilities, Capabilities, any>) => WebPluginDefinition<Capabilities, Capabilities, any>,
): Plugin {
  // `api.bundled.toasts` (an id without its domain), or `api.bundled.notify` (the runtime's, which is no plugin).
  if (plugin === undefined) {
    throw new Error(
      "No bundled plugin there: a bundled plugin's id names its domain (frame.toasts, not toasts), and Client, Slots, Router, Notify, HostPlugins, Interactions, WebPlugins, and PageTrace are the web app's runtime, not plugins",
    );
  }
  const definition = definitions.get(plugin);
  if (definition === undefined) throw new Error(`"${plugin.id}" was not made with defineWebPlugin, so it has no definition to extend`);
  return defineWebPlugin(change(definition));
}

/** A web plugin's context from the promise-based handle, listed in `owners` while it runs, for `usePlugin`. */
const contextOf = (plugin: PlainSetup<unknown>): WebPluginContext<unknown> => {
  const context = { config: plugin.config, ...Object.fromEntries(CONTEXT_KEYS.map((key) => [key, plugin[key]])) } as WebPluginContext<unknown>;
  const { id } = plugin;
  // A replacement starts before this one stops, and is listed by then: only its own entry is removed. One that fails to
  // start gives the entry back to the instance it was to replace, which goes on running.
  const before = owners.get(id);
  owners.set(id, context);
  plugin.onCleanup(() => {
    if (owners.get(id) !== context) return;
    if (before !== undefined && !before.signal.aborted) owners.set(id, before);
    else owners.delete(id);
  });
  return context;
};

/**
 * A plugin's own view of the connection: what it subscribes to (events, reconnects, streams) ends when it stops, and a
 * call it makes is refused once it has stopped, or rejects with `PluginStopped` if it stops first, so an answer never
 * lands in a plugin that is gone.
 */
const ownedClient = (client: ClientService, pluginId: string, signal: AbortSignal): ClientService => {
  const stopped = (operation: string) => new PluginStopped({ pluginId, operation });
  const call =
    <Args extends unknown[], A>(operation: string, fn: (...args: Args) => Promise<A>) =>
    (...args: Args): Promise<A> => {
      if (signal.aborted) return Promise.reject(stopped(operation));
      return new Promise<A>((resolve, reject) => {
        const abort = () => reject(stopped(operation));
        signal.addEventListener("abort", abort, { once: true });
        fn(...args).then(
          (value) => {
            signal.removeEventListener("abort", abort);
            resolve(value);
          },
          (error: unknown) => {
            signal.removeEventListener("abort", abort);
            reject(error);
          },
        );
      });
    };
  const subscription =
    <Args extends unknown[]>(fn: (...args: Args) => () => void) =>
    (...args: Args): (() => void) => {
      if (signal.aborted) return () => {};
      const end = fn(...args);
      let ended = false;
      const once = () => {
        if (ended) return;
        ended = true;
        signal.removeEventListener("abort", once);
        end();
      };
      signal.addEventListener("abort", once, { once: true });
      return once;
    };
  // Each looked up as it is called, so the view follows the connection's own methods, as a test that wraps them does.
  type Fn = (...args: any[]) => any;
  return {
    status: () => client.status(),
    connected: () => client.connected(),
    info: () => client.info(),
    onEvent: subscription((...args: Parameters<ClientService["onEvent"]>) => client.onEvent(...args)),
    onConnect: subscription((...args: Parameters<ClientService["onConnect"]>) => client.onConnect(...args)),
    follow: subscription((...args: unknown[]) => (client.follow as Fn)(...args)) as ClientService["follow"],
    channel: {
      list: call("channel.list", () => client.channel.list()),
      call: call("channel.call", (...args: unknown[]) => (client.channel.call as Fn)(...args)) as ClientService["channel"]["call"],
      open: subscription((...args: unknown[]) => (client.channel.open as Fn)(...args)) as ClientService["channel"]["open"],
    },
    plugins: call("plugins", () => client.plugins()),
    restartPlugin: call("restartPlugin", (...args: Parameters<ClientService["restartPlugin"]>) => client.restartPlugin(...args)),
    reload: call("reload", () => client.reload()),
    configure: call("configure", (...args: Parameters<ClientService["configure"]>) => client.configure(...args)),
    inspectors: call("inspectors", () => client.inspectors()),
    inspect: call("inspect", (id: string) => client.inspect(id)),
    web: { composition: call("web.composition", () => client.web.composition()) },
  };
};

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
export function defineWebPlugin<const Requires extends Capabilities = {}, const Provides extends Capabilities = {}, Config = void>(
  definition: WebPluginDefinition<Requires, Provides, Config>,
): Plugin {
  const requires: Capabilities = { ...definition.requires, ...(definition.api === undefined ? {} : { [API]: WebApi(definition.api) }) };
  const plugin = definePlainPlugin(
    {
      id: definition.id,
      ...(definition.version === undefined ? {} : { version: definition.version }),
      ...(definition.uses === undefined ? {} : { uses: definition.uses }),
      ...(definition.implements === undefined ? {} : { implements: definition.implements }),
      ...(definition.config === undefined ? {} : { config: definition.config }),
      requires,
      ...(definition.provides === undefined ? {} : { provides: definition.provides }),
      setup: (use, plugin) => definition.setup(use as unknown as Services<Requires>, contextOf(plugin) as WebPluginContext<Config>) as never,
    },
    {
      services: (raw, owner) => {
        const use: Record<string, unknown> = {};
        for (const [name, service] of Object.entries(raw)) {
          if (name === API) continue;
          const key = requires[name]?.key;
          // Its own view of the slots, so what it adds is its own: attributed to it, and gone when it stops. And of the
          // connection, so what it subscribes to ends with it, and a call it made does not answer into a plugin gone.
          use[name] =
            key === Slots.key && typeof (service as Partial<SlotsService>).as === "function"
              ? (service as SlotsService).as(owner)
              : key === Client.key
                ? ownedClient(service as ClientService, owner.id, owner.signal)
                : service;
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
