import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type { Accessor } from "solid-js";
import { Dialog } from "@lemma/look";
import { ThreadRoute } from "@lemma/sessions";
import { usePlugin } from "@lemma/web";
import type { RouterService } from "@lemma/web";
import { loadJson, recordOf, save } from "@lemma/web/storage";
import { HtmlFrame } from "./frame.tsx";
import { assignTab, isRememberedHeights, mergeHeights, recallHeight, rememberHeight } from "./page.ts";
import type { HeightChange, PageTabs, RenderedPage } from "./page.ts";

/** The pane's view of one page: its id in `Views`, and the `view` of a thread's address (`ThreadRoute`) that opens it. */
export const PAGE_VIEW = "page";

const HEIGHTS_KEY = "lemma.tools.html.heights";
const TABS_KEY = "lemma.tools.html.tabs";
/** How long the heights frames take wait before they are stored, so a page settling writes them once. */
const SAVE_MS = 1000;
/** How long a page opened in the pane waits for a tab to take it: with nothing to open the pane, it is let go. */
const PENDING_MS = 2000;

/** A page the chat draws: its call (`ToolBodyProps.id`), which is the page's key, and the page. */
export interface DrawnPage {
  readonly key: string;
  readonly page: RenderedPage;
}

/** What the plugin keeps of the pages it draws, for the chat, the full-screen view, and the pane. */
export interface Pages {
  /** The pages the chat draws now (the shown thread's, on its branch), in the order they were drawn. */
  readonly drawn: Accessor<readonly DrawnPage[]>;
  /** `page` is drawn in the chat, until the returned function is called. */
  readonly draw: (page: DrawnPage) => () => void;
  /** The height `key`'s frame took before at about `width`. */
  readonly known: (key: string, width: number) => number | undefined;
  /** `key`'s frame took `height` at `width`. */
  readonly took: (key: string, width: number, height: number) => void;
  /** The page shown full screen, over the app. */
  readonly viewing: Accessor<DrawnPage | undefined>;
  readonly view: (page: DrawnPage | undefined) => void;
  /** A page can open in the pane: the chat shown is a thread's. */
  readonly canOpenInPane: Accessor<boolean>;
  /** Shows `page` in the shown thread's pane: in the page tab shown there, else its first, else a new one. */
  readonly openInPane: (page: DrawnPage) => void;
  /** The page just opened in the pane, by its key, until the tab shown takes it (`showInTab`). */
  readonly pending: Accessor<string | undefined>;
  /** The page a tab of the pane shows, by its key: one just opened in the pane, else the tab's own. */
  readonly tabPage: (tab: string) => string | undefined;
  /** `tab` shows the page `key` from now on: by default, the one just opened in the pane. */
  readonly showInTab: (tab: string, key?: string) => void;
}

const loadHeights = () => loadJson(HEIGHTS_KEY, [], isRememberedHeights);
const loadTabs = (): PageTabs =>
  loadJson(
    TABS_KEY,
    {},
    recordOf((value): value is string => typeof value === "string"),
  );

/**
 * The pages drawn, as their frames register them; the heights frames took, kept across reloads (`rememberHeight`); the
 * page shown full screen; and which page each of the pane's page tabs shows, kept across reloads. A tab names its page
 * by its call, so a reload finds it again once the chat draws it. What is stored is shared with the app's other
 * windows: each lays what it changed over what is stored when it writes, and reads what another wrote.
 */
export function createPages(deps: {
  readonly router: RouterService;
  readonly after: (ms: number, run: () => void) => void;
  readonly listen: (target: EventTarget, type: string, listener: (event: Event) => void) => void;
}): Pages {
  const { router } = deps;
  const [drawn, setDrawn] = createSignal<readonly DrawnPage[]>([]);
  let heights = loadHeights();
  /** Heights taken since they were last stored. */
  let changes: HeightChange[] = [];
  let saving = false;
  const flush = () => {
    if (changes.length === 0) return;
    heights = mergeHeights(loadHeights(), changes);
    changes = [];
    save(HEIGHTS_KEY, JSON.stringify(heights));
  };
  const [tabs, setTabs] = createSignal(loadTabs());
  const [pending, setPending] = createSignal<string>();
  const [viewing, view] = createSignal<DrawnPage>();
  deps.listen(window, "storage", (event) => {
    const { key } = event as StorageEvent;
    if (key === HEIGHTS_KEY) heights = mergeHeights(loadHeights(), changes);
    else if (key === TABS_KEY) setTabs(loadTabs());
  });
  // Stored as the page goes (a reload, a window closed) or the plugin stops, rather than lost with the wait.
  deps.listen(window, "pagehide", flush);
  deps.listen(document, "visibilitychange", () => document.visibilityState === "hidden" && flush());
  onCleanup(flush);
  const thread = () => router.matchOf(ThreadRoute)?.params.id;
  return {
    drawn,
    draw: (page) => {
      setDrawn((current) => [...current, page]);
      return () => setDrawn((current) => current.filter((candidate) => candidate !== page));
    },
    known: (key, width) => recallHeight(heights, key, width),
    took: (key, width, height) => {
      const next = rememberHeight(heights, key, width, height);
      if (next === heights) return;
      heights = next;
      changes.push([key, width, height]);
      if (saving) return;
      saving = true;
      deps.after(SAVE_MS, () => {
        saving = false;
        flush();
      });
    },
    viewing,
    view,
    canOpenInPane: () => thread() !== undefined,
    openInPane: (page) => {
      const id = thread();
      if (id === undefined) return;
      setPending(page.key);
      deps.after(PENDING_MS, () => setPending((key) => (key === page.key ? undefined : key)));
      // A thread's address naming a view opens it in that thread's pane, as threads.view keeps it (`ThreadRoute`).
      router.navigate(ThreadRoute, { id, view: PAGE_VIEW }, { replace: true });
    },
    pending,
    tabPage: (tab) => pending() ?? tabs()[tab],
    showInTab: (tab, key = pending()) => {
      if (key === undefined) return;
      setPending(undefined);
      const next = assignTab(loadTabs(), tab, key);
      save(TABS_KEY, JSON.stringify(next));
      setTabs(next);
    },
  };
}

