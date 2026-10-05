import { For, Show, createEffect, createSignal } from "solid-js";
import { Actions, Devtools, DevtoolsPanels, Docks, Slots } from "../ui/contracts.ts";
import { defineUiPlugin } from "../ui/define.ts";
import { CodeIcon, Contained, XIcon } from "../ui/parts.tsx";
import styles from "./devtools.css?inline";

const STATE_KEY = "lemma.devtools";
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
 * the `DevtoolsPanels` items. They look into the app as it runs (the router,
 * slots, capabilities, and whatever a plugin adds) and never change what it
 * does. Whether they are open, and at which panel, lasts the tab's life.
 */
export default defineUiPlugin({
  id: "devtools",
  styles,
  requires: { slots: Slots },
  provides: { devtools: Devtools },
  setup: ({ slots }, plugin) => {
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
            <button class="dt-close" aria-label="Close the devtools" data-tip="Close · mod+shift+d" onClick={() => setOpen(false)}>
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
    plugin.onCleanup(
      slots.add(Docks, {
        id: "devtools",
        component: () => (
          <Show when={open()}>
            <Dock />
          </Show>
        ),
      }),
    );
    const toggle = (next?: boolean) => setOpen(next ?? !open());
    const [subjects, setSubjects] = createSignal<Readonly<Record<string, string>>>({});
    plugin.onCleanup(
      slots.add(Actions, {
        id: "devtools.toggle",
        order: 9,
        title: "Toggle devtools",
        category: "Developer",
        keywords: ["inspect", "debug", "routes", "slots", "capabilities"],
        icon: CodeIcon,
        keys: "mod+shift+d",
        whileTyping: true,
        global: true,
        run: () => toggle(),
      }),
    );

    return {
      devtools: {
        open,
        toggle,
        show: (id: string, subject?: string) => {
          if (subject !== undefined) setSubjects({ ...subjects(), [id]: subject });
          setPanel(id);
          setOpen(true);
        },
        subject: (id: string) => subjects()[id],
        snapshot: () => Object.fromEntries(panels().flatMap((item) => (item.snapshot === undefined ? [] : [[item.id, item.snapshot()]]))),
      },
    };
  },
});
