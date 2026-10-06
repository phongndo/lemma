import { Show, createSignal } from "solid-js";
import { describeReload } from "@lemma/contracts";
import { Actions, Client, Notify, SidebarFooter, Slots } from "../ui/contracts.ts";
import { defineUiPlugin } from "../ui/define.ts";
import { RefreshIcon, Spinner } from "../ui/parts.tsx";
import styles from "./reload.css?inline";

const ACTION = "reload.app";
/** What a host reload changed, for the page it reloads to show: the page that asked is gone by then. Per tab. */
const REPORT_KEY = "lemma.reload.report";

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
  setup: ({ client, slots, notify }, plugin) => {
    const left = takeReport();
    if (left !== undefined) notify.toast({ level: "info", message: `Reloaded: ${left}` });
    const [reloading, setReloading] = createSignal(false);
    const reload = async () => {
      if (reloading()) return;
      setReloading(true);
      try {
        if (desktop?.ownsHost) return await desktop.reload();
        if (client.connected()) {
          const result = await client.host.host.reload();
          // A plugin the reload left failed stays on screen, rather than a page reload passing over it.
          if ((result.failed?.length ?? 0) > 0) {
            notify.toast({ level: "error", message: `Reload: ${describeReload(result) ?? "nothing changed"}. The Plugins page says why.` });
            return;
          }
          leaveReport(describeReload(result) ?? "nothing changed");
        }
        window.location.reload();
      } catch (error) {
        notify.report(error, "Could not reload Lemma");
      } finally {
        setReloading(false);
      }
    };
    const detail = desktop?.ownsHost ? "Restart the host, then the window" : "Re-read config and plugin files, then the page";

    plugin.onCleanup(
      slots.add(Actions, {
        id: ACTION,
        title: "Reload Lemma",
        category: "Host",
        detail,
        keywords: ["refresh", "restart", "hot reload", "plugins", "config"],
        icon: RefreshIcon,
        run: () => void reload(),
      }),
    );
    plugin.onCleanup(
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
      }),
    );
  },
});
