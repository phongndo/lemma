import { Show, batch, createEffect, createSignal, onCleanup, onMount, untrack } from "solid-js";
import { Effect, Schema } from "effect";
import { Pane, Views } from "@lemma/threads";
import type { ThreadViewProps } from "@lemma/threads";
import { Actions, keysFor, overridesFrom } from "@lemma/actions";
import { Layers } from "@lemma/frame";
import { Slots, WebPlugins, defineWebPlugin } from "@lemma/web";
import { ArrowLeftIcon, CodeIcon, ExternalIcon, LaptopIcon, RefreshIcon, XIcon } from "@lemma/look";
import { SEARCH, addressOf, hostOf } from "./address.ts";
import { takenFromPages } from "./keys.ts";
import { PageLayer, bridge, createPages } from "./pages.tsx";
import type { Page, Pages } from "./pages.tsx";
import styles from "./browser.css?inline";

const BrowserConfig = Schema.Struct({
  search: Schema.String.pipe(Schema.withDecodingDefaultType(Effect.sync(() => SEARCH))).annotate({
    title: "Search",
    description: "Where the address bar sends what is not an address: `%s` is what was typed (DuckDuckGo's by default).",
  }),
});

/** A tab's page: its toolbar, and the place the page shows in (drawn over it, from the app's top). */
/** The page of the browser when it is a thread's first view, filling the page rather than in a tab. */
const MAIN = "browser";

/** A tab's page: its toolbar, and the place the page shows in (drawn over it, from the app's top). */
function BrowserTab(props: { tab: string | undefined; pages: Pages; search: () => string; fresh: (tab: string) => boolean }) {
  const page: Page = props.pages.pageFor(props.tab ?? MAIN);
  const [typed, setTyped] = createSignal<string>();
  let place!: HTMLDivElement;
  let input!: HTMLInputElement;
  // The page shows in its place unless there is nothing to show yet, or it failed and says why instead.
  createEffect(() => page.setPlace(page.url() !== undefined && page.failure() === undefined ? place : undefined));
  onCleanup(() => page.setPlace(undefined));
  // A tab just opened takes the keys in its address bar, as a browser's does; one shown again (another thread's, after a
  // reload) leaves focus where it is.
  onMount(() => {
    if (page.url() === undefined && props.fresh(page.tab)) input.focus();
  });
  const go = (text: string) => {
    const next = addressOf(text, props.search());
    if (next === undefined) return;
    setTyped(undefined);
    input.blur();
    page.go(next);
  };
  return (
    <div class="browser-view">
      <form
        class="browser-bar"
        onSubmit={(event) => {
          event.preventDefault();
          go(input.value);
        }}
      >
        <Show when={page.full}>
          <button type="button" class="icon-button" aria-label="Back" data-tip="Back" disabled={!page.canGoBack()} onClick={() => page.back()}>
            <ArrowLeftIcon />
          </button>
          <button
            type="button"
            class="icon-button browser-forward"
            aria-label="Forward"
            data-tip="Forward"
            disabled={!page.canGoForward()}
            onClick={() => page.forward()}
          >
            <ArrowLeftIcon />
          </button>
        </Show>
        <Show
          when={page.loading() && page.full}
          fallback={
            <button
              type="button"
              class="icon-button"
              aria-label="Reload page"
              data-tip="Reload"
              disabled={page.url() === undefined}
              onClick={() => page.reload()}
            >
              <RefreshIcon />
            </button>
          }
        >
          <button type="button" class="icon-button" aria-label="Stop loading" data-tip="Stop" onClick={() => page.stop()}>
            <XIcon />
          </button>
        </Show>
        <input
          ref={input}
          class="browser-address"
          value={typed() ?? page.url() ?? ""}
          placeholder="Search or type an address"
          aria-label="Address"
          spellcheck={false}
          autocomplete="off"
          onFocus={(event) => event.currentTarget.select()}
          onInput={(event) => setTyped(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            // Back to the page's address, and out of the field.
            event.preventDefault();
            event.stopPropagation();
            setTyped(undefined);
            event.currentTarget.value = page.url() ?? "";
            event.currentTarget.blur();
          }}
        />
        <Show when={page.full}>
          <button
            type="button"
            class="icon-button"
            aria-label="DevTools"
            data-tip="DevTools"
            aria-pressed={page.devtools()}
            disabled={page.url() === undefined}
            onClick={() => page.toggleDevtools()}
          >
            <CodeIcon />
          </button>
        </Show>
        <Show when={page.url()}>
          {(href) => (
            <a class="icon-button" href={href()} target="_blank" rel="noreferrer" aria-label="Open in your browser" data-tip="Open in your browser">
              <ExternalIcon />
            </a>
          )}
        </Show>
      </form>
      <div class="browser-progress" classList={{ loading: page.loading() }} />
      <div class="browser-place" ref={place}>
        <Show when={page.failure()}>
          {(failure) => (
            <div class="browser-note">
              <h2>This page could not load</h2>
              <p class="muted">
                <span class="browser-note-url">{failure().url}</span>
                {failure().description}
              </p>
              <button type="button" class="button" onClick={() => page.reload()}>
                Reload
              </button>
            </div>
          )}
        </Show>
        <Show when={page.url() === undefined}>
          <div class="browser-note muted">
            {page.full
              ? "Type an address above, or what to search for: a page shows here in Chromium, its DevTools a click away."
              : "Type an address above: a dev server on this machine shows here, beside the conversation. In the desktop app, any page does, in Chromium."}
          </div>
        </Show>
      </div>
    </div>
  );
}

