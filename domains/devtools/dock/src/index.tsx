import { For, Show, createEffect, createSignal, createUniqueId } from "solid-js";
import { dragEdge } from "@lemma/web/drag";
import { radioStep, typing, withKeys } from "@lemma/web/keys";
import { shownKeys, Actions } from "@lemma/actions";
import { Docks } from "@lemma/frame";
import { Client, HostPlugins, Router, Slots, WebPlugins, defineWebPlugin, Contained } from "@lemma/web";
import { Devtools, DEVTOOLS_CONTRACT, DevtoolsActionIds, DevtoolsPanels } from "@lemma/devtools/web";
import type { DevtoolsService } from "@lemma/devtools/web";
import { CodeIcon, LogIcon, XIcon } from "@lemma/look";
import styles from "./devtools.css?inline";
import { channelsPanel } from "./channels.tsx";
import { EVENTS_PANEL, hostEventsPanel } from "./events.tsx";
import { kernelPanels } from "./kernel.tsx";
import { routePanels } from "./routes.tsx";

const STATE_KEY = "lemma.devtools";
const TOGGLE_KEYS = "mod+shift+d";
const MIN_HEIGHT = 160;
const HEIGHT = 320;
/** How far ↑ or ↓ moves the dock's top edge, focused. */
const STEP = 16;

interface Saved {
  readonly open: boolean;
  readonly panel?: string | undefined;
  readonly height: number;
}
const load = (): Saved => {
  try {
    return { open: false, height: HEIGHT, ...(JSON.parse(sessionStorage.getItem(STATE_KEY) ?? "{}") as Partial<Saved>) };
  } catch {
    return { open: false, height: HEIGHT };
  }
};

/**
 * The devtools: a panel docked under the app (`mod+shift+d`), whose tabs are
 * the `DevtoolsPanels` items. They look into the app as it runs and never
 * change what it does. Its own panels (the router, the host's events and
 * streams, the channels host plugins serve, and both kernels' plugins, hooks,
 * registries, and inspectors) are added there like any
 * plugin's. Whether they are open, and at which panel, lasts the tab's life.
 */
export default defineWebPlugin({
  id: "devtools.dock",
  implements: [DEVTOOLS_CONTRACT],
  styles,
  requires: { slots: Slots, router: Router, client: Client, webPlugins: WebPlugins, host: HostPlugins },
  provides: { devtools: Devtools },
  setup: ({ slots, router, client, webPlugins, host }, plugin) => {
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
      const [resizing, setResizing] = createSignal(false);
      const fit = (next: number) => setHeight(Math.round(Math.min(window.innerHeight * 0.85, Math.max(MIN_HEIGHT, next))));
      // Its top edge's drag sets its height from the pointer, which the edge holds, so a move over a frame still counts.
      const resize = (event: PointerEvent) => {
        if (dragEdge(event, { move: (moved) => fit(window.innerHeight - moved.clientY), end: () => setResizing(false) })) setResizing(true);
      };
      const resizeKeys = (event: KeyboardEvent) => {
        const by = event.key === "ArrowUp" ? STEP : event.key === "ArrowDown" ? -STEP : undefined;
        if (by === undefined && event.key !== "Enter") return;
        event.preventDefault();
        // Enter resets it, as a double-click does.
        if (by === undefined) setHeight(HEIGHT);
        else fit(height() + by);
      };
      // The tabs are one Tab stop, the shown one's; arrows, Home, and End move between them, as a tab list's do.
      const id = createUniqueId();
      let strip!: HTMLDivElement;
      const tabKeys = (event: KeyboardEvent) => {
        if (event.key === "ArrowUp" || event.key === "ArrowDown") return;
        const list = panels();
        const index = radioStep(
          event.key,
          list.findIndex((item) => item.id === current()?.id),
          list.length,
        );
        if (index === undefined || list[index] === undefined) return;
        event.preventDefault();
        setPanel(list[index].id);
        strip.querySelectorAll<HTMLElement>("[role=tab]")[index]?.focus();
      };
      // "/" (when not typing) and Ctrl/Cmd+F go to the shown panel's filter, as in a browser's devtools, never to the
      // app's (the prompt, the thread's find bar), which leaves a key handled here alone. A panel without one has none.
      let body!: HTMLDivElement;
      const findKeys = (event: KeyboardEvent) => {
        const find = event.key === "f" && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey;
        if (!find && !(event.key === "/" && !typing(event.target))) return;
        event.preventDefault();
        event.stopPropagation();
        const filter = body.querySelector<HTMLInputElement>(".dt-filter input");
        filter?.focus();
        filter?.select();
      };
      // The dock is not a `.dt-scope`, as each panel is: focus on its edge, tabs, or close button is not focus in a panel's
      // table (`:focus-within`), whose selected row stays as it is.
      return (
        <section
          class="devtools"
          classList={{ "devtools-resizing": resizing() }}
          aria-label="Devtools"
          style={{ height: `${height()}px` }}
          onKeyDown={findKeys}
        >
          <div
            class="devtools-resize"
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize the devtools"
            aria-valuenow={height()}
            aria-valuemin={MIN_HEIGHT}
            aria-valuemax={Math.round(window.innerHeight * 0.85)}
            tabindex="0"
            data-tip="Drag to resize · double-click to reset"
            onPointerDown={resize}
            onDblClick={() => setHeight(HEIGHT)}
            onKeyDown={resizeKeys}
          />
          <div class="dt-tabs" role="tablist" aria-label="Devtools panels" ref={strip} onKeyDown={tabKeys}>
            <For each={panels()}>
              {(item) => (
                <button
                  role="tab"
                  class="dt-tab"
                  id={`${id}-${item.id}`}
                  aria-selected={current()?.id === item.id}
                  aria-controls={`${id}-panel`}
                  tabindex={current()?.id === item.id ? 0 : -1}
                  onClick={() => setPanel(item.id)}
                >
                  {item.title}
                </button>
              )}
            </For>
            <span class="devtools-spacer" />
            <button
              class="dt-close"
              aria-label="Close the devtools"
              data-tip={withKeys("Close", shownKeys({ id: "devtools.toggle", keys: TOGGLE_KEYS }, webPlugins.list()))}
              onClick={() => setOpen(false)}
            >
              <XIcon />
            </button>
          </div>
          <div
            class="devtools-body"
            role="tabpanel"
            id={`${id}-panel`}
            aria-labelledby={current() === undefined ? undefined : `${id}-${current()!.id}`}
            ref={body}
          >
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
      hostEventsPanel(client, router, open, plugin.onCleanup),
      channelsPanel(client, devtools, plugin.onCleanup),
      ...kernelPanels({
        slots,
        router,
        devtools,
        client,
        lists: { web: webPlugins.list, host: host.list },
        runtime: { web: webPlugins.runtime, host: host.runtime },
        contracts: webPlugins.contracts,
      }),
    ];
    for (const item of panelsMade) slots.add(DevtoolsPanels, item);
    slots.add(Actions, {
      id: DevtoolsActionIds.eventLog,
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
