import { Cause, Effect, Schema } from "effect";
import type { Context } from "effect";
import type { Registries } from "@lemma/core";
import { HostError, Inspectors, snapshotOf, toPluginStatus } from "@lemma/contracts";
import type { ChangeReport, HostControl, Paths, ReloadResult } from "@lemma/contracts";
import { callChannel, listChannels, openedStream, ServedRpcs } from "./channels.ts";
import { toHostError } from "./errors.ts";
import type { Hub } from "./hub.ts";
import type { Interactions } from "./interactions.ts";

interface HandlerServices {
  readonly version: string;
  readonly hub: Hub;
  readonly interactions: Interactions;
  readonly paths: Context.Service.Shape<typeof Paths>;
  readonly control: Context.Service.Shape<typeof HostControl>;
  /** The core's registries: host plugins' `Inspectors` and `Channels` are read from them. */
  readonly registries: Context.Service.Shape<typeof Registries>;
}

/** What an inspector's snapshot must be to cross the wire: JSON as it is. */
const asJson = Schema.encodeUnknownEffect(Schema.toCodecJson(Schema.Unknown));

/** The runtime's calls; every subsystem serves its own as channels, which this serves as they are registered. */
export const makeHandlers = ({ version, hub, interactions, paths, control, registries }: HandlerServices) =>
  ServedRpcs.of({
    "Host.Info": () => Effect.map(control.composition, (composition) => ({ version, cwd: paths.cwd, home: paths.home, composition, runtime: control.runtime })),
    "Host.Events": ({ answers }) => hub.events(answers),
    "Host.Plugins": () => Effect.map(control.plugins, (plugins) => plugins.map(toPluginStatus)),
    "Host.Inspectors": () =>
      Effect.map(registries.items(Inspectors), (items) =>
        items.map(({ item, pluginId }) => ({
          id: item.id,
          title: item.title,
          ...(item.description === undefined ? {} : { description: item.description }),
          source: pluginId,
        })),
      ),
    "Host.Inspect": ({ id }) =>
      Effect.flatMap(registries.items(Inspectors), (items) => {
        const found = items.find((contribution) => contribution.item.id === id)?.item;
        if (found === undefined) return Effect.fail(new HostError({ code: "NotFound", subject: id, message: `No inspector "${id}"` }));
        // An inspector that fails or dies says so; it never takes the transport with it.
        return snapshotOf(found).pipe(
          Effect.catchCause((cause) => {
            const error = Cause.squash(cause);
            return Effect.fail(new HostError({ code: "Failed", subject: id, message: error instanceof Error ? error.message : String(error) }));
          }),
          // Nor does a snapshot JSON cannot carry, which the protocol would refuse as a defect. One of nothing is no value.
          Effect.flatMap((snapshot) =>
            snapshot === undefined
              ? Effect.succeed(null)
              : asJson(snapshot).pipe(
                  Effect.mapError(
                    (error) => new HostError({ code: "Failed", subject: id, message: `Inspector "${id}"'s snapshot cannot be sent: ${error.message}` }),
                  ),
                ),
          ),
        );
      }),
    // Never deferred from here: the transport serving it, the one plugin a change from here waits for, is pinned, so it is
    // not restarted from here (`HostControl.restart` refuses to force a locked plugin).
    "Host.RestartPlugin": ({ pluginId, force }) =>
      control.restart(pluginId, force === undefined ? undefined : { force }).pipe(Effect.asVoid, Effect.mapError(toHostError)),
    "Host.Reload": () => control.reload.pipe(Effect.map(toReloadResult), Effect.mapError(toHostError)),
    "Host.Configure": ({ plugins, scope }) =>
      control.configure(plugins, scope === undefined ? undefined : { scope }).pipe(Effect.map(toReloadResult), Effect.mapError(toHostError)),

    "Host.ConfigureBundles": ({ bundles, scope }) =>
      control.configureBundles === undefined
        ? Effect.fail(new HostError({ code: "Unavailable", message: "This host does not support configuring bundles" }))
        : control.configureBundles(bundles, scope === undefined ? undefined : { scope }).pipe(Effect.map(toReloadResult), Effect.mapError(toHostError)),

    "Ui.Composition": () => control.ui,
    "Ui.Configure": ({ plugins, scope }) => control.configureUi(plugins, scope === undefined ? undefined : { scope }).pipe(Effect.mapError(toHostError)),

    "Interaction.List": () => Effect.sync(() => [...interactions.open()]),
    "Interaction.Answer": ({ id, answer }) => interactions.answer(id, answer),
    "Interaction.Dismiss": ({ id }) => interactions.dismiss(id),

    // Read at each call, not required: a channel's plugin stops, reloads, or is off without the transport noticing.
    "Channel.List": () => listChannels(registries),
    "Channel.Call": ({ id, payload }) => callChannel(registries, id, payload),
    // `ChannelLifetime` finds the channel and runs the request within its lifetime; this serves what it found.
    "Channel.Open": () => openedStream,
  });

const toReloadResult = (report: ChangeReport): ReloadResult => ({
  started: report.started,
  restarted: report.restarted,
  stopped: report.stopped,
  ...(report.failed.length > 0 ? { failed: report.failed } : {}),
  ...(report.deferred ? { deferred: true } : {}),
});