/**
 * A browser as a view of the thread, so pages sit in its inspection pane beside the conversation: the dev server the
 * agent is building, most often. In the desktop app a page is Chromium's (a `<webview>`), with back and forward, its
 * title for its tab's name, DevTools in their own window (the button, ⌘⌥I, or Inspect on its menu), and links that open
 * a new tab opening one in the pane; while it has focus the app's own shortcuts still work. Elsewhere it is a frame,
 * which only a page that lets itself be framed fills. Each tab keeps its page loaded until the tab closes, and where it
 * was across reloads.
 */
export default defineWebPlugin({
  id: "threads.browser",
  styles,
  config: BrowserConfig,
  requires: { slots: Slots, pane: Pane, webPlugins: WebPlugins },
  setup: ({ slots, pane, webPlugins }, plugin) => {
    const pages = createPages();
    const search = () => plugin.config.search;
    // A page lives as long as its tab.
    createEffect(() => pages.keepOnly(new Set([MAIN, ...pane.tabs().map((tab) => tab.id)])));
    // The tabs there were when it started: any other is one just opened, whose address bar takes focus once.
    const known = new Set(untrack(pane.tabs).map((tab) => tab.id));
    const fresh = (tab: string) => {
      if (known.has(tab)) return false;
      known.add(tab);
      return true;
    };
    slots.add(Views, {
      id: "browser",
      order: 20,
      title: "Browser",
      icon: LaptopIcon,
      letter: "b",
      label: (tab) => {
        // A tab not shown since the app started is named for where its page was.
        const page = pages.get(tab);
        return page === undefined ? hostOf(pages.savedUrl(tab)) : (page.title() ?? hostOf(page.url()));
      },
      component: (props: ThreadViewProps) => <BrowserTab tab={props.tab} pages={pages} search={search} fresh={fresh} />,
    });
    slots.add(Layers, {
      id: "browser.pages",
      // Under every overlay: the pages draw over the pane they show in, and the app's menus and dialogs over them.
      order: 0,
      component: () => <PageLayer pages={pages} listen={(target, type, listener) => plugin.listen(target, type, listener)} />,
    });
    if (bridge === undefined) return;
    const desktop = bridge;
    // While a page has focus its keys are its own, but for the app's that a browser keeps for itself (`inPages`): only
    // those held with a modifier, or a function key, so a binding rebound to a plain key (`n`) still types in the page.
    createEffect(() => {
      const overrides = overridesFrom(webPlugins.list());
      const bindings = slots
        .list(Actions)
        .flatMap((action) => (action.inPages === true ? keysFor(action.id, action.keys, overrides) : []))
        .filter(takenFromPages);
      desktop.forwardKeys([...new Set(bindings)]);
    });
    // A link that opens a new tab opens one in the pane, beside the page's.
    plugin.onCleanup(
      desktop.onOpen((contents, url, background) => {
        const source = pages.byContents(contents);
        if (source === undefined) return;
        // Its page is made, at the link, before the tab draws one of its own.
        batch(() => {
          const owner = pane.tabs().find((tab) => tab.id === source.tab)?.thread;
          const tab = pane.open("browser", { background, ...(owner === undefined ? {} : { thread: owner }) });
          if (tab !== undefined) pages.pageFor(tab, url);
        });
      }),
    );
  },
});
