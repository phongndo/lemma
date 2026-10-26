import { Show, createSignal, onCleanup } from "solid-js";
import { load, save } from "@lemma/web/storage";
import { dragEdge } from "@lemma/web/drag";
import { onLookChange, tokenColor } from "@lemma/web/paint";
import { Actions } from "@lemma/actions";
import { Docks, FRAME_CONTRACT, Layers, Layout, MainRegion, SidebarRegion, nothingFocused } from "@lemma/frame";
import { Root, Slots, defineWebPlugin, Contained, Each } from "@lemma/web";
import { SidebarIcon } from "@lemma/look";
import styles from "./shell.css?inline";

const WIDTH_KEY = "lemma.sidebar.width";
const COLLAPSED_KEY = "lemma.sidebar.collapsed";
const DEFAULT_WIDTH = 264;
const MIN_WIDTH = 208;
const MAX_WIDTH = 400;
/** What ← and → move its edge by, while it has focus. */
const WIDTH_STEP = 16;
/** The conversation keeps at least this much room. */
const MIN_MAIN = 560;
/** A drawer leaves this much of the page beside it, to close it by. */
const DRAWER_GAP = 48;
const NARROW = "(max-width: 820px)";
/** The controls that toggle the sidebar (`LayoutService.toggleSidebar`). */
const TOGGLES = "[data-sidebar-toggle]";
const FOCUSABLE = "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])";

/** It shows and can take focus: connected, drawn, enabled, and not in an inert part of the page. */
const focusable = (element: Element | null | undefined): element is HTMLElement =>
  element instanceof HTMLElement &&
  !nothingFocused(element) &&
  element.isConnected &&
  !element.matches(":disabled") &&
  element.checkVisibility() &&
  element.closest("[inert]") === null;

/** Chromium's Window Controls Overlay: a desktop window (Electron) whose own controls sit over the page's top-left. */
interface ControlsOverlay extends EventTarget {
  readonly visible: boolean;
}
const controlsOverlay = (navigator as { windowControlsOverlay?: ControlsOverlay }).windowControlsOverlay;
/** The desktop app's window controls (Windows, Linux), which take the page's colors. */
const titleBarBridge = (window as Window & { lemmaDesktop?: { readonly titleBar?: { readonly setColors: (background: string, symbols: string) => void } } })
  .lemmaDesktop?.titleBar;

const clampWidth = (width: number) => Math.round(Math.max(MIN_WIDTH, Math.min(width, MAX_WIDTH, Math.max(MIN_WIDTH, window.innerWidth - MIN_MAIN))));

/**
 * The page's frame: a bar across the top, the sidebar region (resizable,
 * collapsible, a drawer on narrow screens), the main region, and every layer
 * over them. It fills the `root` slot; each region is whatever plugin fills
 * it, so any can be left empty or replaced.
 */
