import { createSignal } from "solid-js";
import type { ChannelInfo } from "@lemma/contracts";
import type { ClientService, SlotItem } from "@lemma/web";
import type { DevtoolsPanel, DevtoolsService } from "@lemma/devtools/web";
import { viewOf } from "./lazy.ts";

const ChannelsView = viewOf("ChannelsView");

/** The channels host plugins serve, listed on every connection and kept current from `channels-changed`. */
export function channelsPanel(client: ClientService, devtools: DevtoolsService, onCleanup: (fn: () => void) => void): SlotItem<DevtoolsPanel> {
  const [channels, setChannels] = createSignal<readonly ChannelInfo[]>([]);
  onCleanup(client.onConnect(() => void client.channel.list().then(setChannels, () => {})));
  onCleanup(
    client.onEvent((event) => {
      if (event.type === "channels-changed") setChannels(event.channels);
    }),
  );
  return {
    id: "devtools.channels",
    order: 16,
    title: "Channels",
    component: () => <ChannelsView devtools={devtools} channels={channels} />,
    snapshot: () => channels(),
  };
}
