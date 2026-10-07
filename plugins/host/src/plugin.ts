import { Cause, Effect, Stream } from "effect";
import type { Context } from "effect";
import { HOST_API, HostApi, HostControl, Notice, Paths, PluginsChanged } from "@lemma/contracts";
import { definePlugin, Events } from "@lemma/core";
import type { Plugin, PluginFault } from "@lemma/core";
import { HOST_PLUGIN_ID } from "./config.ts";
import { PathsSchema } from "./paths.ts";

export type HostControlService = Context.Service.Shape<typeof HostControl>;

interface HostPluginOptions {
  /** The app owns the loader; it hands the plugin a handle rather than the loader itself. */
  readonly control: HostControlService;
  /** `core.faults` of the composition this plugin runs in, so clients hear about failures. */
  readonly faults: Stream.Stream<PluginFault>;
}

/** The host API version this host provides (see `HostApi`); a plugin written for another is left out. */
const Api = HostApi(HOST_API);

/**
 * Provides `Paths` from its config, `HostControl` from the app's handle, and
 * the host API version, and publishes `PluginsChanged` after every change it
 * can observe: a reload or restart through the handle, and any fault. Faults
 * also become an error `Notice`; the app's log remains the durable record. The
 * app publishes `UiChanged` itself: it also sees the UI files change.
 */
export function hostPlugin(options: HostPluginOptions): Plugin<readonly (typeof Paths | typeof HostControl | typeof Api)[]> {
  return definePlugin({
    id: HOST_PLUGIN_ID,
    version: "0.1.0",
    config: PathsSchema,
    provides: { paths: Paths, hostControl: HostControl, api: Api },
    setup: function* (_, owner) {
      const events = yield* Events;
      const changed = Effect.flatMap(options.control.plugins, (plugins) => events.publish(PluginsChanged, { plugins }));
      yield* owner.background(
        "faults",
        Stream.runForEach(options.faults, (fault) =>
          events
            .publish(Notice, { level: "error", source: fault.pluginId, message: `${fault.message}: ${Cause.pretty(fault.cause)}` })
            .pipe(Effect.andThen(changed)),
        ),
      );
      return {
        paths: owner.config,
        api: HOST_API,
        hostControl: {
          plugins: options.control.plugins,
          composition: options.control.composition,
          // A restart can leave dependents failed even when it errors, so publish either way.
          restart: (pluginId, restartOptions) => options.control.restart(pluginId, restartOptions).pipe(Effect.ensuring(changed)),
          // A failed reload leaves the composition untouched; a report may still carry dispose faults.
          reload: options.control.reload.pipe(Effect.tap(() => changed)),
          // Like a restart: a rejected change is undone in the file, but an exclusive plugin it stopped may stay down.
          configure: (plugins, configureOptions) => options.control.configure(plugins, configureOptions).pipe(Effect.ensuring(changed)),
          ui: options.control.ui,
          configureUi: options.control.configureUi,
        },
      };
    },
  });
}
