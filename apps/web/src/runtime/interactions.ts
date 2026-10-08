import { createSignal } from "solid-js";
import type { Host } from "@lemma/client";
import type { InteractionAnswer, InteractionRequest } from "@lemma/contracts";
import type { ClientService, InteractionsService, NotifyService } from "../ui/runtime.ts";

/**
 * The runtime's `Interactions`: the questions the host is waiting on. Plugins
 * answer them, each the ones it claims (the question dialog takes the rest),
 * so the host's `Interaction` calls are this service's alone.
 */
export function createInteractions(
  host: Host,
  client: ClientService,
  notify: NotifyService,
): { readonly interactions: InteractionsService; readonly dispose: () => void } {
  const [open, setOpen] = createSignal<readonly InteractionRequest[]>([]);
  const [claims, setClaims] = createSignal<readonly ((request: InteractionRequest) => boolean)[]>([]);
  /** Ids closed while a list is in flight, so its reply cannot bring them back. */
  let closedSince: Set<string> | undefined;
  const close = (id: string) => {
    closedSince?.add(id);
    setOpen((all) => all.filter((request) => request.id !== id));
  };
  const stops = [
    client.onEvent((event) => {
      if (event.type === "interaction") setOpen((all) => [...all.filter((request) => request.id !== event.request.id), event.request]);
      else if (event.type === "interaction-closed") close(event.id);
    }),
    // Events only carry questions asked since the subscription began; each connection reads the ones already waiting.
    client.onConnect(() => {
      const closed = new Set<string>();
      closedSince = closed;
      void host.interaction.list().then(
        (requests) => {
          if (closedSince === closed) closedSince = undefined;
          setOpen((all) => [...requests.filter((request) => !closed.has(request.id) && !all.some((known) => known.id === request.id)), ...all]);
        },
        (error) => notify.report(error, "Sync failed"),
      );
    }),
    // Questions may close while no connection can report it; the next subscription replays the ones still open.
    host.onStatus((status) => {
      if (status.state === "reconnecting") setOpen([]);
    }),
  ];
  return {
    interactions: {
      open,
      answer: (id: string, answer: InteractionAnswer) => {
        close(id);
        host.interaction.answer(id, answer).catch((error) => notify.report(error));
      },
      dismiss: (id: string) => {
        close(id);
        host.interaction.dismiss(id).catch((error) => notify.report(error));
      },
      claim: (which: (request: InteractionRequest) => boolean = () => true) => {
        // A fresh function per claim, so releasing removes this one only.
        const claim = (request: InteractionRequest) => which(request);
        setClaims((all) => [...all, claim]);
        return () => setClaims((all) => all.filter((other) => other !== claim));
      },
      claimed: (request: InteractionRequest) => claims().some((claim) => claim(request)),
    },
    dispose: () => {
      for (const stop of stops) stop();
    },
  };
}
