import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, untrack } from "solid-js";
import type { Accessor, JSX } from "solid-js";
import { loadJson, save } from "@lemma/web/storage";
import { ComposerRegion, Views } from "@lemma/threads";
import type { ThreadsService, ThreadView } from "@lemma/threads";
import { Contained, First } from "@lemma/web";
import type { SlotItem, SlotsService } from "@lemma/web";
import { edgeAt, findPane, freshId, isPaneTree, movePane, neighbor, panesOf, rects, removePane, resize, setView, single, splitAt, splits } from "./panes.ts";
import type { Edge, PaneTree, Rect, SplitPath } from "./panes.ts";

/** A thread's panes: their tree, the one with focus, and whether that one fills the page. */
interface PaneState {
  readonly tree: PaneTree;
  readonly focus: string;
  readonly zoom: boolean;
}

const STORE_KEY = "lemma.threads.view.panes";
/** At most this many threads' layouts are kept: the most recently changed. */
const KEPT = 50;
const WHOLE: Rect = { x: 0, y: 0, w: 1, h: 1 };

const isState = (value: unknown): value is PaneState => {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Record<string, unknown>;
  return isPaneTree(state.tree) && typeof state.focus === "string" && findPane(state.tree, state.focus) !== undefined;
};

const isStore = (value: unknown): value is Record<string, PaneState> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.values(value).every(isState);

export interface PanesDeps {
  readonly threads: ThreadsService;
  readonly slots: SlotsService;
  readonly views: Accessor<readonly SlotItem<ThreadView>[]>;
  /** The view the address names, which the focused pane shows. */
  readonly view: Accessor<SlotItem<ThreadView> | undefined>;
  /** Puts `view` in the address, so the focused pane shows it. */
  readonly choose: (view: string, replace?: boolean) => void;
}

/**
 * The open thread's page as panes, split and moved as Ghostty splits a window: each shows one of the thread's views,
 * and a view shows in one pane at most. The focused pane is the one the address names; each thread keeps its own
 * layout. Its commands: split, close, move focus, zoom.
 */
