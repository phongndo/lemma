import { Show, createEffect, createSignal, on, onCleanup } from "solid-js";
import { ChevronDownIcon, SearchIcon, XIcon } from "@lemma/look";
import { findMatches, pieceAt, step } from "./find.ts";

/** The highlights' names: every match, and the one gone to (`::highlight(chat-find)` in chat.css). */
const ALL = "chat-find";
const CURRENT = "chat-find-current";

/** The transcript's shown text, joined, with where each text node starts in it. */
function readText(root: HTMLElement) {
  const nodes: Text[] = [];
  const starts: number[] = [];
  let text = "";
  const shown = new Map<Element, boolean>();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode() as Text | null; node !== null; node = walker.nextNode() as Text | null) {
    const parent = node.parentElement;
    if (node.data === "" || parent === null) continue;
    let visible = shown.get(parent);
    if (visible === undefined) shown.set(parent, (visible = parent.checkVisibility()));
    if (!visible) continue;
    nodes.push(node);
    starts.push(text.length);
    text += node.data;
  }
  return { nodes, starts, text };
}

/**
 * Find in the chat, over what it shows: a bar over its top that highlights
 * every place the query occurs and goes from one to the next, keeping up as
 * the transcript changes. What a closed disclosure holds is not shown, so
 * not found.
 */
export function FindBar(props: {
  /** The transcript's content, searched. */
  content: HTMLElement;
  scroller: HTMLElement;
  /** The open bar's input, for the action that opens it to focus. */
  input: (element: HTMLInputElement) => void;
  onClose: () => void;
}) {
  let input!: HTMLInputElement;
  const [query, setQuery] = createSignal("");
  const [ranges, setRanges] = createSignal<readonly Range[]>([]);
  const [current, setCurrent] = createSignal(0);
  const highlights = typeof CSS !== "undefined" && "highlights" in CSS ? CSS.highlights : undefined;

  const search = () => {
    const { nodes, starts, text } = readText(props.content);
    const found = nodes.length === 0 ? [] : findMatches(text, query());
    setRanges(
      found.map((match) => {
        const start = pieceAt(starts, match.start);
        const end = pieceAt(starts, match.end, true);
        const range = document.createRange();
        range.setStart(nodes[start.piece]!, start.offset);
        range.setEnd(nodes[end.piece]!, end.offset);
        return range;
      }),
    );
    setCurrent((at) => Math.min(at, Math.max(0, found.length - 1)));
  };

  /** Brings the current match into view, centred in what the composer leaves visible, unless it is already there. */
  const reveal = () => {
    const range = ranges()[current()];
    if (range === undefined) return;
    const box = range.getBoundingClientRect();
    const view = props.scroller.getBoundingClientRect();
    const covered = parseFloat(getComputedStyle(props.scroller).getPropertyValue("--composer-height")) || 0;
    const visible = view.height - covered;
    const top = box.top - view.top;
    if (top >= 0 && top + box.height <= visible) return;
    props.scroller.scrollTop += top - (visible - box.height) / 2;
  };

  // A new query starts at the first match and goes there.
  createEffect(
    on(query, () => {
      setCurrent(0);
      search();
      reveal();
    }),
  );
  // As the transcript changes (it streams, a disclosure opens, another thread opens), the matches follow, once a frame.
  let pending = 0;
  const observer = new MutationObserver(() => {
    if (pending !== 0) return;
    pending = requestAnimationFrame(() => {
      pending = 0;
      search();
    });
  });
  observer.observe(props.content, { childList: true, subtree: true, characterData: true });
  onCleanup(() => {
    observer.disconnect();
    cancelAnimationFrame(pending);
  });

  createEffect(() => {
    if (highlights === undefined) return;
    const all = ranges();
    const at = all[current()];
    highlights.set(ALL, new Highlight(...all.filter((range) => range !== at)));
    const marked = new Highlight(...(at === undefined ? [] : [at]));
    marked.priority = 1;
    highlights.set(CURRENT, marked);
  });
  onCleanup(() => {
    highlights?.delete(ALL);
    highlights?.delete(CURRENT);
  });

  const go = (by: 1 | -1) => {
    setCurrent((at) => step(at, ranges().length, by));
    reveal();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      go(event.shiftKey ? -1 : 1);
    } else if (event.key === "Escape") {
      // Its own: the keymap leaves a handled key alone (Escape also stops a running turn).
      event.preventDefault();
      props.onClose();
    }
  };

  const count = () => ranges().length;
  return (
    <div class="chat-find" role="search" onKeyDown={onKeyDown}>
      <SearchIcon />
      <input
        ref={(element) => {
          input = element;
          props.input(element);
        }}
        class="chat-find-input"
        type="text"
        placeholder="Find in thread"
        aria-label="Find in thread"
        spellcheck={false}
        autocomplete="off"
        value={query()}
        onInput={(event) => setQuery(event.currentTarget.value)}
      />
      <Show when={query().trim() !== ""}>
        <span class="chat-find-count" aria-live="polite">
          {count() === 0 ? "No results" : `${current() + 1}/${count()}`}
        </span>
      </Show>
      <button class="icon-button chat-find-previous" aria-label="Previous match" data-tip="Previous (⇧↵)" disabled={count() === 0} onClick={() => go(-1)}>
        <ChevronDownIcon />
      </button>
      <button class="icon-button" aria-label="Next match" data-tip="Next (↵)" disabled={count() === 0} onClick={() => go(1)}>
        <ChevronDownIcon />
      </button>
      <button
        class="icon-button"
        aria-label="Close find"
        data-tip="Close (Esc)"
        onClick={() => {
          input.blur();
          props.onClose();
        }}
      >
        <XIcon />
      </button>
    </div>
  );
}
