import { createSignal } from "solid-js";
import type { PluginChange, PluginStatus } from "@lemma/contracts";
import type { ClientService, HostPluginsService, NotifyService } from "../ui/runtime.ts";

const NONE: readonly string[] = [];

/**
 * The runtime's `HostPlugins`: the host's plugins, kept current from
 * `plugins-changed`, and what the host provides itself (`HostInfo.runtime`).
 * Changes throw; whoever asked reports how it went.
 */
export function createHostPlugins(client: ClientService, notify: NotifyService): { readonly plugins: HostPluginsService; readonly dispose: () => void } {
  const host = client.host;
  const [list, setList] = createSignal<readonly PluginStatus[]>([]);
  const refresh = async () => {
    setList(await host.host.plugins());
  };
  const stops = [
    client.onConnect(() => void refresh().catch((error) => notify.report(error, "Sync failed"))),
    client.onEvent((event) => {
      if (event.type === "plugins-changed") setList(event.plugins);
    }),
  ];
  return {
    plugins: {
      list,
      runtime: () => client.info()?.runtime ?? NONE,
      refresh,
      restart: async (target: PluginStatus, options?: { force?: boolean }) => {
        await host.host.restartPlugin(target.id, options?.force ? { force: true } : undefined);
        await refresh();
      },
      // The row goes where `enabled` is set now: the user file unless the project file decides.
      setEnabled: async (target: PluginStatus, enabled: boolean) => {
        const result = await host.host.configure({ [target.id]: { enabled } }, target.scope === "project" ? { scope: "project" } : undefined);
        if (!result.deferred) await refresh();
        return result;
      },
      setConfig: async (target: PluginStatus, values: Readonly<Record<string, unknown>>) => {
        const result = await host.host.configure({ [target.id]: { values } }, target.configScope === "project" ? { scope: "project" } : undefined);
        if (!result.deferred) await refresh();
        return result;
      },
      edit: async (target: PluginStatus, change: Pick<PluginChange, "add" | "remove">) => {
        const result = await host.host.configure({ [target.id]: change }, target.configScope === "project" ? { scope: "project" } : undefined);
        if (!result.deferred) await refresh();
        return result;
      },
      reload: async () => {
        const result = await host.host.reload();
        await refresh();
        return result;
      },
    },
    dispose: () => {
      for (const stop of stops) stop();
    },
  };
}
