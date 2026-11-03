import { Show, createEffect, createMemo, createSignal, on, onCleanup, onMount, untrack } from "solid-js";
import type { JSX } from "solid-js";
import { promptMarks, promptText, queuePlaces } from "@lemma/threads";
import type { PromptMark, TurnView } from "@lemma/threads";
import { createStickToBottom } from "@lemma/web/scroll";
import { ChevronDownIcon, Spinner } from "@lemma/look";
import type { Chat } from "./config.ts";
import { FindBar } from "./find-bar.tsx";
import { JUMP_MARGIN, jumpOver, locate as locatePrompts, pendingMark } from "./prompt-rail.ts";
import { PromptRail } from "./rail.tsx";

/** The chat's scroll position, kept with each history entry. */
const SCROLL_STATE = "chat.scroll";
/** How often, at most, the prompt rail measures where the prompts are while the layout changes (ms): each frame while a turn streams. */
const MEASURE_MS = 200;

/** The fragment that names a prompt in its thread's address: what a prompt's link ends with. */
export const promptAnchor = (eventId: string) => `prompt-${eventId}`;

/** Where `element` starts in what `scroller` scrolls, as `scrollTop` counts: a steer is inside its turn. */
const topIn = (scroller: HTMLElement, element: HTMLElement) => element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;

/**
 * Where the reader is among the prompts the chat shows, for the prompt rail: which prompts' turns are in view (a turn
 * runs to the next prompt, the last to the end); the one being read: the last whose turn starts above the top third of
 * the view, or the last one at the bottom; and the nearest turns starting above and below where the view is (or is
 * going), for stepping. Located only while the rail shows, as the view scrolls or its layout changes (`relocate`).
 * `content` holds each prompt's place (`data-mark`) in `scroller`.
 */
function createPromptTracker(chat: Chat, turns: () => readonly TurnView[], scroller: () => HTMLElement, content: () => HTMLElement) {
  // Every prompt a person sent that the chat shows: each turn's, its steers, and the steers sent and not yet placed, at
  // the end. A plugin's notice is none.
  const marks = createMemo((): readonly PromptMark[] => [
    ...promptMarks(turns()),
    ...queuePlaces(chat.threads).joining.flatMap((steer) =>
      steer.source === undefined ? [{ key: pendingMark(steer.requestId), prompt: promptText(steer.content), reply: "" }] : [],
    ),
  ]);
  const shown = () => chat.config.promptRail && marks().length > 1;
  const [current, setCurrent] = createSignal(0);
  const [steps, setSteps] = createSignal<{ previous: number | undefined; next: number | undefined }>(
    { previous: undefined, next: undefined },
    { equals: (a, b) => a.previous === b.previous && a.next === b.next },
  );
  const [seen, setSeen] = createSignal<{ first: number; last: number } | undefined>(undefined, {
    equals: (a, b) => a?.first === b?.first && a?.last === b?.last,
  });
  /** The space beside the transcript's text, where the prompt rail goes. */
  const [room, setRoom] = createSignal(0);
  /** Where a jump is taking the view, until the scroll gets there or the reader takes it elsewhere. */
  let heading: number | undefined;
  /**
   * Where each prompt's place starts (`topIn`), by its key: measured again once the layout has changed (`moved`), at
   * most every `MEASURE_MS`, since measuring reads every place in a transcript that may be long; a scroll moves none.
   */
  let places = new Map<string | undefined, number>();
  let moved = true;
  let measuredAt = -Infinity;
  let measureLater: ReturnType<typeof setTimeout> | undefined;
  const locate = () => {
    if (!shown()) return;
    if (moved && measureLater === undefined) {
      const wait = measuredAt + MEASURE_MS - performance.now();
      if (wait > 0) measureLater = setTimeout(() => ((measureLater = undefined), locateSoon()), wait);
      else {
        places = new Map();
        for (const element of content().querySelectorAll<HTMLElement>("[data-mark]")) places.set(element.dataset.mark, topIn(scroller(), element));
        moved = false;
        measuredAt = performance.now();
      }
    }
    const view = scroller();
    const found = locatePrompts(
      marks().map((mark) => places.get(mark.key)),
      { top: view.scrollTop, height: view.clientHeight, scrollHeight: view.scrollHeight },
      heading,
    );
    setCurrent(found.current);
    setSeen(found.seen);
    setSteps({ previous: found.previous, next: found.next });
  };
  let locating = 0;
  const locateSoon = () => {
    cancelAnimationFrame(locating);
    locating = requestAnimationFrame(locate);
  };
  /** The layout changed: the places are measured again before the next locating, or as soon after the last as allowed. */
  const relocate = () => {
    moved = true;
    locateSoon();
  };
  onMount(() => {
    // The text moves with the view's width and with the content's (the width setting, the narrow layout's padding).
    // From the view's edge, so the scroller's left gutter counts.
    const measure = new ResizeObserver(() =>
      setRoom(content().getBoundingClientRect().left - scroller().getBoundingClientRect().left + parseFloat(getComputedStyle(content()).paddingLeft)),
    );
    measure.observe(scroller());
    measure.observe(content());
    onCleanup(() => measure.disconnect());
  });
  onCleanup(() => {
    cancelAnimationFrame(locating);
    clearTimeout(measureLater);
  });
  // The rail shown again (its setting, a second prompt) is located at once.
  createEffect(on(shown, (now) => now && relocate()));
  return {
    marks,
    shown,
    current,
    steps,
    seen,
    room,
    relocate,
    /** Goes to the prompt whose place is `key` (`data-mark`). */
    jump: (key: string) => {
      const element = content().querySelector<HTMLElement>(`[data-mark="${CSS.escape(key)}"]`);
      if (element === null) return;
      const view = scroller();
      const target = Math.min(Math.max(0, topIn(view, element) - JUMP_MARGIN), view.scrollHeight - view.clientHeight);
      heading = Math.abs(target - view.scrollTop) < 2 ? undefined : target;
      view.scrollTo({ top: target, behavior: "smooth" });
      locate();
    },
    /** The view scrolled from `lastTop`: a jump it went past is over, and the reader is located again. */
    scrolled: (lastTop: number) => {
      if (heading !== undefined && jumpOver(heading, scroller().scrollTop, lastTop)) heading = undefined;
      locateSoon();
    },
    /** The view goes somewhere a jump was not taking it: another thread, a linked prompt. */
    forget: () => {
      heading = undefined;
    },
  };
}

