import { createSignal } from "solid-js";
import { describeError } from "@lemma/client";
import type { ClientService, NotifyService, Toast } from "../ui/runtime.ts";

/** How many messages it keeps: past these the oldest leave, so they cannot pile up while nothing draws them. */
const KEPT = 50;

/**
 * The runtime's `Notify`: the app's messages and the host's notices, kept
 * until dismissed. It decides nothing about showing them; the plugin that
 * draws them (`toasts`) does, dismissing each when its time is up.
 */
export function createNotify(client: ClientService): { readonly notify: NotifyService; readonly dispose: () => void } {
  const [toasts, setToasts] = createSignal<readonly Toast[]>([]);
  const [claims, setClaims] = createSignal<readonly ((toast: Toast) => boolean)[]>([]);
  let seq = 0;
  const toast = (notice: Omit<Toast, "id">): number => {
    const id = ++seq;
    setToasts((all) => [...all.slice(1 - KEPT), { ...notice, id }]);
    return id;
  };
  const dispose = client.onEvent((event) => {
    if (event.type !== "notice") return;
    const { level, message, source, links, code, origin, kind } = event.notice;
    toast({
      level,
      message,
      ...(source === undefined ? {} : { source }),
      ...(links === undefined ? {} : { links }),
      ...(code === undefined ? {} : { code }),
      ...(origin === undefined ? {} : { origin }),
      ...(kind === undefined ? {} : { kind }),
    });
  });
  return {
    notify: {
      toasts,
      toast,
      dismiss: (id: number) => setToasts((all) => all.filter((toast) => toast.id !== id)),
      dismissWhere: (drop: (toast: Toast) => boolean) => setToasts((all) => all.filter((item) => !drop(item))),
      report: (error: unknown, context?: string) =>
        void toast({ level: "error", message: context === undefined ? describeError(error) : `${context}: ${describeError(error)}` }),
      claim: (which: (toast: Toast) => boolean) => {
        // A fresh function per claim, so releasing removes this one only.
        const claim = (toast: Toast) => which(toast);
        setClaims((all) => [...all, claim]);
        return () => setClaims((all) => all.filter((other) => other !== claim));
      },
      claimed: (toast: Toast) => claims().some((claim) => claim(toast)),
    },
    dispose,
  };
}
