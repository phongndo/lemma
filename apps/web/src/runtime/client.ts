import { createSignal } from "solid-js";
import type { ConnectionStatus, Host } from "@lemma/client";
import type { HostEvent, HostInfo } from "@lemma/contracts";
import type { ClientService } from "../ui/runtime.ts";

/**
 * The page's one `Host` as the runtime's `Client`, for as long as the page
 * runs: nothing a plugin does reconnects it. Models listen here for events
 * and resync on every reconnect.
 */
export function createClient(host: Host): { readonly client: ClientService; readonly dispose: () => void } {
  const [status, setStatus] = createSignal<ConnectionStatus>(host.status());
  const [info, setInfo] = createSignal<HostInfo>();
  const syncs = new Set<() => void>();
  const connected = () => status().state === "connected";
  let generation = 0;
  // One model's resync failing leaves the others' to run.
  const run = (sync: () => void) => {
    try {
      sync();
    } catch (error) {
      console.error("lemma ui: a resync failed", error);
    }
  };
  const dispose = host.onStatus((next) => {
    setStatus(next);
    if (next.state !== "connected" || next.generation === generation) return;
    generation = next.generation;
    void host.host.info().then(setInfo, () => {});
    for (const sync of syncs) run(sync);
  });
  return {
    client: {
      host,
      status,
      connected,
      info,
      onEvent: (listener: (event: HostEvent) => void) => host.onEvent(listener),
      onConnect: (sync: () => void) => {
        syncs.add(sync);
        if (connected()) run(sync);
        return () => void syncs.delete(sync);
      },
    },
    dispose,
  };
}