export const createPanes = (deps: PanesDeps) => {
  const { threads, views, view, choose } = deps;
  const [store, setStore] = createSignal<Readonly<Record<string, PaneState>>>(loadJson(STORE_KEY, {}, isStore));

  const fallback = (): PaneState => ({ tree: single(view()?.id ?? views()[0]?.id ?? "transcript"), focus: "p1", zoom: false });
  /** The open thread's panes; a new thread's page is one pane. */
  const current = createMemo((): PaneState => {
    const id = threads.activeId();
    return (id === undefined ? undefined : store()[id]) ?? fallback();
  });
  const update = (change: (state: PaneState) => PaneState) => {
    const id = threads.activeId();
    if (id === undefined) return;
    const next = { ...store() };
    delete next[id];
    const kept = Object.entries(next).slice(-(KEPT - 1));
    const updated = Object.fromEntries([...kept, [id, change(untrack(current))]]);
    setStore(updated);
    save(STORE_KEY, JSON.stringify(updated));
  };

  const panes = () => panesOf(current().tree);
  const focused = () => findPane(current().tree, current().focus);
  const viewOf = (id: string) => views().find((item) => item.id === id);
  /** Views no pane shows, in their order: what a new pane can show. */
  const free = () => views().filter((item) => !panes().some((pane) => pane.view === item.id));

  // The address names the focused pane's view: a view another pane shows takes the focus there, any other shows here.
  createEffect(
    on([threads.activeId, () => view()?.id], ([id, named]) => {
      if (id === undefined || named === undefined) return;
      const state = untrack(current);
      if (findPane(state.tree, state.focus)?.view === named) return;
      const showing = panesOf(state.tree).find((pane) => pane.view === named);
      update((now) => (showing !== undefined ? { ...now, focus: showing.id } : { ...now, tree: setView(now.tree, now.focus, named) }));
    }),
  );

  const focus = (id: string) => {
    const pane = findPane(current().tree, id);
    if (pane === undefined || id === current().focus) return;
    update((state) => ({ ...state, focus: id }));
    choose(pane.view, true);
  };
  /** A new pane at `edge` of `target` (the focused one), showing `view` (the first not shown); focus goes to it. */
  const split = (edge: Edge, view = free()[0]?.id, target = current().focus) => {
    if (view === undefined || threads.activeId() === undefined) return;
    const leaf = { kind: "pane" as const, id: freshId(current().tree), view };
    update((state) => ({ tree: splitAt(state.tree, target, edge, leaf), focus: leaf.id, zoom: false }));
    choose(leaf.view, true);
  };
  const close = (id = current().focus) => {
    const state = current();
    const tree = removePane(state.tree, id);
    if (tree === undefined) return;
    const next =
      id !== state.focus
        ? state.focus
        : ((["left", "top", "right", "bottom"] as const).map((edge) => neighbor(state.tree, id, edge)).find((other) => other !== undefined) ??
          panesOf(tree)[0]!.id);
    update(() => ({ tree, focus: next, zoom: false }));
    choose(findPane(tree, next)!.view, true);
  };
  const move = (id: string, target: string, edge: Edge) =>
    update((state) => ({ ...state, tree: movePane(state.tree, id, target, edge), focus: id, zoom: false }));
  const focusToward = (edge: Edge) => {
    const next = neighbor(current().tree, current().focus, edge);
    if (next !== undefined) focus(next);
  };
  const toggleZoom = () => update((state) => ({ ...state, zoom: !state.zoom }));

  /** The page's panes area: each pane placed by its box, so moving or resizing one never redraws the others. */
  function Panes(): JSX.Element {
    let area!: HTMLDivElement;
    const boxes = createMemo(() => (current().zoom ? new Map([[current().focus, WHOLE]]) : rects(current().tree)));
    const ids = createMemo(() => panes().map((pane) => pane.id));
    const dividers = createMemo(() => splits(current().tree));
    const [drag, setDrag] = createSignal<{ readonly source: string; readonly target?: string; readonly edge?: Edge }>();
    const [resizing, setResizing] = createSignal(false);
    const pct = (share: number) => `${share * 100}%`;
    const place = (box: Rect): JSX.CSSProperties => ({ left: pct(box.x), top: pct(box.y), width: pct(box.w), height: pct(box.h) });

    /** The ⋯ grip: a drag moves the pane onto the half of another it is dropped over; a click focuses the pane. */
    const grab = (id: string, openMenu: () => void) => (event: PointerEvent) => {
      if (event.button !== 0) return;
      const grip = event.currentTarget as HTMLElement;
      grip.setPointerCapture(event.pointerId);
      const startX = event.clientX;
      const startY = event.clientY;
      let dragging = false;
      const over = (moved: PointerEvent) => {
        const target = document.elementFromPoint(moved.clientX, moved.clientY)?.closest<HTMLElement>("[data-pane]");
        if (target === null || target === undefined || target.dataset.pane === id) return { source: id };
        const box = target.getBoundingClientRect();
        return { source: id, target: target.dataset.pane!, edge: edgeAt((moved.clientX - box.left) / box.width, (moved.clientY - box.top) / box.height) };
      };
      const onMove = (moved: PointerEvent) => {
        if (!dragging && Math.hypot(moved.clientX - startX, moved.clientY - startY) < 4) return;
        dragging = true;
        setDrag(over(moved));
      };
      const onUp = () => {
        grip.removeEventListener("pointermove", onMove);
        grip.removeEventListener("pointerup", onUp);
        grip.removeEventListener("pointercancel", onUp);
        const dropped = drag();
        setDrag(undefined);
        if (!dragging) return openMenu();
        if (dropped?.target !== undefined && dropped.edge !== undefined) move(id, dropped.target, dropped.edge);
      };
      grip.addEventListener("pointermove", onMove);
      grip.addEventListener("pointerup", onUp);
      grip.addEventListener("pointercancel", onUp);
    };

    /** A divider's drag sets its split's ratio from where the pointer is in the split's area. */
    const startResize = (path: SplitPath, box: Rect, dir: "row" | "column") => (event: PointerEvent) => {
      event.preventDefault();
      const handle = event.currentTarget as HTMLElement;
      handle.setPointerCapture(event.pointerId);
      setResizing(true);
      const onMove = (moved: PointerEvent) => {
        const bounds = area.getBoundingClientRect();
        const ratio =
          dir === "row" ? ((moved.clientX - bounds.left) / bounds.width - box.x) / box.w : ((moved.clientY - bounds.top) / bounds.height - box.y) / box.h;
        update((state) => ({ ...state, tree: resize(state.tree, path, ratio) }));
      };
      const onUp = () => {
        setResizing(false);
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        handle.removeEventListener("pointercancel", onUp);
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
      handle.addEventListener("pointercancel", onUp);
    };

    function Pane(props: { readonly id: string }) {
      let element!: HTMLElement;
      const leaf = () => findPane(current().tree, props.id);
      const item = () => (leaf() === undefined ? undefined : viewOf(leaf()!.view));
      const box = () => boxes().get(props.id);
      // The composer lies over its pane's bottom: its height, for the view to pad its end by and scroll under it.
      const dock = (dockElement: HTMLDivElement) => {
        const observer = new ResizeObserver(() => element.style.setProperty("--composer-height", `${dockElement.offsetHeight}px`));
        observer.observe(dockElement);
        onCleanup(() => {
          observer.disconnect();
          element.style.removeProperty("--composer-height");
        });
      };
      return (
        <section
          ref={element}
          class="pane"
          classList={{ focused: current().focus === props.id, hidden: box() === undefined, below: (box()?.y ?? 0) > 0 }}
          data-pane={props.id}
          aria-label={item()?.title ?? "Pane"}
          style={box() === undefined ? undefined : place(box()!)}
          onPointerDown={() => focus(props.id)}
        >
          <Show when={item()} keyed fallback={<div class="pane-missing">This view is no longer available.</div>}>
            {(shown) => <Contained slot={Views} item={shown} component={shown.component} />}
          </Show>
          <Show when={item()?.composer === true}>
            <div class="composer-dock" ref={dock}>
              <First slot={ComposerRegion} />
            </div>
          </Show>
        </section>
      );
    }

    /**
     * A pane's ⋯ grip, over the panes: one along the page's top sits in the header row above it, as Ghostty's sit in
     * its title bar; one lower down at its pane's top.
     */
    function Grip(props: { readonly id: string }) {
      const box = () => boxes().get(props.id);
      return (
        <Show when={box()}>
          <div
            class="pane-grip-at"
            classList={{ top: box()!.y === 0 }}
            style={{ left: pct(box()!.x + box()!.w / 2), top: box()!.y === 0 ? undefined : pct(box()!.y) }}
          >
            <div class="pane-grip" aria-hidden="true" data-tip="Drag to move" onPointerDown={grab(props.id, () => focus(props.id))}>
              <span />
            </div>
          </div>
        </Show>
      );
    }

    /** The half of the pane under the pointer that a dropped pane would take. */
    const dropBox = (): Rect | undefined => {
      const target = drag()?.target;
      const edge = drag()?.edge;
      const box = target === undefined ? undefined : boxes().get(target);
      if (box === undefined || edge === undefined) return undefined;
      if (edge === "left") return { ...box, w: box.w / 2 };
      if (edge === "right") return { ...box, x: box.x + box.w / 2, w: box.w / 2 };
      if (edge === "top") return { ...box, h: box.h / 2 };
      return { ...box, y: box.y + box.h / 2, h: box.h / 2 };
    };

    return (
      <div ref={area} class="panes" classList={{ "panes-many": ids().length > 1 && !current().zoom, "panes-dragging": drag() !== undefined || resizing() }}>
        <For each={ids()}>{(id) => <Pane id={id} />}</For>
        <For each={ids()}>{(id) => <Grip id={id} />}</For>
        <Show when={!current().zoom}>
          {/* By path, so a divider keeps its element (and the pointer it holds) while its split's ratio changes. */}
          <For each={dividers().map((entry) => entry.path.join("."))}>
            {(key) => {
              const entry = () => dividers().find((candidate) => candidate.path.join(".") === key);
              const row = () => entry()?.split.dir === "row";
              const at = () => {
                const found = entry();
                if (found === undefined) return 0;
                return row() ? found.area.x + found.area.w * found.split.ratio : found.area.y + found.area.h * found.split.ratio;
              };
              return (
                <Show when={entry()}>
                  {(found) => (
                    <div
                      class="pane-divider"
                      classList={{ row: row(), column: !row() }}
                      role="separator"
                      aria-orientation={row() ? "vertical" : "horizontal"}
                      style={
                        row()
                          ? { left: pct(at()), top: pct(found().area.y), height: pct(found().area.h) }
                          : { top: pct(at()), left: pct(found().area.x), width: pct(found().area.w) }
                      }
                      onPointerDown={(event) => startResize(found().path, found().area, found().split.dir)(event)}
                    />
                  )}
                </Show>
              );
            }}
          </For>
        </Show>
        <Show when={dropBox()}>{(box) => <div class="pane-drop" style={place(box())} />}</Show>
      </div>
    );
  }

  return { Panes, panes, focused, free, split, close, focusToward, toggleZoom, current };
};
