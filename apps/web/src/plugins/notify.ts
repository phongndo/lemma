import { createSignal } from "solid-js";
import { describeError } from "@lemma/client";
import { Client, Notify } from "../ui/contracts.ts";
import type { Toast } from "../ui/contracts.ts";
import { defineUiPlugin } from "../ui/define.ts";

/**
 * Messages for the user: the app's own, and the host's notices (login
 * progress, faults, reloads). The model only; the `toasts` plugin draws them,
 * so the drawing can be turned off or replaced while everything that reports
 * keeps working.
 */
export default defineUiPlugin({
  id: "notify",
  requires: { client: Client },
  provides: { notify: Notify },
  setup: ({ client }, plugin) => {
    const [toasts, setToasts] = createSignal<readonly Toast[]>([]);
    const [claims, setClaims] = createSignal<readonly ((toast: Toast) => boolean)[]>([]);
    const timers = new Set<number>();
    let seq = 0;
    const dismiss = (id: number) => setToasts((all) => all.filter((toast) => toast.id !== id));
    const toast = (notice: Omit<Toast, "id">): number => {
      const id = ++seq;
      setToasts((all) => [...all.slice(-5), { ...notice, id }]);
      // A code or link is something to act on; it stays until dismissed or its login ends.
      if (notice.code === undefined && (notice.links === undefined || notice.links.length === 0)) {
        const timer = window.setTimeout(
          () => {
            timers.delete(timer);
            dismiss(id);
          },
          notice.level === "error" ? 12_000 : notice.level === "warning" ? 8_000 : 5_000,
        );
        timers.add(timer);
      }
      return id;
    };
    plugin.onCleanup(() => {
      for (const timer of timers) window.clearTimeout(timer);
    });
    plugin.onCleanup(
      client.onEvent((event) => {
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
      }),
    );
    return {
      notify: {
        toasts,
        toast,
        dismiss,
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
    };
  },
});
