import { Show, createSignal } from "solid-js";
import { describeReload } from "@lemma/contracts";
import { Actions, Client, Notify, SidebarFooter, Slots } from "../ui/contracts.ts";
import { defineUiPlugin } from "../ui/define.ts";
import { RefreshIcon, Spinner } from "../ui/parts.tsx";
import styles from "./reload.css?inline";

const ACTION = "reload.app";
/** What a host reload changed, for the page it reloads to show: the page that asked is gone by then. Per tab. */
const REPORT_KEY = "lemma.reload.report";
/** How long the page waits for a deferred host reload to apply before reloading anyway (ms). */
const APPLY_MS = 10_000;

/** The desktop app's bridge (`window.lemmaDesktop` in `ui/contracts.ts`), when the page is in its window. */
const desktop = (window as Window & { lemmaDesktop?: { readonly ownsHost: boolean; readonly reload: () => Promise<void> } }).lemmaDesktop;

const leaveReport = (summary: string) => {
  try {
    sessionStorage.setItem(REPORT_KEY, summary);
  } catch {
    // Storage off: the page reloads without saying what changed.
  }
};
const takeReport = (): string | undefined => {
  try {
    const summary = sessionStorage.getItem(REPORT_KEY) ?? undefined;
    sessionStorage.removeItem(REPORT_KEY);
    return summary;
  } catch {
    return undefined;
  }
};

/**
 * Loads what changed without leaving the app: the host first (the desktop app restarts one it started; any other
 * re-reads its config and plugin files), then the page. An action, so the palette lists it and keys can run it, and a
 * button in the sidebar's footer beside the connection's dot.
 */
export default defineUiPlugin({
  id: "reload",
  styles,
  requires: { client: Client, slots: Slots, notify: Notify },
  setup: ({ client, slots, notify }) => {
    const left = takeReport();
    if (left !== undefined) notify.toast({ level: "info", message: `Reloaded: ${left}` });
    const [reloading, setReloading] = createSignal(false);
    /**
     * Hears, from now on, the connection coming back after it dropped: a
     * reload the host defers is one that restarts the transport serving the
     * request, so it has applied once the page has a new connection. `done` is
     * true once it has one, false after `APPLY_MS`.
     */
    const reconnected = () => {
      const generation = client.status().generation;
      let settle!: (applied: boolean) => void;
      const done = new Promise<boolean>((resolve) => (settle = resolve));
      const timer = setTimeout(() => settle(false), APPLY_MS);
      const stop = client.onConnect(() => {
        if (client.status().generation > generation) settle(true);
      });
      return {
        done,
        stop: () => {
          clearTimeout(timer);
          stop();
        },
      };
    };
    const reload = async () => {
      if (reloading()) return;
      setReloading(true);
      try {
        if (desktop?.ownsHost) return await desktop.reload();
        if (client.connected()) {
          const back = reconnected();
          try {
            const result = await client.reload();
            // A plugin the reload left failed stays on screen, rather than a page reload passing over it.
            if ((result.failed?.length ?? 0) > 0) {
              notify.toast({ level: "error", message: `Reload: ${describeReload(result) ?? "nothing changed"}. The Plugins page says why.` });
              return;
            }
            // Deferred: it applies once this reply has left, restarting the transport, which drops the connection. The page
            // reloads once the connection is back, so it connects once, to what the change made, rather than twice.
            if (!result.deferred) leaveReport(describeReload(result) ?? "nothing changed");
            else leaveReport((await back.done) ? "the host applied the change" : "the host is still applying the change");
          } finally {
            back.stop();
          }
        }
        window.location.reload();
      } catch (error) {
        notify.report(error, "Could not reload Lemma");
      } finally {
        setReloading(false);
      }
    };
    const detail = desktop?.ownsHost ? "Restart the host, then the window" : "Re-read config and plugin files, then the page";

    slots.add(Actions, {
      id: ACTION,
      title: "Reload Lemma",
      category: "Host",
      detail,
      keywords: ["refresh", "restart", "hot reload", "plugins", "config"],
      icon: RefreshIcon,
      run: () => void reload(),
    });
    slots.add(SidebarFooter, {
      id: "reload",
      // After the connection's dot (100), which also pushes both to the right.
      order: 110,
      component: () => (
        <button
          class="icon-button reload-button"
          aria-label="Reload Lemma"
          aria-busy={reloading()}
          disabled={reloading()}
          data-tip={`Reload: ${detail.toLowerCase()}`}
          onClick={() => slots.get(Actions, ACTION)?.run()}
        >
          <Show when={reloading()} fallback={<RefreshIcon />}>
            <Spinner />
          </Show>
        </button>
      ),
    });
  },
});
