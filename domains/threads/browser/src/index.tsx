import { For, Show, createSignal } from "solid-js";
import { load, save } from "@lemma/web/storage";
import { Views } from "@lemma/threads";
import { Slots, defineWebPlugin } from "@lemma/web";
import { ExternalIcon, LaptopIcon, RefreshIcon } from "@lemma/look";
import styles from "./browser.css?inline";

const ADDRESS_KEY = "lemma.threads.browser.address";

/** An address as typed, with `http://` when it names no scheme (`localhost:3000`). */
export const addressOf = (typed: string): string | undefined => {
  const trimmed = typed.trim();
  if (trimmed === "") return undefined;
  return /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `http://${trimmed}`;
};

function Browser() {
  const [address, setAddress] = createSignal(load(ADDRESS_KEY));
  /** Bumped to load the page again. */
  const [visit, setVisit] = createSignal(0);
  let input!: HTMLInputElement;
  const go = (typed: string) => {
    const next = addressOf(typed);
    setAddress(next);
    save(ADDRESS_KEY, next);
    setVisit(visit() + 1);
    if (next !== undefined) input.value = next;
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
        <input ref={input} class="browser-address" value={address() ?? ""} placeholder="localhost:3000" aria-label="Address" spellcheck={false} />
        <button
          type="button"
          class="icon-button"
          aria-label="Reload page"
          data-tip="Reload"
          disabled={address() === undefined}
          onClick={() => setVisit(visit() + 1)}
        >
          <RefreshIcon />
        </button>
        <Show when={address()}>
          {(href) => (
            <a class="icon-button" href={href()} target="_blank" rel="noreferrer" aria-label="Open in your browser" data-tip="Open in your browser">
              <ExternalIcon />
            </a>
          )}
        </Show>
      </form>
      <Show
        when={address()}
        fallback={<div class="browser-empty">Type an address above: a dev server on this machine shows here, beside the conversation.</div>}
      >
        {(href) => (
          // A fresh frame for each visit, so going to the same address again loads it again.
          <For each={[visit()]}>
            {() => (
              <iframe class="browser-frame" src={href()} title="Browser" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals" />
            )}
          </For>
        )}
      </Show>
    </div>
  );
}

/**
 * A browser as a view of the thread, so a page sits in a pane beside the conversation: the dev server the agent is
 * building, most often. Only a page that lets itself be framed shows (a local dev server does; most sites refuse);
 * the bar opens any in your own browser. It remembers the last address.
 */
export default defineWebPlugin({
  id: "threads.browser",
  styles,
  requires: { slots: Slots },
  setup: ({ slots }) => {
    slots.add(Views, { id: "browser", order: 20, title: "Browser", icon: LaptopIcon, component: Browser });
  },
});
