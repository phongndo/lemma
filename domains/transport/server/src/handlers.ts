import { Effect } from "effect";
import type { Context } from "effect";
import type { Registries } from "@lemma/core";
import { inspectorSnapshot, listInspectors, runtimeInfo, toPluginStatus } from "@lemma/contracts";
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

/** The runtime's calls; every domain serves its own as channels, which this serves as they are registered. */
export const makeHandlers = ({ version, hub, interactions, paths, control, registries }: HandlerServices) =>
  ServedRpcs.of({
    "Host.Info": () => Effect.map(runtimeInfo(control, paths), (info) => ({ version, ...info })),
    "Host.Events": ({ answers, client }) => hub.events(answers, client),
    "Host.Clients": () => hub.clients,
    "Host.Plugins": () => Effect.map(control.plugins, (plugins) => plugins.map(toPluginStatus)),
    "Host.Inspectors": () => listInspectors(registries),
    // An inspector that fails or dies, or whose snapshot is not JSON, says so; it never takes the transport with it.
    "Host.Inspect": ({ id }) => inspectorSnapshot(registries, id),
    // Never deferred from here: the transport serving it, the one plugin a change from here waits for, is pinned, so it is
    // not restarted from here (`HostControl.restart` refuses to force a locked plugin).
    "Host.RestartPlugin": ({ pluginId, force }) =>
      control.restart(pluginId, force === undefined ? undefined : { force }).pipe(Effect.asVoid, Effect.mapError(toHostError)),
    "Host.Reload": () => control.reload.pipe(Effect.map(toReloadResult), Effect.mapError(toHostError)),
    "Host.Configure": ({ plugins, scope }) =>
      control.configure(plugins, scope === undefined ? undefined : { scope }).pipe(Effect.map(toReloadResult), Effect.mapError(toHostError)),

    "Web.Composition": () => control.web,

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
