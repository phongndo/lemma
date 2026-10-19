import { For, createEffect, createSignal, onCleanup, untrack } from "solid-js";
import type { Accessor, JSX } from "solid-js";
import { loadJson, recordOf, save } from "@lemma/web/storage";

/** The desktop app's bridge for pages (`window.lemmaDesktop.browser`, `apps/desktop/src/preload.cjs`), in its window. */
export interface BrowserBridge {
  /** The partition every page is in: their cookies and storage, kept across restarts, apart from the app's. */
  readonly partition: string;
  /** The app's key bindings (`mod+t`) that a page with focus hands on to the app rather than taking. */
  readonly forwardKeys: (bindings: readonly string[]) => void;
  /** Hears a page ask to open a link in a new tab (`target=_blank`), until the returned function is called. */
  readonly onOpen: (listener: (page: number, url: string, background: boolean) => void) => () => void;
}

export const bridge = (window as Window & { lemmaDesktop?: { readonly browser?: BrowserBridge } }).lemmaDesktop?.browser;

/** What a page failed to load. */
export interface Failure {
  readonly url: string;
  readonly description: string;
}

/** One tab's page, as the toolbar and its tab's name read it. */
export interface Page {
  readonly tab: string;
  /** What it shows; undefined before it goes anywhere. */
  readonly url: Accessor<string | undefined>;
  readonly title: Accessor<string | undefined>;
  readonly loading: Accessor<boolean>;
  readonly failure: Accessor<Failure | undefined>;
  readonly canGoBack: Accessor<boolean>;
  readonly canGoForward: Accessor<boolean>;
  /** Chromium's DevTools are open for it (the desktop app's only). */
  readonly devtools: Accessor<boolean>;
  /** The page is Chromium's, with history, a title, and DevTools: in the desktop app. */
  readonly full: boolean;
  readonly go: (url: string) => void;
  readonly back: () => void;
  readonly forward: () => void;
  readonly reload: () => void;
  readonly stop: () => void;
  readonly toggleDevtools: () => void;
  /** Where it shows, set by its tab while drawn; undefined puts it out of sight, still loaded. */
  readonly place: Accessor<HTMLElement | undefined>;
  readonly setPlace: (place: HTMLElement | undefined) => void;
  /** Its webContents id, once attached: how the desktop app names it. */
  readonly contentsId: () => number | undefined;
  readonly element: HTMLElement;
}

/** The `<webview>` element's methods (Electron's `WebviewTag`), callable once it is ready. */
interface Webview extends HTMLElement {
  loadURL(url: string): Promise<void>;
  getURL(): string;
  getTitle(): string;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  stop(): void;
  openDevTools(): void;
  closeDevTools(): void;
  isDevToolsOpened(): boolean;
  getWebContentsId(): number;
}

/** Electron's events on a `<webview>`, as far as they are read here. */
type WebviewEvent = Event & {
  readonly url?: string;
  readonly title?: string;
  readonly isMainFrame?: boolean;
  readonly isInPlace?: boolean;
  readonly errorCode?: number;
  readonly errorDescription?: string;
  readonly validatedURL?: string;
};

/** Where each tab's page was, by tab id: kept across reloads, while the tab is. */
const PAGES_KEY = "lemma.threads.browser.pages";
/** Chromium's code for a load given up for another (a click before the last one finished): no failure. */
const ABORTED = -3;

/** Keeps where a tab's page is: only a web address, which it can be opened at again. */
type Remember = (tab: string, url: string) => void;