export default defineWebPlugin({
  id: "frame.shell",
  implements: [FRAME_CONTRACT],
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
    // The window's controls look like the heads they sit in: the page's background and muted text, as its look changes.
    if (titleBarBridge !== undefined) {
      const bridge = titleBarBridge;
      const tell = () => bridge.setColors(tokenColor("--bg"), tokenColor("--text-2"));
      tell();
      plugin.onCleanup(onLookChange(tell));
    }
    const narrowQuery = window.matchMedia(NARROW);
    const [narrow, setNarrow] = createSignal(narrowQuery.matches);
    plugin.listen(narrowQuery, "change", () => {
      setNarrow(narrowQuery.matches);
      // Wide again, the sidebar is in place, so no drawer is open over the page.
      if (!narrowQuery.matches) closeDrawer();
      // Focus in what the change hides (the sidebar, a closed drawer now; a header's toggle as it comes back) goes to the toggle in sight.
      refocus();
    });
    const sidebarHidden = () => slots.first(SidebarRegion) !== undefined && (narrow() ? !drawer() : collapsed());
    const width = () => {
      const room = viewport();
      // A drawer is over the page, not beside it: it leaves the page no room to keep, only a strip to close it by.
      return narrow() ? Math.round(Math.min(Math.max(MIN_WIDTH, Math.min(chosen(), MAX_WIDTH)), room - DRAWER_GAP)) : clampWidth(chosen());
    };
    /** The widest it can be dragged to in this window. */
    const maxWidth = () => {
      viewport();
      return clampWidth(MAX_WIDTH);
    };
    const setCollapsedSaved = (value: boolean) => {
      setCollapsed(value);
      save(COLLAPSED_KEY, value ? "1" : undefined);
    };
    /** The frame, whose toggles take focus the sidebar's going or coming leaves on nothing; the sidebar's box, which an opened drawer puts focus in. */
    let frame: HTMLDivElement | undefined;
    let box: HTMLDivElement | undefined;
    /**
     * Focus the sidebar's coming or going left on nothing (its own toggle hidden with it, a header's taken away) goes to
     * `to` if it still shows, else to the toggle in sight. Focus somewhere that still shows stays there.
     */
    const refocus = (to?: HTMLElement) =>
      queueMicrotask(() => {
        if (focusable(document.activeElement)) return;
        const next = focusable(to) ? to : [...(frame?.querySelectorAll(TOGGLES) ?? [])].find(focusable);
        next?.focus({ preventScroll: true });
      });
    /** What had focus as the drawer opened, which gets it back as the drawer closes. */
    let opener: HTMLElement | undefined;
    const openDrawer = () => {
      opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
      setDrawer(true);
      // The page beside it and the docks under it are inert while it is open, so focus goes in and Tab stays there, and
      // in what shows over it (a toast, a notice).
      queueMicrotask(() => [...(box?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].find(focusable)?.focus({ preventScroll: true }));
    };
    const closeDrawer = () => {
      if (!drawer()) return;
      setDrawer(false);
      refocus(opener);
      opener = undefined;
    };
    /** On narrow screens the sidebar is a drawer; otherwise it collapses in place. */
    const toggleSidebar = () => {
      if (narrow()) return drawer() ? closeDrawer() : openDrawer();
      const had = document.activeElement;
      setCollapsedSaved(!collapsed());
      if (!nothingFocused(had)) refocus();
    };

    slots.add(Actions, {
      id: "shell.toggle-sidebar",
      order: 4,
      title: "Toggle sidebar",
      category: "View",
      icon: SidebarIcon,
      keys: "mod+b",
      run: toggleSidebar,
    });
    slots.add(Actions, {
      id: "shell.close-drawer",
      title: "Close the sidebar",
      hidden: true,
      keys: "escape",
      whileTyping: true,
      // Open, the drawer covers the page, so Escape closes it before it reaches what is under it (settings, a turn).
      order: -30,
      when: drawer,
      run: closeDrawer,
    });

    const startResize = (event: PointerEvent) => {
      const startX = event.clientX;
      const startWidth = width();
      const started = dragEdge(event, {
        move: (next) => setChosen(clampWidth(startWidth + next.clientX - startX)),
        end: () => {
          setResizing(false);
          save(WIDTH_KEY, String(chosen()));
        },
      });
      if (started) setResizing(true);
    };
    const resetWidth = () => {
      setChosen(DEFAULT_WIDTH);
      save(WIDTH_KEY, undefined);
    };
    /** Its edge from the keys: ← and → narrow and widen it a step, Enter puts it back, as a double-click does. */
    const resizeKeys = (event: KeyboardEvent) => {
      // With a modifier, an arrow is someone else's (a word, back): only a plain one moves the edge.
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.key === "Enter") {
        event.preventDefault();
        return resetWidth();
      }
      const by = event.key === "ArrowLeft" ? -WIDTH_STEP : event.key === "ArrowRight" ? WIDTH_STEP : undefined;
      if (by === undefined) return;
      event.preventDefault();
      setChosen(clampWidth(width() + by));
      save(WIDTH_KEY, String(chosen()));
    };

    const drawerOpen = () => narrow() && drawer();

    function Shell() {
      const onResize = () => setViewport(window.innerWidth);
      const onGeometry = () => setTitlebar(controlsOverlay?.visible === true);
      onCleanup(plugin.listen(window, "resize", onResize));
      if (controlsOverlay !== undefined) onCleanup(plugin.listen(controlsOverlay, "geometrychange", onGeometry));
      const sidebar = () => slots.first(SidebarRegion);
      const main = () => slots.first(MainRegion);
      return (
        <div class="frame" ref={frame}>
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
                  {/* A closed drawer is out of sight, so out of reach too: Tab passes it by. */}
                  <div class="sidebar-slot" ref={box} inert={(narrow() && !drawer()) || undefined}>
                    <Contained slot={SidebarRegion} item={region} component={region.component} props={{ onPick: closeDrawer }} />
                  </div>
                  <div
                    class="sidebar-rail"
                    role="separator"
                    aria-orientation="vertical"
                    aria-label="Resize sidebar"
                    aria-valuenow={width()}
                    aria-valuemin={MIN_WIDTH}
                    aria-valuemax={maxWidth()}
                    tabindex="0"
                    data-tip="Drag to resize · double-click to reset"
                    onPointerDown={startResize}
                    onDblClick={resetWidth}
                    onKeyDown={resizeKeys}
                  />
                </>
              )}
            </Show>
            <Show when={drawer()}>
              <div class="scrim" onClick={closeDrawer} />
            </Show>
            <div class="main-col" inert={drawerOpen() || undefined}>
              <Show when={main()} keyed>
                {(region) => <Contained slot={MainRegion} item={region} component={region.component} />}
              </Show>
            </div>
            <Each slot={Layers} />
          </div>
          {/* Docked under the app, which shrinks to the space left: each dock sizes itself; out of reach under an open drawer. */}
          <div class="docks" inert={drawerOpen() || undefined}>
            <Each slot={Docks} />
          </div>
        </div>
      );
    }
    slots.add(Root, { id: "shell", phase: "default", component: Shell });
    return { layout: { sidebarHidden, toggleSidebar, closeDrawer } };
  },
});
