import { createSignal } from "solid-js";
import { follow } from "@lemma/client";
import type { ConnectionStatus, Host } from "@lemma/client";
import type { HostError, HostInfo } from "@lemma/contracts/runtime";
import type { ClientService } from "../ui/runtime.ts";

/**
 * The page's one connection as the runtime's `Client`, for as long as the
 * page runs: nothing a plugin does reconnects it. Models resync on every
 * reconnect, and follow the subsystems' streams through it.
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
  const onConnect = (sync: () => void) => {
    syncs.add(sync);
    if (connected()) run(sync);
    return () => void syncs.delete(sync);
  };
  return {
    client: {
      status,
      connected,
      info,
      onEvent: host.onEvent,
      onConnect,
      channel: host.channel,
      // The reopen policy every client of the host's streams shares, over this connection.
      follow: ((target: string, payload: unknown, onElement: (element: unknown) => void, onEnd?: (error?: HostError | Error) => void) =>
        follow(host, target, payload, onElement, onEnd)) as ClientService["follow"],
      plugins: () => host.host.plugins(),
      restartPlugin: (pluginId, options) => host.host.restartPlugin(pluginId, options?.force === undefined ? undefined : { force: options.force }),
      reload: () => host.host.reload(),
      configure: (plugins, options) => host.host.configure(plugins, options?.scope === undefined ? undefined : { scope: options.scope }),
      configureBundles: (bundles, options) => host.host.configureBundles(bundles, options?.scope === undefined ? undefined : { scope: options.scope }),
      inspectors: () => host.host.inspectors(),
      inspect: (id) => host.host.inspect(id),
      ui: {
        composition: () => host.ui.composition(),
        configure: (plugins, options) => host.ui.configure(plugins, options?.scope === undefined ? undefined : { scope: options.scope }),
      },
    },
    dispose,
  };
}
