import { For, Show, createMemo, createSignal } from "solid-js";
import type { ToolBodyProps, ToolView } from "@lemma/threads";
import { HtmlFrame } from "./frame.tsx";
import { pageOf } from "./page.ts";

/** The page itself, where the reader sees it: after the fold holding the call, or under its line. */
function HtmlDisplay(props: ToolBodyProps) {
  // The same page read again (its result passed on anew) keeps its frame: a new one would load it again.
  const page = createMemo(() => (props.result?.isError === true ? undefined : pageOf(props.result?.details)), undefined, {
    equals: (a, b) => a?.html === b?.html && a?.title === b?.title && a?.height === b?.height,
  });
  return (
    <Show when={page()} keyed>
      {(shown) => (
        <figure class="html-render" aria-label={shown.title}>
          <HtmlFrame html={shown.html} title={shown.title} height={shown.height} />
        </figure>
      )}
    </Show>
  );
}

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
export const htmlRenderView: ToolView = {
  icon: "image",
  summary: (args) => (typeof args?.title === "string" && args.title !== "" ? { primary: args.title } : {}),
  streaming: "title",
  action: ["showed", "page", "pages"],
  body: HtmlBody,
  display: HtmlDisplay,
};
