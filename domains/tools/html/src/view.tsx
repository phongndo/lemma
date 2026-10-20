import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type { ToolBodyProps, ToolView } from "@lemma/threads";
import { MaximizeIcon, SidebarIcon } from "@lemma/look";
import { HtmlFrame } from "./frame.tsx";
import { pageOf } from "./page.ts";
import type { RenderedPage } from "./page.ts";
import type { Pages } from "./pages.tsx";

/** Room the buttons take beside a page, their gap to it included. */
const BESIDE = 48;

/** The nearest box around `element` that clips what sticks out sideways (the chat's scroller), or none but the window. */
const clipOf = (element: HTMLElement): HTMLElement | undefined => {
  for (let at = element.parentElement; at !== null; at = at.parentElement) if (getComputedStyle(at).overflowX !== "visible") return at;
  return undefined;
};

/**
 * A page in the chat, as tall as it is up to its cap, with its buttons (full screen, and the thread's pane) shown while
 * the pointer is over it or one has focus, kept in view at the top of the chat while the page runs on below it: beside
 * the page where the chat has room, so they cover none of it, else over its top right. A link to a place in the page
 * scrolls the chat to it.
 */
function DrawnPageFigure(props: { call: string; page: RenderedPage; pages: Pages }) {
  const drawn = { key: props.call, page: props.page };
  let figure!: HTMLElement;
  let mark!: HTMLSpanElement;
  const [beside, setBeside] = createSignal(false);
  onMount(() => {
    onCleanup(props.pages.draw(drawn));
    const clip = clipOf(figure);
    const fit = () => {
      const right = clip === undefined ? innerWidth : clip.getBoundingClientRect().left + clip.clientLeft + clip.clientWidth;
      setBeside(right - figure.getBoundingClientRect().right >= BESIDE);
    };
    // The chat's box resizing (the window, the pane opening) moves the room beside the page.
    const watch = new ResizeObserver(fit);
    watch.observe(figure);
    if (clip !== undefined) watch.observe(clip);
    onCleanup(() => watch.disconnect());
  });
  const reveal = (top: number) => {
    mark.style.top = `${Math.round(top)}px`;
    mark.scrollIntoView({ block: "start", behavior: "smooth" });
  };
  return (
    <figure ref={figure} class="html-render" aria-label={props.page.title}>
      <HtmlFrame
        html={props.page.html}
        title={props.page.title}
        height={props.page.height}
        known={(width) => props.pages.known(props.call, width)}
        onHeight={(width, height) => props.pages.took(props.call, width, height)}
        onReveal={reveal}
      />
      <span ref={mark} class="html-render-mark" aria-hidden="true" />
      <div class="html-render-rail" classList={{ beside: beside() }}>
        <div class="html-render-actions">
          <button type="button" class="icon-button" aria-label="Open full screen" data-tip="Full screen" onClick={() => props.pages.view(drawn)}>
            <MaximizeIcon />
          </button>
          <Show when={props.pages.canOpenInPane()}>
            <button type="button" class="icon-button" aria-label="Open in the pane" data-tip="Open in the pane" onClick={() => props.pages.openInPane(drawn)}>
              <SidebarIcon />
            </button>
          </Show>
        </div>
      </div>
    </figure>
  );
}

/** The page itself, where the reader sees it: after the fold holding the call, or under its line. */
const htmlDisplay = (pages: Pages) =>
  function HtmlDisplay(props: ToolBodyProps) {
    // The same page read again (its result passed on anew) keeps its frame: a new one would load it again.
    const page = createMemo(() => (props.result?.isError === true ? undefined : pageOf(props.result?.details)), undefined, {
      equals: (a, b) => a?.html === b?.html && a?.title === b?.title && a?.height === b?.height,
    });
    return (
      <Show when={page()} keyed>
        {(shown) => <DrawnPageFigure call={props.id} page={shown} pages={pages} />}
      </Show>
    );
  };

/** A call opened, in the chat and the trajectory: what became of it, and the page's source on request. */
function HtmlBody(props: ToolBodyProps) {
  const [source, setSource] = createSignal(false);
  const page = () => pageOf(props.result?.details);
  const html = () => page()?.html ?? (typeof props.args?.html === "string" ? props.args.html : "");
  const error = () =>
    props.result?.isError === true ? props.result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(" ") : undefined;
  return (
    <div class="html-render-body">
      <Show when={error()}>{(text) => <p class="muted small">Not shown: {text()}</p>}</Show>
      <Show when={page()}>
        {(shown) => (
          <Show when={shown().missingImages.length > 0}>
            <p class="muted small">
              Images not inlined:{" "}
              <For each={shown().missingImages}>
                {(path, index) => (
                  <>
                    {index() > 0 ? ", " : ""}
                    <code>{path}</code>
                  </>
                )}
              </For>
            </p>
          </Show>
        )}
      </Show>
      <Show when={html() !== ""}>
        <button type="button" class="link-button small" aria-expanded={source()} onClick={() => setSource((open) => !open)}>
          {source() ? "Hide source" : "Show source"}
        </button>
        <Show when={source()}>
          <pre class="html-render-source">{html()}</pre>
        </Show>
      </Show>
    </div>
  );
}

/** How the chat and the trajectory show an `html_render` call: its title on the line, and the page outside the fold. */
export const htmlRenderView = (pages: Pages): ToolView => ({
  icon: "image",
  summary: (args) => (typeof args?.title === "string" && args.title !== "" ? { primary: args.title } : {}),
  streaming: "title",
  action: ["showed", "page", "pages"],
  body: HtmlBody,
  display: htmlDisplay(pages),
});