/**
 * The transcript (`children`) as the reader scrolls it: following new output while at the bottom, back where the
 * reader was in each history entry, at the prompt the address links to, with the find bar and the prompt rail.
 * `findWith`: hands the plugin what opens the find bar (focusing it when open) while the view is shown, and undefined
 * once it is not.
 */
export function ChatView(props: { chat: Chat; turns: () => readonly TurnView[]; findWith: (open: (() => void) | undefined) => void; children: JSX.Element }) {
  const threads = props.chat.threads;
  let scroller!: HTMLDivElement;
  let content!: HTMLDivElement;
  // Follows new output while the reader is at the bottom, and leaves them alone once they scroll up.
  const stick = createStickToBottom(() => scroller);
  const stuck = stick.stuck;
  const rail = createPromptTracker(
    props.chat,
    props.turns,
    () => scroller,
    () => content,
  );
  /** Where the reader was in this history entry (back or forward returns there), or undefined at the bottom. */
  const remembered = () => props.chat.router.entry<number | undefined>(SCROLL_STATE);
  /** A position to return to once the transcript is tall enough to hold it. */
  let restoring: number | undefined;
  /** `settled`: the log is loaded and drawn, so a position still out of reach (a taller or wider window) is as near as it gets. */
  const restore = (settled = false) => {
    const reach = scroller.scrollHeight - scroller.clientHeight;
    if (restoring === undefined || (!settled && reach < restoring)) return;
    scroller.scrollTop = Math.min(restoring, reach);
    restoring = undefined;
    stick.placed();
  };
  let saving = 0;
  const onScroll = () => {
    const lastTop = stick.lastTop();
    stick.onScroll();
    rail.scrolled(lastTop);
    if (restoring !== undefined) return;
    cancelAnimationFrame(saving);
    saving = requestAnimationFrame(() => remembered().set(stuck() ? undefined : scroller.scrollTop));
  };

  /** A disclosure the reader just opened or closed: it stays where it was on screen rather than the view jumping to the bottom. */
  let anchor: { readonly element: Element; readonly top: number } | undefined;
  const noteToggle = (event: MouseEvent) => {
    const button = (event.target as Element | null)?.closest?.("button[aria-expanded]");
    if (button === null || button === undefined) return;
    anchor = { element: button, top: button.getBoundingClientRect().top };
    // A toggle that changes no size leaves nothing to hold.
    requestAnimationFrame(() => requestAnimationFrame(() => (anchor = undefined)));
  };

  onMount(() => {
    // Follow new output while the reader is at the bottom; leave them alone once they scroll up.
    const observer = new ResizeObserver(() => {
      const held = anchor;
      anchor = undefined;
      if (held !== undefined && held.element.isConnected) {
        scroller.scrollTop += held.element.getBoundingClientRect().top - held.top;
        stick.placed();
      } else if (restoring !== undefined) restore();
      else stick.keep();
      rail.relocate();
    });
    // Its border box: the end it pads for the composer grows with the composer, and the end stays in view.
    observer.observe(content, { box: "border-box" });
    // Capture: the toggle's own handler changes the DOM before a bubbling listener would see the click.
    content.addEventListener("click", noteToggle, true);
    onCleanup(() => {
      observer.disconnect();
      content.removeEventListener("click", noteToggle, true);
      cancelAnimationFrame(saving);
    });
  });
  createEffect(
    on(threads.activeId, () => {
      rail.forget();
      restoring = untrack(() => remembered().get());
      if (restoring === undefined) stick.follow();
      else {
        stick.release();
        queueMicrotask(() => restore());
      }
    }),
  );
  /** The prompt the address names (`#prompt-<event id>`, a prompt's link), which the view goes to once it shows it. */
  const linked = createMemo(() => {
    const hash = props.chat.router.location().hash;
    return hash.startsWith(`#${promptAnchor("")}`) ? decodeURIComponent(hash.slice(1 + promptAnchor("").length)) : undefined;
  });
  /** Puts the linked prompt at the top of the view, marked for a moment; false while it is not drawn (not loaded, or not on the branch). */
  const goToLinked = (): boolean => {
    const id = linked();
    const element = id === undefined ? null : content.querySelector<HTMLElement>(`[data-prompt="${CSS.escape(id)}"]`);
    if (element === null) return false;
    restoring = undefined;
    rail.forget();
    scroller.scrollTop = Math.min(Math.max(0, topIn(scroller, element) - JUMP_MARGIN), scroller.scrollHeight - scroller.clientHeight);
    stick.placed();
    for (const marked of content.querySelectorAll<HTMLElement>("[data-linked]")) delete marked.dataset.linked;
    // Read the layout between, so the mark starts over on a prompt marked before.
    void element.offsetWidth;
    element.dataset.linked = "";
    return true;
  };
  let settling = 0;
  /**
   * The loaded transcript has been laid out whole once (`data-drawn`): from then on a turn out of view is not drawn
   * (chat.css), and holds the place of the size it was drawn at, so every place in the thread stays where it is.
   */
  const [drawn, setDrawn] = createSignal(false);
  const settled = () => {
    setDrawn(true);
    if (!goToLinked()) restore(true);
  };
  createEffect(() => {
    cancelAnimationFrame(settling);
    if (!threads.log().loaded) return setDrawn(false);
    // Two frames: the loaded transcript is laid out (and the resize observer has had its turn) before the wait ends.
    settling = requestAnimationFrame(() => (settling = requestAnimationFrame(settled)));
  });
  onCleanup(() => cancelAnimationFrame(settling));
  // A link to a prompt of the thread shown, followed here: the address changes, and the thread stays.
  createEffect(on(linked, () => untrack(() => threads.log().loaded) && goToLinked(), { defer: true }));

  const [finding, setFinding] = createSignal(false);
  let findInput: HTMLInputElement | undefined;
  /** What had focus before the find bar took it, given back when it closes. */
  let returnTo: Element | null = null;
  props.findWith(() => {
    if (!finding()) {
      returnTo = document.activeElement;
      setFinding(true);
    }
    findInput?.focus();
    findInput?.select();
  });
  onCleanup(() => props.findWith(undefined));
  const closeFind = () => {
    setFinding(false);
    findInput = undefined;
    if (returnTo instanceof HTMLElement && returnTo.isConnected) returnTo.focus();
    returnTo = null;
  };

  return (
    <div class="chat-view">
      <Show when={finding()}>
        <FindBar content={content} scroller={scroller} input={(element) => (findInput = element)} onClose={closeFind} />
      </Show>
      <div class="scroller" ref={scroller} onScroll={onScroll}>
        <div class="content" ref={content} data-drawn={drawn() ? "" : undefined}>
          <Show when={threads.activeId() !== undefined && !threads.log().loaded}>
            <div class="loading">
              <Spinner /> Loading session…
            </div>
          </Show>
          {props.children}
          <Show when={threads.log().error}>
            <div class="callout callout-error">Could not load the full session: {threads.log().error}</div>
          </Show>
        </div>
        <Show when={!stuck()}>
          <button class="jump" aria-label="Jump to latest" onClick={() => stick.follow(true)}>
            <ChevronDownIcon />
          </button>
        </Show>
      </div>
      <Show when={rail.shown()}>
        <PromptRail
          marks={rail.marks()}
          current={rail.current()}
          previous={rail.steps().previous}
          next={rail.steps().next}
          seen={rail.seen()}
          room={rail.room()}
          onJump={rail.jump}
        />
      </Show>
    </div>
  );
}
