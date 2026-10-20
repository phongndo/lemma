import { Effect } from "effect";
import { definePlugin, Registries } from "@lemma/core";
import { Channels, HostControl, inspectorSnapshot, listInspectors, Paths, runtimeInfo, serveChannel, toPluginStatus } from "@lemma/contracts";
import type { PluginStatus } from "@lemma/contracts";
import { HostChannels, redactJson, redactTexts } from "@lemma/devtools";

/**
 * Serves the host's own state as channels (`HostChannels`): what the runtime's calls give the web app and the `lemma`
 * command, for whatever reaches channels instead, an agent's script among them. It only reads, and what it serves
 * leaves with its secrets hidden: an inspector's by field name and in its text, a plugin's in its text.
 */
export default definePlugin({
  id: "devtools.host",
  version: "0.1.0",
  requires: { control: HostControl, paths: Paths },
  setup: function* ({ control, paths }, owner) {
    const registries = yield* Registries;
    yield* owner.add(
      Channels,
      serveChannel(HostChannels.info, () => runtimeInfo(control, paths)),
    );
    yield* owner.add(
      Channels,
      serveChannel(HostChannels.plugins, ({ ids }) =>
        Effect.map(control.plugins, (plugins) =>
          (ids === undefined ? plugins : plugins.filter((plugin) => ids.includes(plugin.id))).map(
            (plugin) => redactTexts(toPluginStatus(plugin)) as PluginStatus,
          ),
        ),
      ),
    );
    yield* owner.add(
      Channels,
      serveChannel(HostChannels.inspectors, () => listInspectors(registries)),
    );
    // A tab's URL, say, can carry a token or a login's code: whoever reaches the channel is not the person who opened it.
    yield* owner.add(
      Channels,
      serveChannel(HostChannels.inspect, ({ id }) => Effect.map(inspectorSnapshot(registries, id), redactJson)),
    );
  },
});
