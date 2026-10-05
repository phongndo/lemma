import { Show, createSignal, onCleanup, onMount } from "solid-js";
import { load, save } from "../lib/storage.ts";
import { Actions, Docks, Layers, Layout, MainRegion, Root, SidebarRegion, Slots } from "../ui/contracts.ts";
import { defineUiPlugin } from "../ui/define.ts";
import { Contained, Each, SidebarIcon } from "../ui/parts.tsx";
import styles from "./shell.css?inline";

const WIDTH_KEY = "lemma.sidebar.width";
const COLLAPSED_KEY = "lemma.sidebar.collapsed";
const DEFAULT_WIDTH = 264;
const MIN_WIDTH = 208;
const MAX_WIDTH = 400;
/** The conversation keeps at least this much room. */
const MIN_MAIN = 560;
const NARROW = "(max-width: 820px)";

/** Chromium's Window Controls Overlay: a desktop window (Electron) whose own controls sit over the page's top-left. */
interface ControlsOverlay extends EventTarget {
  readonly visible: boolean;
}
const controlsOverlay = (navigator as { windowControlsOverlay?: ControlsOverlay }).windowControlsOverlay;

const clampWidth = (width: number) => Math.round(Math.max(MIN_WIDTH, Math.min(width, MAX_WIDTH, Math.max(MIN_WIDTH, window.innerWidth - MIN_MAIN))));

/**
 * The page's frame: the sidebar region (resizable, collapsible, a drawer on
 * narrow screens), the main region, and every layer over them. It fills the
 * `root` slot; each region is whatever plugin fills it, so any can be left
 * empty or replaced.
 */
export default defineUiPlugin({
  id: "shell",
  styles,
  requires: { slots: Slots },
  provides: { layout: Layout },
  setup: ({ slots }, plugin) => {
    const [drawer, setDrawer] = createSignal(false);
    // The chosen width survives a narrower window; only the displayed width is clamped.
    const [chosen, setChosen] = createSignal(Number(load(WIDTH_KEY)) || DEFAULT_WIDTH);
    const [viewport, setViewport] = createSignal(window.innerWidth);
    const [collapsed, setCollapsed] = createSignal(load(COLLAPSED_KEY) === "1");
    const [resizing, setResizing] = createSignal(false);
    const [titlebar, setTitlebar] = createSignal(controlsOverlay?.visible === true);
    const width = () => {
      viewport();
      return clampWidth(chosen());
    };
    const setCollapsedSaved = (value: boolean) => {
      setCollapsed(value);
      save(COLLAPSED_KEY, value ? "1" : undefined);
    };
    /** On narrow screens the sidebar is a drawer; otherwise it collapses in place. */
    const toggleSidebar = () => (window.matchMedia(NARROW).matches ? setDrawer(!drawer()) : setCollapsedSaved(!collapsed()));
    const closeDrawer = () => setDrawer(false);

    plugin.onCleanup(
      slots.add(Actions, {
        id: "shell.toggle-sidebar",
        order: 4,
        title: "Toggle sidebar",
        category: "View",
        icon: SidebarIcon,
        keys: "mod+b",
        run: toggleSidebar,
      }),
    );
    plugin.onCleanup(
      slots.add(Actions, {
        id: "shell.close-drawer",
        title: "Close the sidebar",
        hidden: true,
        keys: "escape",
        whileTyping: true,
        order: 20,
        when: drawer,
        run: closeDrawer,
      }),
    );

    const startResize = (event: PointerEvent) => {
      event.preventDefault();
      const handle = event.currentTarget as HTMLElement;
      handle.setPointerCapture(event.pointerId);
      const startX = event.clientX;
      const startWidth = width();
      setResizing(true);
      const move = (next: PointerEvent) => setChosen(clampWidth(startWidth + next.clientX - startX));
      const end = () => {
        setResizing(false);
        save(WIDTH_KEY, String(chosen()));
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", end);
        handle.removeEventListener("pointercancel", end);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", end);
      handle.addEventListener("pointercancel", end);
    };
    const resetWidth = () => {
      setChosen(DEFAULT_WIDTH);
      save(WIDTH_KEY, undefined);
    };

    function Shell() {
      const onResize = () => setViewport(window.innerWidth);
      const onGeometry = () => setTitlebar(controlsOverlay?.visible === true);
      onMount(() => {
        window.addEventListener("resize", onResize);
        controlsOverlay?.addEventListener("geometrychange", onGeometry);
      });
      onCleanup(() => {
        window.removeEventListener("resize", onResize);
        controlsOverlay?.removeEventListener("geometrychange", onGeometry);
      });
      const sidebar = () => slots.first(SidebarRegion);
      const main = () => slots.first(MainRegion);
      return (
        <div class="frame">
          <div
            class="app"
            classList={{ "drawer-open": drawer(), "sidebar-collapsed": collapsed() || sidebar() === undefined, resizing: resizing() }}
            style={{ "--sidebar": `${width()}px` }}
            data-titlebar={titlebar() ? "" : undefined}
          >
            <Show when={sidebar()} keyed>
              {(region) => (
                <>
                  {/* The shell owns the sidebar's box (width, collapse, drawer); whatever fills the region only fills it. */}
                  <div class="sidebar-slot">
                    <Contained slot={SidebarRegion} item={region} component={region.component} props={{ onPick: closeDrawer }} />
                  </div>
                  <div
                    class="sidebar-rail"
                    role="separator"
                    aria-orientation="vertical"
                    aria-label="Resize sidebar"
                    data-tip="Drag to resize · double-click to reset"
                    onPointerDown={startResize}
                    onDblClick={resetWidth}
                  />
                </>
              )}
            </Show>
            <Show when={drawer()}>
              <div class="scrim" onClick={closeDrawer} />
            </Show>
            <div class="main-col">
              <Show when={main()} keyed>
                {(region) => <Contained slot={MainRegion} item={region} component={region.component} />}
              </Show>
            </div>
            <Each slot={Layers} />
          </div>
          {/* Docked under the app, which shrinks to the space left: each dock sizes itself. */}
          <Each slot={Docks} />
        </div>
      );
    }
    plugin.onCleanup(slots.add(Root, { id: "shell", component: Shell }));
    return { layout: { toggleSidebar, closeDrawer } };
  },
});