/**
 * A page full screen, over the app: the dialog part, which closes on Escape (in the page too), its ×, or a click
 * outside. Focus goes into the page; Tab out of its end comes round to the dialog's first stop, and Shift+Tab from that
 * stop goes back into the page, since the dialog part keeps focus among its own stops and a frame's are its page's.
 * Where the browser runs the page in a process of its own (Chromium's full builds, for a sandboxed frame), Tab out of
 * it skips the stops beside the frame (it went to the button that opened the page), so focus leaving the page for
 * anywhere outside the dialog comes back to the dialog's first stop.
 */
export function PageViewer(props: { page: DrawnPage; onClose: () => void }) {
  const plugin = usePlugin();
  let wrap!: HTMLDivElement;
  const dialog = () => wrap.closest<HTMLElement>("[role='dialog']");
  const first = () => dialog()?.querySelector<HTMLElement>("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])");
  const round = (event: FocusEvent) => {
    if (event.relatedTarget !== null && event.relatedTarget === first()) wrap.querySelector("iframe")?.focus();
    else first()?.focus();
  };
  // On mount, so it ends before the dialog part gives focus back to what opened it, as the dialog closes.
  onMount(() =>
    onCleanup(
      plugin.listen(document, "focusin", (event: FocusEvent) => {
        if (event.relatedTarget === wrap.querySelector("iframe") && event.target instanceof Node && dialog()?.contains(event.target) === false)
          first()?.focus();
      }),
    ),
  );
  return (
    <Dialog title={props.page.page.title} label={props.page.page.title} class="html-viewer" onClose={props.onClose}>
      <div ref={wrap} class="html-viewer-page">
        <HtmlFrame html={props.page.page.html} title={props.page.page.title} fill onEscape={props.onClose} />
        <span class="html-viewer-end" tabindex="0" onFocus={round} />
      </div>
    </Dialog>
  );
}

/**
 * A tab of the pane showing a page, filling it, the page scrolling inside. A page just opened in the pane goes to the
 * tab shown. A tab whose page the chat does not draw (another branch's, or the thread still loading), or one opened
 * from the pane's + menu, lists the pages it draws.
 */
export function PageTab(props: { tab: string | undefined; pages: Pages }) {
  const key = () => (props.tab === undefined ? undefined : props.pages.tabPage(props.tab));
  // Shown at once (`tabPage`), the page just opened becomes the tab's own.
  createEffect(() => props.tab !== undefined && props.pages.pending() !== undefined && props.pages.showInTab(props.tab));
  // The same page drawn again (the chat drawing it anew) keeps its frame: a new one would load it again.
  const shown = createMemo(() => props.pages.drawn().find((page) => page.key === key()), undefined, {
    equals: (a, b) => a?.key === b?.key && a?.page.html === b?.page.html,
  });
  return (
    <div class="html-page-view">
      <Show
        when={shown()}
        keyed
        fallback={
          <div class="html-page-choices">
            <p class="muted small">
              {key() === undefined
                ? "Show a page from this thread:"
                : "This page is not in the chat now: it is on another branch, or still loading. Show another:"}
            </p>
            <Show when={props.pages.drawn().length > 0} fallback={<p class="muted small">The chat shows no pages yet.</p>}>
              <For each={props.pages.drawn()}>
                {(page) => (
                  <button type="button" class="menu-item" onClick={() => props.tab !== undefined && props.pages.showInTab(props.tab, page.key)}>
                    <span class="menu-label">{page.page.title}</span>
                  </button>
                )}
              </For>
            </Show>
          </div>
        }
      >
        {(page) => <HtmlFrame html={page.page.html} title={page.page.title} fill />}
      </Show>
    </div>
  );
}