/** A page in Chromium, with its history, title, and DevTools: the desktop app's `<webview>`. */
const webviewPage = (tab: string, partition: string, start: string | undefined, remember: Remember): Page => {
  const [url, setUrl] = createSignal(start);
  const [title, setTitle] = createSignal<string>();
  const [loading, setLoading] = createSignal(start !== undefined);
  const [failure, setFailure] = createSignal<Failure>();
  const [canGoBack, setCanGoBack] = createSignal(false);
  const [canGoForward, setCanGoForward] = createSignal(false);
  const [devtools, setDevtools] = createSignal(false);
  const [place, setPlace] = createSignal<HTMLElement>();
  const element = document.createElement("webview") as Webview;
  // Read before it attaches, and only then: the partition, and that a page may open windows (the app decides where).
  element.setAttribute("partition", partition);
  element.setAttribute("allowpopups", "true");
  element.setAttribute("src", start ?? "about:blank");
  element.dataset.paneTab = tab;
  let ready = false;
  const history = () => {
    setCanGoBack(element.canGoBack());
    setCanGoForward(element.canGoForward());
  };
  const shows = (next: string) => {
    if (next === "about:blank") return;
    setUrl(next);
    remember(tab, next);
  };
  const on = (type: string, listener: (event: WebviewEvent) => void) => element.addEventListener(type, listener as EventListener);
  on("dom-ready", () => {
    ready = true;
    history();
  });
  on("did-start-navigation", (event) => {
    if (event.isMainFrame !== true || event.isInPlace === true) return;
    setLoading(true);
    setFailure(undefined);
  });
  on("did-navigate", (event) => {
    if (event.url !== undefined) shows(event.url);
    history();
  });
  on("did-navigate-in-page", (event) => {
    if (event.isMainFrame === true && event.url !== undefined) shows(event.url);
    history();
  });
  on("page-title-updated", (event) => setTitle(event.title || undefined));
  on("did-fail-load", (event) => {
    if (event.isMainFrame !== true || event.errorCode === ABORTED) return;
    const failed = event.validatedURL ?? url() ?? "";
    setFailure({ url: failed, description: event.errorDescription ?? "It could not be reached." });
    shows(failed);
  });
  on("did-stop-loading", () => {
    setLoading(false);
    if (ready) history();
  });
  on("render-process-gone", () => {
    setLoading(false);
    setFailure({ url: url() ?? "", description: "The page crashed." });
  });
  on("devtools-opened", () => setDevtools(true));
  on("devtools-closed", () => setDevtools(false));
  // A click in the page reaches the app only as focus on this element: as a press outside them, it closes the app's menus.
  on("focus", () => element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
  const go = (next: string) => {
    setFailure(undefined);
    if (!ready) return void element.setAttribute("src", next);
    if (next === url()) return void element.reload();
    element.loadURL(next).catch(() => {
      // A load that fails says so in `did-fail-load`.
    });
  };
  return {
    tab,
    url,
    title,
    loading,
    failure,
    canGoBack,
    canGoForward,
    devtools,
    full: true,
    go,
    back: () => ready && element.goBack(),
    forward: () => ready && element.goForward(),
    reload: () => {
      setFailure(undefined);
      if (ready) element.reload();
      else if (url() !== undefined) element.setAttribute("src", url()!);
    },
    stop: () => ready && element.stop(),
    toggleDevtools: () => {
      if (!ready) return;
      if (element.isDevToolsOpened()) element.closeDevTools();
      else element.openDevTools();
    },
    place,
    setPlace,
    contentsId: () => (ready ? element.getWebContentsId() : undefined),
    element,
  };
};

/** A page in a frame, outside the desktop app: only what lets itself be framed shows (a local dev server does). */
const framedPage = (tab: string, start: string | undefined, remember: Remember): Page => {
  const [url, setUrl] = createSignal(start);
  const [loading, setLoading] = createSignal(start !== undefined);
  const [place, setPlace] = createSignal<HTMLElement>();
  const element = document.createElement("iframe");
  element.title = "Browser";
  element.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-popups allow-modals");
  element.dataset.paneTab = tab;
  element.addEventListener("load", () => setLoading(false));
  const go = (next: string) => {
    setUrl(next);
    remember(tab, next);
    setLoading(true);
    element.src = next;
  };
  if (start !== undefined) element.src = start;
  const never = () => false;
  return {
    tab,
    url,
    title: () => undefined,
    loading,
    failure: () => undefined,
    canGoBack: never,
    canGoForward: never,
    devtools: never,
    full: false,
    go,
    back: () => undefined,
    forward: () => undefined,
    reload: () => {
      const current = url();
      if (current !== undefined) go(current);
    },
    stop: () => setLoading(false),
    toggleDevtools: () => undefined,
    place,
    setPlace,
    contentsId: () => undefined,
    element,
  };
};

/**
 * Every tab's page, made when its tab first shows (or a link opens it) and kept, loaded, until the tab closes: it lives
 * at the app's top (`PageLayer`), never moved in the page, which would load it again, and its tab's view only says
 * where it shows. Where each was is kept across reloads.
 */
export function createPages() {
  const [list, setList] = createSignal<readonly Page[]>([]);
  const [saved, setSaved] = createSignal<Readonly<Record<string, string>>>(
    loadJson(
      PAGES_KEY,
      {},
      recordOf((value): value is string => typeof value === "string"),
    ),
  );
  const remember: Remember = (tab, url) => {
    if (!/^https?:/i.test(url) || untrack(saved)[tab] === url) return;
    setSaved({ ...untrack(saved), [tab]: url });
    save(PAGES_KEY, JSON.stringify(untrack(saved)));
  };
  const byTab = new Map<string, Page>();
  const get = (tab: string): Page | undefined => {
    list();
    return byTab.get(tab);
  };
  /** Where the tab's page is, or was when the app last ran. */
  const savedUrl = (tab: string): string | undefined => saved()[tab];
  /** The tab's page, made with `start` (else where it last was) when it has none. */
  const pageFor = (tab: string, start?: string): Page => {
    const known = byTab.get(tab);
    if (known !== undefined) return known;
    const at = start ?? untrack(saved)[tab];
    const page = bridge === undefined ? framedPage(tab, at, remember) : webviewPage(tab, bridge.partition, at, remember);
    byTab.set(tab, page);
    setList([...untrack(list), page]);
    return page;
  };
  /** Lets go of the pages of tabs not in `tabs`, and of where they were. */
  const keepOnly = (tabs: ReadonlySet<string>) =>
    untrack(() => {
      const gone = list().filter((page) => !tabs.has(page.tab));
      for (const page of gone) byTab.delete(page.tab);
      if (gone.length > 0) setList(list().filter((page) => tabs.has(page.tab)));
      const kept = Object.entries(saved()).filter(([tab]) => tabs.has(tab));
      if (kept.length === Object.keys(saved()).length) return;
      setSaved(Object.fromEntries(kept));
      save(PAGES_KEY, JSON.stringify(saved()));
    });
  const byContents = (id: number) => list().find((page) => page.contentsId() === id);
  return { list, get, savedUrl, pageFor, keepOnly, byContents };
}

export type Pages = ReturnType<typeof createPages>;

/** A page drawn over where its tab shows it, following it as the layout moves; out of sight when it is not shown. */
function PageFrame(props: { page: Page; listen: (target: EventTarget, type: string, listener: () => void) => () => void }) {
  const [box, setBox] = createSignal<{ x: number; y: number; width: number; height: number }>();
  /** Its last size: out of sight it keeps it, so the page lays out the same again. */
  let size = { width: 800, height: 600 };
  createEffect(() => {
    const place = props.page.place();
    if (place === undefined) {
      setBox(undefined);
      // Out of sight, it lets go of focus, so typing does not go on into a page no one sees.
      const element = props.page.element;
      if (element === document.activeElement || element.contains(document.activeElement)) element.blur();
      return;
    }
    const measure = () => {
      const rect = place.getBoundingClientRect();
      const next = { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) };
      const last = untrack(box);
      if (last === undefined || last.x !== next.x || last.y !== next.y || last.width !== next.width || last.height !== next.height) setBox(next);
    };
    measure();
    // The place, and what holds it: a column or the sidebar beside it changing size moves it without resizing it.
    const observer = new ResizeObserver(measure);
    for (let element: Element | null = place; element !== null; element = element.parentElement) observer.observe(element);
    onCleanup(() => observer.disconnect());
    onCleanup(props.listen(window, "resize", measure));
  });
  const style = (): JSX.CSSProperties => {
    const shown = box();
    if (shown !== undefined && shown.width > 0 && shown.height > 0) {
      size = { width: shown.width, height: shown.height };
      return { left: `${shown.x}px`, top: `${shown.y}px`, width: `${shown.width}px`, height: `${shown.height}px` };
    }
    // Far out of sight rather than hidden: a hidden webview can stay blank once shown again.
    return { left: "-100000px", top: "-100000px", width: `${size.width}px`, height: `${size.height}px` };
  };
  return (
    // Out of sight it takes no focus, and Tab passes it by.
    <div class="browser-page" data-pane-tab={props.page.tab} style={style()} inert={box() === undefined || undefined}>
      {props.page.element}
    </div>
  );
}

/** Every page, over the app (a `Layers` item): each where its tab shows it. */
export function PageLayer(props: { pages: Pages; listen: (target: EventTarget, type: string, listener: () => void) => () => void }) {
  return <For each={props.pages.list()}>{(page) => <PageFrame page={page} listen={props.listen} />}</For>;
}
