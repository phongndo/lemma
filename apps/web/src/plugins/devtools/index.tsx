import { For, Show, createEffect, createSignal } from "solid-js";
import { withKeys } from "../../lib/keys.ts";
import { shownKeys } from "../../model/keybindings.ts";
import { ActionIds, Actions, Client, Devtools, DevtoolsPanels, Docks, HostPlugins, Router, Slots, UiPlugins } from "../../ui/contracts.ts";
import type { DevtoolsService } from "../../ui/contracts.ts";
import { defineUiPlugin } from "../../ui/define.ts";
import { CodeIcon, Contained, LogIcon, XIcon } from "../../ui/parts.tsx";
import styles from "./devtools.css?inline";
import { EVENTS_PANEL, hostEventsPanel } from "./events.tsx";
import { kernelPanels } from "./kernel.tsx";
import { routePanels } from "./routes.tsx";

const STATE_KEY = "lemma.devtools";
const TOGGLE_KEYS = "mod+shift+d";
const MIN_HEIGHT = 160;

interface Saved {
  readonly open: boolean;
  readonly panel?: string | undefined;
  readonly height: number;
}
const load = (): Saved => {
  try {
    return { open: false, height: 320, ...(JSON.parse(sessionStorage.getItem(STATE_KEY) ?? "{}") as Partial<Saved>) };
  } catch {
    return { open: false, height: 320 };
  }
};

/**
 * The devtools: a panel docked under the app (`mod+shift+d`), whose tabs are
 * the `DevtoolsPanels` items. They look into the app as it runs and never
 * change what it does. Its own panels (the router, the host's events, and both
 * kernels' plugins, hooks, registries, and inspectors) are added there like any
 * plugin's. Whether they are open, and at which panel, lasts the tab's life.
 */
export default defineUiPlugin({
  id: "devtools",
  styles,
  requires: { slots: Slots, router: Router, client: Client, ui: UiPlugins, host: HostPlugins },
  provides: { devtools: Devtools },
  setup: ({ slots, router, client, ui, host }, plugin) => {
    const saved = load();
    const [open, setOpen] = createSignal(saved.open);
    const [panel, setPanel] = createSignal(saved.panel);
    const [height, setHeight] = createSignal(saved.height);
    createEffect(() => {
      try {
        sessionStorage.setItem(STATE_KEY, JSON.stringify({ open: open(), panel: panel(), height: height() }));
      } catch {
        // Storage off: they stay as they are for this page.
      }
    });

    const panels = () => slots.list(DevtoolsPanels);
    const current = () => panels().find((item) => item.id === panel()) ?? panels()[0];

    function Dock() {
      const resize = (event: PointerEvent) => {
        event.preventDefault();
        const move = (moved: PointerEvent) =>
          setHeight(Math.round(Math.min(window.innerHeight * 0.85, Math.max(MIN_HEIGHT, window.innerHeight - moved.clientY))));
        const stop = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", stop);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", stop);
      };
      return (
        <section class="devtools dt-scope" aria-label="Devtools" style={{ height: `${height()}px` }}>
          <div class="devtools-resize" role="separator" aria-orientation="horizontal" aria-label="Resize the devtools" onPointerDown={resize} />
          <div class="dt-tabs" role="tablist" aria-label="Devtools panels">
            <For each={panels()}>
              {(item) => (
                <button role="tab" class="dt-tab" aria-selected={current()?.id === item.id} onClick={() => setPanel(item.id)}>
                  {item.title}
                </button>
              )}
            </For>
            <span class="devtools-spacer" />
            <button
              class="dt-close"
              aria-label="Close the devtools"
              data-tip={withKeys("Close", shownKeys({ id: "devtools.toggle", keys: TOGGLE_KEYS }, ui.list()))}
              onClick={() => setOpen(false)}
            >
              <XIcon />
            </button>
          </div>
          <div class="devtools-body" role="tabpanel">
            <Show when={current()} keyed fallback={<p class="dt-empty">No panels: the plugins that add them are off.</p>}>
              {(item) => <Contained slot={DevtoolsPanels} item={item} component={item.component} />}
            </Show>
          </div>
        </section>
      );
    }

    // Docked: the app shrinks to the space above them, as a browser's own devtools do.
    slots.add(Docks, {
      id: "devtools",
      component: () => (
        <Show when={open()}>
          <Dock />
        </Show>
      ),
    });
    const toggle = (next?: boolean) => setOpen(next ?? !open());
    const [subjects, setSubjects] = createSignal<Readonly<Record<string, string>>>({});
    slots.add(Actions, {
      id: "devtools.toggle",
      order: 9,
      title: "Toggle devtools",
      category: "Developer",
      keywords: ["inspect", "debug", "routes", "slots", "capabilities"],
      icon: CodeIcon,
      keys: TOGGLE_KEYS,
      whileTyping: true,
      global: true,
      run: () => toggle(),
    });

    const devtools: DevtoolsService = {
      open,
      toggle,
      show: (id: string, subject?: string) => {
        if (subject !== undefined) setSubjects({ ...subjects(), [id]: subject });
        setPanel(id);
        setOpen(true);
      },
      subject: (id: string) => subjects()[id],
      snapshot: () => Object.fromEntries(panels().flatMap((item) => (item.snapshot === undefined ? [] : [[item.id, item.snapshot()]]))),
    };

    // Its own panels go through the slot a plugin's would.
    const panelsMade = [
      ...routePanels(router, slots, devtools),
      hostEventsPanel(client, router, plugin.onCleanup),
      ...kernelPanels({ slots, router, devtools, client, lists: { web: ui.list, host: host.list }, runtime: { web: ui.runtime, host: host.runtime } }),
    ];
    for (const item of panelsMade) slots.add(DevtoolsPanels, item);
    slots.add(Actions, {
      id: ActionIds.eventLog,
      order: 10,
      title: "Show host events",
      category: "Developer",
      keywords: ["debug", "events", "stream", "log", "devtools"],
      icon: LogIcon,
      run: () => devtools.show(EVENTS_PANEL),
    });
    return { devtools };
  },
});
