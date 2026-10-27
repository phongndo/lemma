import { Context, Effect, Layer } from "effect";
import type { Host } from "@lemma/client";
import type { ApplicationServices } from "@lemma/core";
import type { AnyRoute } from "@lemma/router";
import { Client, HostPlugins, Interactions, Notify, PageTrace, Router, Slots, WEB_API, WebApi, WebPlugins } from "@lemma/web";
import type { HostPluginsService, NotifyService, WebPluginsService } from "@lemma/web";
import { createClient } from "./client.ts";
import { createHostPlugins } from "./host-plugins.ts";
import { createInteractions } from "./interactions.ts";
import { createNotify } from "./notify.ts";
import { createRouterService } from "./router.ts";
import { makeSlots } from "./slots.ts";
import { createPageTrace } from "./trace.ts";
import type { PageTraceRuntime } from "./trace.ts";

/*
 * The web app's runtime (`src/runtime/`): what the boot provides every
 * plugin, written against nothing plugins contribute but reactively. Code
 * here imports the runtime's contracts, never a plugin, a component, or the
 * contracts plugins provide, and adds to no slot. A bad item from a plugin is
 * that plugin's fault (`slots.fail`); the runtime's own failures are logged
 * and reported, never thrown into the page.
 */

/** What the runtime provides, in the order it builds them. */
export const provides = [Client, WebPlugins, WebApi(WEB_API), Notify, HostPlugins, Interactions, PageTrace, Slots, Router] as const;

export interface WebRuntime {
  /** The page's messages, for what the boot itself reports (problems, faults). */
  readonly notify: NotifyService;
  /** The host's plugins, for the boot to run a web half only while its host half runs. */
  readonly hostPlugins: HostPluginsService;
  /** The page's trace: the tracer to run the loader with, and where its changes are recorded. */
  readonly trace: PageTraceRuntime;
  /** For `makeLoader`'s `provide`, and `provided` when planning. */
  readonly services: ApplicationServices<typeof provides>;
}

/**
 * The runtime for this page. The connection, the messages, the host's plugins
 * and questions are built here, once: a loader that fails to start and the
 * one after it share them, so a pending message or question survives. Slots
 * and the router belong to the core they are built for (`services`): they
 * read its registries, and are released after its last plugin is.
 */
export function createWebRuntime(options: {
  readonly host: Host;
  /** The web app's own plugins, which the boot runs. */
  readonly plugins: WebPluginsService;
  /** The app's own routes, known whatever plugins run (`BootOptions.appRoutes`). */
  readonly appRoutes: readonly AnyRoute[];
}): WebRuntime {
  const client = createClient(options.host);
  const notify = createNotify(client.client);
  const hostPlugins = createHostPlugins(client.client, notify.notify);
  const interactions = createInteractions(options.host, client.client, notify.notify);
  const trace = createPageTrace();
  const layer = Layer.effectContext(
    Effect.gen(function* () {
      const slots = yield* makeSlots;
      const router = createRouterService({ slots, notify: notify.notify, plugins: options.plugins, known: options.appRoutes });
      yield* Effect.addFinalizer(() => Effect.sync(router.dispose));
      return Context.make(Client, client.client).pipe(
        Context.add(WebPlugins, options.plugins),
        Context.add(WebApi(WEB_API), WEB_API),
        Context.add(Notify, notify.notify),
        Context.add(HostPlugins, hostPlugins.plugins),
        Context.add(Interactions, interactions.interactions),
        Context.add(PageTrace, trace.trace),
        Context.add(Slots, slots),
        Context.add(Router, router.router),
      );
    }),
  );
  return { notify: notify.notify, hostPlugins: hostPlugins.plugins, trace, services: { provides, layer } };
}
