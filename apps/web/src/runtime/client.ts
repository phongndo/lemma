import { createSignal } from "solid-js";
import type { ConnectionStatus } from "@lemma/client";
import { HostError } from "@lemma/contracts";
import type { ChannelDeclaration, HostEvent, HostInfo } from "@lemma/contracts";
import type { ClientService, HostConnection, RuntimeEvent } from "../ui/runtime.ts";

/** What `Client.onEvent` passes on. */
const RUNTIME_EVENTS: ReadonlySet<HostEvent["type"]> = new Set<RuntimeEvent["type"]>([
  "notice",
  "plugins-changed",
  "channels-changed",
  "ui-changed",
  "interaction",
  "interaction-closed",
]);
const isRuntime = (event: HostEvent): event is RuntimeEvent => RUNTIME_EVENTS.has(event.type);

/** Calls a listener of a plugin's; one that throws is logged, and never ends what feeds it. */
const safely = <A>(listener: (value: A) => void, value: A) => {
  try {
    listener(value);
  } catch (error) {
    console.error("lemma ui: a listener failed", error);
  }
};

/**
 * The page's one connection as the runtime's `Client`, for as long as the
 * page runs: nothing a plugin does reconnects it. Models resync on every
 * reconnect, and follow the subsystems' streams through it.
 */
export function createClient(host: HostConnection): { readonly client: ClientService; readonly dispose: () => void } {
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
  const onEvent = (listener: (event: RuntimeEvent) => void) =>
    host.onEvent((event) => {
      if (isRuntime(event)) listener(event);
    });

  const follow = (target: string | ChannelDeclaration, payload: unknown, onElement: (element: any) => void, onEnd?: (error?: HostError | Error) => void) => {
    const id = typeof target === "string" ? target : target.id;
    /** The open stream's close, while one is open. */
    let current: (() => void) | undefined;
    let stopped = false;
    const open = () => {
      current?.();
      current = undefined;
      if (stopped || !connected()) return;
      let live = true;
      const close = host.channel.open(
        target as string,
        typeof payload === "function" ? (payload as () => unknown)() : payload,
        (element) => {
          if (live) safely(onElement, element);
        },
        (error) => {
          if (!live) return;
          live = false;
          current = undefined;
          if (onEnd !== undefined) safely(onEnd, error);
          // Its plugin left: whatever answers for it now, at once; else `channels-changed` says when one does.
          if (error instanceof HostError && error.code === "Withdrawn") open();
        },
      );
      if (live)
        current = () => {
          live = false;
          close();
        };
    };
    const stops = [
      onConnect(open),
      host.onEvent((event) => {
        if (event.type === "channels-changed" && current === undefined && event.channels.some((channel) => channel.id === id)) open();
      }),
    ];
    return () => {
      stopped = true;
      current?.();
      current = undefined;
      for (const stop of stops) stop();
    };
  };

  return {
    client: {
      status,
      connected,
      info,
      onEvent,
      onConnect,
      channel: host.channel,
      follow,
      plugins: () => host.host.plugins(),
      restartPlugin: (pluginId, options) => host.host.restartPlugin(pluginId, options?.force === undefined ? undefined : { force: options.force }),
      reload: () => host.host.reload(),
      configure: (plugins, options) => host.host.configure(plugins, options?.scope === undefined ? undefined : { scope: options.scope }),
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
